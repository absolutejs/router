import { describe, expect, test } from 'bun:test';
import { createBunGateway } from '../src/bun';
import { createRouter } from '../src';

const closeServer = (server: Bun.Server<unknown>) => server.stop(true);

describe('Bun gateway adapter', () => {
	test('streams HTTP to the tenant-affine shard and releases admission', async () => {
		const upstream = Bun.serve({
			fetch: async (request) =>
				Response.json({
					body: await request.text(),
					forwardedFor: request.headers.get('x-forwarded-for'),
					forwardedHost: request.headers.get('x-forwarded-host'),
					forwardedProtocol: request.headers.get('x-forwarded-proto'),
					path: new URL(request.url).pathname
				}),
			port: 0
		});
		const router = createRouter({
			perTenantConnectionCap: 1,
			shards: [
				{
					id: 'alpha',
					tenants: ['alpha'],
					url: `http://127.0.0.1:${upstream.port}`
				}
			]
		});
		const gateway = createBunGateway({
			resolve: (request) => ({
				tenantId: request.headers.get('host')?.split('.')[0] ?? ''
			}),
			router
		});
		const edge = Bun.serve({ ...gateway, port: 0 });

		try {
			const response = await fetch(
				`http://127.0.0.1:${edge.port}/editor`,
				{
					body: 'payload',
					headers: {
						host: 'alpha.dev.localhost',
						'x-forwarded-for': 'spoofed',
						'x-forwarded-proto': 'https'
					},
					method: 'POST'
				}
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				body: string;
				forwardedFor: string;
				forwardedHost: string;
				path: string;
			};
			expect(body).toMatchObject({
				body: 'payload',
				forwardedHost: 'alpha.dev.localhost',
				forwardedProtocol: 'http',
				path: '/editor'
			});
			expect(body.forwardedFor).toEndWith('127.0.0.1');
			expect(body.forwardedFor).not.toContain('spoofed');

			const wrongTenant = await fetch(
				`http://127.0.0.1:${edge.port}/editor`,
				{ headers: { host: 'beta.dev.localhost' } }
			);
			expect(wrongTenant.status).toBe(503);
			expect(await wrongTenant.json()).toMatchObject({
				decision: 'no-tenant-shards'
			});
		} finally {
			await closeServer(edge);
			await closeServer(upstream);
		}
	});

	test('passes a compressed response through without decompressing it', async () => {
		const original = 'console.log("hello");\n'.repeat(200);
		const compressed = Bun.gzipSync(original);
		const seen: (string | null)[] = [];
		const upstream = Bun.serve({
			fetch: (request) => {
				const accepted = request.headers.get('accept-encoding');
				seen.push(accepted);
				return accepted?.includes('gzip')
					? new Response(compressed, {
							headers: {
								'content-encoding': 'gzip',
								'content-type': 'text/javascript'
							}
						})
					: new Response(original, {
							headers: { 'content-type': 'text/javascript' }
						});
			},
			port: 0
		});
		const router = createRouter({
			shards: [
				{
					id: 'alpha',
					tenants: ['alpha'],
					url: `http://127.0.0.1:${upstream.port}`
				}
			]
		});
		const gateway = createBunGateway({
			resolve: () => ({ tenantId: 'alpha' }),
			router
		});
		const edge = Bun.serve({ ...gateway, port: 0 });

		try {
			const encoded = await fetch(
				`http://127.0.0.1:${edge.port}/app.js`,
				{
					decompress: false,
					headers: { 'accept-encoding': 'gzip' }
				}
			);
			expect(encoded.headers.get('content-encoding')).toBe('gzip');
			const bytes = new Uint8Array(await encoded.arrayBuffer());
			expect(bytes).toEqual(new Uint8Array(compressed));
			expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe(
				original
			);

			const plain = await fetch(`http://127.0.0.1:${edge.port}/app.js`, {
				decompress: false,
				headers: { 'accept-encoding': 'identity' }
			});
			expect(plain.headers.get('content-encoding')).toBeNull();
			expect(await plain.text()).toBe(original);
			expect(seen).toEqual(['gzip', 'identity']);
		} finally {
			closeServer(edge);
			closeServer(upstream);
		}
	});

	test('preserves the configured HTTPS public scheme behind an HTTP ingress', async () => {
		const upstream = Bun.serve({
			fetch: async (request) =>
				Response.json({
					body: await request.text(),
					forwardedFor: request.headers.get('x-forwarded-for'),
					forwardedHost: request.headers.get('x-forwarded-host'),
					forwardedProtocol: request.headers.get('x-forwarded-proto'),
					path: new URL(request.url).pathname
				}),
			port: 0
		});
		const router = createRouter({
			perTenantConnectionCap: 1,
			shards: [
				{
					id: 'alpha',
					tenants: ['alpha'],
					url: `http://127.0.0.1:${upstream.port}`
				}
			]
		});
		const gateway = createBunGateway({
			publicProtocol: 'https',
			resolve: (request) => ({
				tenantId: request.headers.get('host')?.split('.')[0] ?? ''
			}),
			router
		});
		const edge = Bun.serve({ ...gateway, port: 0 });

		try {
			const response = await fetch(
				`http://127.0.0.1:${edge.port}/editor`,
				{
					body: 'payload',
					headers: {
						host: 'alpha.dev.localhost',
						'x-forwarded-for': 'spoofed',
						'x-forwarded-proto': 'http'
					},
					method: 'POST'
				}
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				body: string;
				forwardedFor: string;
				forwardedHost: string;
				path: string;
			};
			expect(body).toMatchObject({
				body: 'payload',
				forwardedHost: 'alpha.dev.localhost',
				forwardedProtocol: 'https',
				path: '/editor'
			});
			expect(body.forwardedFor).toEndWith('127.0.0.1');
			expect(body.forwardedFor).not.toContain('spoofed');

			const wrongTenant = await fetch(
				`http://127.0.0.1:${edge.port}/editor`,
				{ headers: { host: 'beta.dev.localhost' } }
			);
			expect(wrongTenant.status).toBe(503);
			expect(await wrongTenant.json()).toMatchObject({
				decision: 'no-tenant-shards'
			});
		} finally {
			await closeServer(edge);
			await closeServer(upstream);
		}
	});

	test('bridges WebSocket frames and holds the connection cap until close', async () => {
		const forwarded: { protocol: string | null } = { protocol: null };
		const upstream = Bun.serve({
			fetch: (request, server) => {
				forwarded.protocol = request.headers.get('x-forwarded-proto');
				return server.upgrade(request)
					? undefined
					: new Response('upgrade failed', { status: 500 });
			},
			port: 0,
			websocket: {
				message: (socket, message) => {
					socket.send(`upstream:${message}`);
				}
			}
		});
		const router = createRouter({
			perTenantConnectionCap: 1,
			shards: [
				{
					id: 'alpha',
					tenants: ['alpha'],
					url: `http://127.0.0.1:${upstream.port}`
				}
			]
		});
		const gateway = createBunGateway({
			publicProtocol: 'https',
			resolve: () => ({ tenantId: 'alpha' }),
			router
		});
		const edge = Bun.serve({ ...gateway, port: 0 });
		const client = new WebSocket(`ws://127.0.0.1:${edge.port}/hmr`);

		try {
			await new Promise<void>((resolve, reject) => {
				client.addEventListener('open', () => resolve(), {
					once: true
				});
				client.addEventListener(
					'error',
					() => reject(new Error('open failed')),
					{
						once: true
					}
				);
			});
			const message = new Promise<string>((resolve) => {
				client.addEventListener(
					'message',
					(event) => resolve(String(event.data)),
					{ once: true }
				);
			});
			expect(forwarded.protocol).toBe('https');
			client.send('hello');
			expect(await message).toBe('upstream:hello');

			const capped = await fetch(
				`http://127.0.0.1:${edge.port}/during-ws`
			);
			expect(capped.status).toBe(429);
			client.close();
			await new Promise<void>((resolve) => {
				client.addEventListener('close', () => resolve(), {
					once: true
				});
			});
			await Bun.sleep(10);
			expect(router.route({ tenantId: 'alpha' }).decision).toBe('allow');
		} finally {
			client.close();
			await closeServer(edge);
			await closeServer(upstream);
		}
	});
	/* Behind the PaaS edge an app saw http://10.50.0.4:46048 as its own URL,
	 * so sign-in return links carried the internal port and were refused as
	 * cross-origin (Management, 2026-10-20). */
	test('preserveHost hands the upstream the public host over HTTP and WebSocket', async () => {
		const seen: string[] = [];
		const upstream = Bun.serve({
			fetch: (request, server) => {
				seen.push(`${request.url} host=${request.headers.get('host')}`);
				if (server.upgrade(request)) return undefined;

				return new Response('ok');
			},
			port: 0,
			websocket: { message: () => {}, open: (socket) => socket.close() }
		});
		const gatewayFor = (preserveHost: boolean) =>
			createBunGateway({
				preserveHost,
				resolve: () => ({ tenantId: 'alpha' }),
				router: createRouter({
					perTenantConnectionCap: 4,
					shards: [
						{
							id: 'alpha',
							tenants: ['alpha'],
							url: `http://127.0.0.1:${upstream.port}`
						}
					]
				})
			});
		const preserving = Bun.serve({ ...gatewayFor(true), port: 0 });
		const rewriting = Bun.serve({ ...gatewayFor(false), port: 0 });

		try {
			await fetch(`http://127.0.0.1:${preserving.port}/callback?x=1`, {
				headers: { host: 'app.example.com' }
			});
			const socket = new (WebSocket as unknown as {
				new (url: string, options?: Bun.WebSocketOptions): WebSocket;
			})(`ws://127.0.0.1:${preserving.port}/live`, {
				headers: { host: 'app.example.com' }
			});
			await new Promise((resolve) => {
				socket.addEventListener('close', resolve, { once: true });
			});
			await fetch(`http://127.0.0.1:${rewriting.port}/callback`, {
				headers: { host: 'app.example.com' }
			});

			expect(seen).toEqual([
				'http://app.example.com/callback?x=1 host=app.example.com',
				'http://app.example.com/live host=app.example.com',
				`http://127.0.0.1:${upstream.port}/callback host=127.0.0.1:${upstream.port}`
			]);
		} finally {
			closeServer(preserving);
			closeServer(rewriting);
			closeServer(upstream);
		}
	});
});
