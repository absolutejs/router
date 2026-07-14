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
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const WEBSOCKET_INTERNAL_ERROR = 1011;
const DEFAULT_UPSTREAM_OPEN_TIMEOUT_MS = 10_000;

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

export type BunGatewayOptions = {
	router: Pick<Router, 'acquire' | 'route'>;
	resolve: (
		request: Request
	) => BunGatewayResolution | Promise<BunGatewayResolution>;
	/** Optional final target rewrite after the router chooses a shard. */
	target?: (shard: Shard, request: Request) => string | URL;
	/** Preserve a trusted ingress proxy's X-Forwarded-For chain. Default false. */
	trustForwardedFor?: boolean;
	upstreamOpenTimeoutMs?: number;
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

const forwardedHeaders = (
	request: Request,
	clientAddress?: SocketAddress | null,
	trustForwardedFor = false
) => {
	const incoming = new URL(request.url);
	const headers = new Headers(request.headers);
	deleteHeaders(headers, HOP_BY_HOP_HEADERS);
	headers.delete('host');
	headers.set(
		'x-forwarded-host',
		request.headers.get('host') ?? incoming.host
	);
	headers.set('x-forwarded-proto', incoming.protocol.slice(0, -1));
	if (clientAddress?.address) {
		const prior = trustForwardedFor ? headers.get('x-forwarded-for') : null;
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

const proxyHttp = async (
	request: Request,
	target: URL,
	clientAddress?: SocketAddress | null,
	trustForwardedFor?: boolean
) => {
	const method = request.method.toUpperCase();
	const upstream = await fetch(target, {
		body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
		headers: forwardedHeaders(request, clientAddress, trustForwardedFor),
		method,
		redirect: 'manual',
		signal: request.signal
	});
	const headers = new Headers(upstream.headers);
	deleteHeaders(headers, HOP_BY_HOP_HEADERS);

	return new Response(upstream.body, {
		headers,
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
	clientAddress?: SocketAddress | null,
	trustForwardedFor?: boolean
) => {
	const headers = forwardedHeaders(request, clientAddress, trustForwardedFor);
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

		const target = targetFor(decision.shard, request, options.target);
		const handle = options.router.acquire(routeRequest.tenantId);
		const release = releaseOnce(handle);
		const clientAddress = server.requestIP(request);
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			try {
				return await proxyHttp(
					request,
					target,
					clientAddress,
					options.trustForwardedFor
				);
			} catch (error) {
				options.onError?.(error, request);

				return new Response('Upstream unavailable', {
					status: HTTP_BAD_GATEWAY
				});
			} finally {
				release();
			}
		}

		try {
			const upstream = await connectWebSocket(
				request,
				target,
				options.upstreamOpenTimeoutMs ??
					DEFAULT_UPSTREAM_OPEN_TIMEOUT_MS,
				clientAddress,
				options.trustForwardedFor
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
