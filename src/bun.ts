/**
 * Bun HTTP/WebSocket edge adapter for @absolutejs/router.
 *
 * The core router remains transport-agnostic. This module turns a routing
 * decision into streaming HTTP proxying or a bidirectional WebSocket bridge,
 * and holds the router acquire handle for the real connection lifetime.
 */

import type {
	Server,
	ServerWebSocket,
	SocketAddress,
	WebSocketHandler
} from 'bun';
import type {
	AcquireHandle,
	RouteDecision,
	RouteRequest,
	Router,
	Shard
} from './index';

const HTTP_BAD_GATEWAY = 502;
const HTTP_GATEWAY_TIMEOUT = 504;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const WEBSOCKET_INTERNAL_ERROR = 1011;
const DEFAULT_UPSTREAM_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_ATTEMPTS = 1;
// Safe to repeat: a retry can never apply a change twice.
const DEFAULT_RETRY_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;

const HOP_BY_HOP_HEADERS = [
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
] as const;

const WEBSOCKET_HANDSHAKE_HEADERS = [
	'sec-websocket-extensions',
	'sec-websocket-key',
	'sec-websocket-protocol',
	'sec-websocket-version'
] as const;

export type BunGatewayResolution = RouteRequest | null;

/** How an upstream failed a request: it could not be reached at all, or it
 *  sent no response headers within `upstreamHeadersTimeoutMs`. */
export type UpstreamFailureKind = 'timeout' | 'unreachable';

export type UpstreamFailure = {
	error: unknown;
	kind: UpstreamFailureKind;
	request: Request;
	shard: Shard;
};

export type BunGatewayOptions = {
	router: Pick<Router, 'acquire' | 'route'>;
	resolve: (
		request: Request
	) => BunGatewayResolution | Promise<BunGatewayResolution>;
	/** Optional final target rewrite after the router chooses a shard. */
	target?: (shard: Shard, request: Request) => string | URL;
	/** Preserve a trusted ingress proxy's X-Forwarded-For chain. Default false. */
	trustForwardedFor?: boolean;
	/** Public scheme when TLS terminates before this gateway. Never read from client headers. */
	publicProtocol?: 'http' | 'https';
	/** Send the client's Host to the upstream instead of the shard's address,
	 *  as reverse proxies normally do. Apps behind the gateway then build URLs
	 *  (callbacks, redirects, emailed links) from their public name rather than
	 *  an internal host:port. X-Forwarded-Host is set either way. Default false. */
	preserveHost?: boolean;
	upstreamOpenTimeoutMs?: number;
	/**
	 * Abort an upstream that sends no response headers within this long. It
	 * counts as a failed upstream (`onUpstreamFailure`, kind `'timeout'`) and
	 * answers 504, but the request is never retried, so slow work never runs
	 * twice. Default: no limit. Added in 0.8.0.
	 */
	upstreamHeadersTimeoutMs?: number;
	/**
	 * Send a request whose upstream could not be reached (refused, reset or
	 * unroutable before any response) to another shard. Only methods that are
	 * safe to repeat are retried. Each retry is a fresh `route()` that
	 * excludes the shards already tried, so it is balanced, capped and rate
	 * limited like any request. `false` turns retries off. Default: one retry
	 * for GET, HEAD and OPTIONS. Added in 0.8.0.
	 */
	retry?: false | { attempts?: number; methods?: readonly string[] };
	/**
	 * Called for each upstream that failed a request, before any retry, so the
	 * caller can stop routing to a dead shard at once rather than on its next
	 * health check. Not called when the client went away. Added in 0.8.0.
	 */
	onUpstreamFailure?: (failure: UpstreamFailure) => void;
	onError?: (error: unknown, request: Request) => void;
};

export type BunGatewaySocketData = {
	client?: ServerWebSocket<BunGatewaySocketData>;
	closed?: { code: number; reason: string };
	pending: Array<string | ArrayBuffer>;
	release: () => void;
	upstream: WebSocket;
};

const statusForDecision = (decision: RouteDecision) => {
	switch (decision) {
		case 'capped':
		case 'rate-limited':
			return HTTP_TOO_MANY_REQUESTS;
		case 'denied':
			return HTTP_FORBIDDEN;
		case 'no-region-shards':
		case 'no-shards':
		case 'no-tenant-shards':
			return HTTP_SERVICE_UNAVAILABLE;
		case 'allow':
			return HTTP_INTERNAL_SERVER_ERROR;
	}
};

const rejection = (decision: RouteDecision) =>
	Response.json(
		{ decision, error: 'Routing request rejected' },
		{ status: statusForDecision(decision) }
	);

const deleteHeaders = (headers: Headers, names: readonly string[]) => {
	for (const name of names) headers.delete(name);
};

type Forwarding = Pick<
	BunGatewayOptions,
	'preserveHost' | 'publicProtocol' | 'trustForwardedFor'
>;

const forwardedHeaders = (
	request: Request,
	clientAddress: SocketAddress | null | undefined,
	forwarding: Forwarding
) => {
	const incoming = new URL(request.url);
	const publicHost = request.headers.get('host') ?? incoming.host;
	const headers = new Headers(request.headers);
	deleteHeaders(headers, HOP_BY_HOP_HEADERS);
	if (forwarding.preserveHost) headers.set('host', publicHost);
	else headers.delete('host');
	headers.set('x-forwarded-host', publicHost);
	headers.set(
		'x-forwarded-proto',
		forwarding.publicProtocol ?? incoming.protocol.slice(0, -1)
	);
	if (clientAddress?.address) {
		const prior = forwarding.trustForwardedFor
			? headers.get('x-forwarded-for')
			: null;
		headers.set(
			'x-forwarded-for',
			prior ? `${prior}, ${clientAddress.address}` : clientAddress.address
		);
	}

	return headers;
};

const targetFor = (
	shard: Shard,
	request: Request,
	rewrite?: BunGatewayOptions['target']
) => {
	if (rewrite) return new URL(rewrite(shard, request));
	const incoming = new URL(request.url);
	const target = new URL(shard.url);
	target.pathname = incoming.pathname;
	target.search = incoming.search;
	target.hash = '';

	return target;
};

class UpstreamHeadersTimeoutError extends Error {}

/** The client's abort, plus a deadline for the response headers alone: once
 *  they arrive the body streams for as long as it takes. */
const headersDeadline = (request: Request, timeoutMs?: number) => {
	if (timeoutMs === undefined)
		return {
			clear: () => undefined,
			signal: request.signal,
			timedOut: () => false
		};
	const controller = new AbortController();
	let expired = false;
	const timer = setTimeout(() => {
		expired = true;
		controller.abort();
	}, timeoutMs);
	request.signal.addEventListener('abort', () => controller.abort(), {
		once: true
	});

	return {
		clear: () => clearTimeout(timer),
		signal: controller.signal,
		timedOut: () => expired
	};
};

const proxyHttp = async (
	request: Request,
	target: URL,
	clientAddress: SocketAddress | null | undefined,
	forwarding: Forwarding,
	headersTimeoutMs?: number
) => {
	const method = request.method.toUpperCase();
	const headers = forwardedHeaders(request, clientAddress, forwarding);
	// Bun's fetch asks for compression a client never asked for, and
	// decompresses what comes back while keeping its Content-Encoding: a
	// browser then fails to decode the plain body (every precompressed asset
	// behind the edge, 2026-10-20). The body passes through exactly as the
	// app encoded it, for exactly what the client accepts.
	if (!headers.has('accept-encoding'))
		headers.set('accept-encoding', 'identity');
	const deadline = headersDeadline(request, headersTimeoutMs);
	const upstream = await fetch(target, {
		body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
		decompress: false,
		headers,
		method,
		redirect: 'manual',
		signal: deadline.signal
	})
		.catch((error: unknown) => {
			if (deadline.timedOut())
				throw new UpstreamHeadersTimeoutError(
					`Upstream sent no response headers within ${headersTimeoutMs}ms`
				);
			throw error;
		})
		.finally(deadline.clear);
	const responseHeaders = new Headers(upstream.headers);
	deleteHeaders(responseHeaders, HOP_BY_HOP_HEADERS);

	return new Response(upstream.body, {
		headers: responseHeaders,
		status: upstream.status,
		statusText: upstream.statusText
	});
};

const websocketUrl = (target: URL) => {
	const result = new URL(target);
	if (result.protocol === 'http:') result.protocol = 'ws:';
	if (result.protocol === 'https:') result.protocol = 'wss:';

	return result;
};

const protocolsFrom = (request: Request) =>
	(request.headers.get('sec-websocket-protocol') ?? '')
		.split(',')
		.map((protocol) => protocol.trim())
		.filter(Boolean);

const connectWebSocket = async (
	request: Request,
	target: URL,
	timeoutMs: number,
	clientAddress: SocketAddress | null | undefined,
	forwarding: Forwarding
) => {
	const headers = forwardedHeaders(request, clientAddress, forwarding);
	deleteHeaders(headers, WEBSOCKET_HANDSHAKE_HEADERS);
	const WebSocketClient = WebSocket as unknown as {
		new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket;
	};
	const upstream = new WebSocketClient(websocketUrl(target), {
		headers: Object.fromEntries(headers),
		perMessageDeflate: false,
		protocols: protocolsFrom(request)
	});
	const { promise, reject, resolve } = Promise.withResolvers<WebSocket>();
	const timer = setTimeout(() => {
		upstream.close();
		reject(new Error(`Upstream WebSocket timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	upstream.addEventListener(
		'open',
		() => {
			clearTimeout(timer);
			resolve(upstream);
		},
		{ once: true }
	);
	upstream.addEventListener(
		'error',
		() => {
			clearTimeout(timer);
			reject(new Error('Upstream WebSocket connection failed'));
		},
		{ once: true }
	);

	return promise;
};

const releaseOnce = (handle: AcquireHandle) => {
	let released = false;

	return () => {
		if (released) return;
		released = true;
		handle.release();
	};
};

const sendToClient = (
	data: BunGatewaySocketData,
	message: string | ArrayBuffer
) => {
	if (data.client) {
		data.client.send(message);

		return;
	}
	data.pending.push(message);
};

const forwardUpstreamMessage = (
	data: BunGatewaySocketData,
	message: unknown
) => {
	if (typeof message === 'string' || message instanceof ArrayBuffer) {
		sendToClient(data, message);

		return;
	}
	if (message instanceof Blob) {
		void message.arrayBuffer().then((value) => sendToClient(data, value));

		return;
	}
	if (ArrayBuffer.isView(message)) {
		const value = message.buffer.slice(
			message.byteOffset,
			message.byteOffset + message.byteLength
		);
		sendToClient(data, value as ArrayBuffer);
	}
};

const bindUpstream = (data: BunGatewaySocketData) => {
	data.upstream.addEventListener('message', (event) =>
		forwardUpstreamMessage(data, event.data)
	);
	data.upstream.addEventListener('close', (event) => {
		const code = validCloseCode(event.code);
		data.closed = { code, reason: event.reason };
		data.client?.close(code, event.reason);
		data.release();
	});
	data.upstream.addEventListener('error', () => {
		data.client?.close(
			WEBSOCKET_INTERNAL_ERROR,
			'Upstream WebSocket error'
		);
		data.release();
	});
};

const validCloseCode = (code: number) =>
	code === 1000 || (code >= 3000 && code <= 4999)
		? code
		: WEBSOCKET_INTERNAL_ERROR;

export const createBunGateway = (options: BunGatewayOptions) => {
	const retryMethods = new Set(
		options.retry === false
			? []
			: (options.retry?.methods ?? DEFAULT_RETRY_METHODS).map((method) =>
					method.toUpperCase()
				)
	);
	const retryAttempts =
		options.retry === false
			? 0
			: (options.retry?.attempts ?? DEFAULT_RETRY_ATTEMPTS);

	/* One upstream, then — if it could not be reached and the request is
	 * safe to repeat — the next shard the router picks without it. */
	const serveHttp = async (
		request: Request,
		routeRequest: RouteRequest,
		shard: Shard,
		clientAddress: SocketAddress | null | undefined,
		tried: readonly string[]
	): Promise<Response> => {
		// Tag the acquire with the shard so per-shard active counts stay
		// accurate for the whole request lifetime — that's what
		// 'least-connections' balancing reads.
		const release = releaseOnce(
			options.router.acquire(routeRequest.tenantId, shard.id)
		);
		let failure: unknown;
		try {
			return await proxyHttp(
				request,
				targetFor(shard, request, options.target),
				clientAddress,
				options,
				options.upstreamHeadersTimeoutMs
			);
		} catch (error) {
			failure = error;
		} finally {
			release();
		}
		const kind: UpstreamFailureKind =
			failure instanceof UpstreamHeadersTimeoutError
				? 'timeout'
				: 'unreachable';
		const clientGone = request.signal.aborted;
		if (!clientGone)
			options.onUpstreamFailure?.({
				error: failure,
				kind,
				request,
				shard
			});
		const retryable =
			kind === 'unreachable' &&
			!clientGone &&
			tried.length < retryAttempts &&
			retryMethods.has(request.method.toUpperCase());
		const attempted = [...tried, shard.id];
		const next = retryable
			? options.router.route({
					...routeRequest,
					excludeShards: [
						...(routeRequest.excludeShards ?? []),
						...attempted
					]
				})
			: null;
		if (next?.decision === 'allow' && next.shard !== null)
			return serveHttp(
				request,
				routeRequest,
				next.shard,
				clientAddress,
				attempted
			);
		options.onError?.(failure, request);

		return kind === 'timeout'
			? new Response('Upstream timed out', {
					status: HTTP_GATEWAY_TIMEOUT
				})
			: new Response('Upstream unavailable', {
					status: HTTP_BAD_GATEWAY
				});
	};

	const fetchHandler = async (
		request: Request,
		server: Server<BunGatewaySocketData>
	): Promise<Response | undefined> => {
		const routeRequest = await options.resolve(request);
		if (routeRequest === null)
			return new Response('Unknown tenant', { status: HTTP_NOT_FOUND });
		const decision = options.router.route(routeRequest);
		if (decision.decision !== 'allow' || decision.shard === null)
			return rejection(decision.decision);

		const clientAddress = server.requestIP(request);
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
			return serveHttp(
				request,
				routeRequest,
				decision.shard,
				clientAddress,
				[]
			);

		const target = targetFor(decision.shard, request, options.target);
		// The socket's whole lifetime counts against its shard.
		const release = releaseOnce(
			options.router.acquire(routeRequest.tenantId, decision.shard.id)
		);

		try {
			const upstream = await connectWebSocket(
				request,
				target,
				options.upstreamOpenTimeoutMs ??
					DEFAULT_UPSTREAM_OPEN_TIMEOUT_MS,
				clientAddress,
				options
			);
			const data: BunGatewaySocketData = {
				pending: [],
				release,
				upstream
			};
			bindUpstream(data);
			const upgraded = server.upgrade(request, {
				data,
				headers: upstream.protocol
					? { 'sec-websocket-protocol': upstream.protocol }
					: undefined
			});
			if (upgraded) return undefined;
			upstream.close();
			release();

			return new Response('WebSocket upgrade failed', {
				status: HTTP_INTERNAL_SERVER_ERROR
			});
		} catch (error) {
			release();
			options.onError?.(error, request);

			return new Response('Upstream WebSocket unavailable', {
				status: HTTP_BAD_GATEWAY
			});
		}
	};

	const websocket: WebSocketHandler<BunGatewaySocketData> = {
		close: (socket, code, reason) => {
			if (socket.data.upstream.readyState < WebSocket.CLOSING)
				socket.data.upstream.close(validCloseCode(code), reason);
			socket.data.release();
		},
		data: {} as BunGatewaySocketData,
		message: (socket, message) => socket.data.upstream.send(message),
		open: (socket) => {
			socket.data.client = socket;
			for (const message of socket.data.pending) socket.send(message);
			socket.data.pending.length = 0;
			if (socket.data.closed)
				socket.close(
					socket.data.closed.code,
					socket.data.closed.reason
				);
		}
	};

	return { fetch: fetchHandler, websocket };
};
