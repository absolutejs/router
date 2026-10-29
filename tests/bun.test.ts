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

	/* A port nothing listens on: connecting is refused, the way a host whose
	 * workload died answers. */
	const deadUrl = async () => {
		const server = Bun.serve({
			fetch: () => new Response('gone'),
			port: 0
		});
		const url = `http://127.0.0.1:${server.port}`;
		await closeServer(server);

		return url;
	};

	const twoShards = (deadShard: string, liveShard: string) => ({
		balance: 'round-robin' as const,
		shards: [
			{ id: 'dead', url: deadShard },
			{ id: 'live', url: liveShard }
		]
	});

	test('a request whose upstream cannot be reached is answered by another shard', async () => {
		const upstream = Bun.serve({
			fetch: () => new Response('served'),
			port: 0
		});
		const router = createRouter(
			twoShards(await deadUrl(), `http://127.0.0.1:${upstream.port}`)
		);
		const failures: Array<{ kind: string; shard: string }> = [];
		const gateway = createBunGateway({
			onUpstreamFailure: ({ kind, shard }) =>
				failures.push({ kind, shard: shard.id }),
			resolve: () => ({ tenantId: 'alpha' }),
			router
		});
		const edge = Bun.serve({ ...gateway, port: 0 });

		try {
			const statuses = await Promise.all(
				Array.from({ length: 4 }, async () => {
					const response = await fetch(
						`http://127.0.0.1:${edge.port}/`
					);
					await response.text();

					return response.status;
				})
			);
			expect(statuses).toEqual([200, 200, 200, 200]);
			expect(failures.length).toBeGreaterThan(0);
			expect(
				failures.every(
					({ kind, shard }) =>
						kind === 'unreachable' && shard === 'dead'
				)
			).toBeTrue();
		} finally {
			await closeServer(edge);
			await closeServer(upstream);
		}
	});

	test('a request that is not safe to repeat is never sent twice', async () => {
		const router = createRouter({
			shards: [{ id: 'dead', url: await deadUrl() }]
		});
		const gateway = createBunGateway({
			resolve: () => ({ tenantId: 'alpha' }),
			router
		});
		const edge = Bun.serve({ ...gateway, port: 0 });
		let posted = 0;
		const upstream = Bun.serve({
			fetch: () => {
				posted += 1;

				return new Response('applied');
			},
			port: 0
		});
		router.addShard({
			id: 'live',
			url: `http://127.0.0.1:${upstream.port}`
		});

		try {
			const outcomes = await Promise.all(
				Array.from({ length: 4 }, async () => {
					const response = await fetch(
						`http://127.0.0.1:${edge.port}/orders`,
						{ body: 'one order', method: 'POST' }
					);
					await response.text();

					return response.status;
				})
			);
			// Each POST went to exactly one shard: a dead one fails it.
			expect(
				posted + outcomes.filter((status) => status === 502).length
			).toBe(4);
			expect(
				outcomes.every((status) => status === 200 || status === 502)
			).toBeTrue();
		} finally {
			await closeServer(edge);
			await closeServer(upstream);
		}
	});

	test('a slow upstream answers 504 and is not retried', async () => {
		let asked = 0;
		const slow = Bun.serve({
			fetch: async () => {
				asked += 1;
				await Bun.sleep(500);

				return new Response('late');
			},
			port: 0
		});
		const router = createRouter({
			shards: [
				{ id: 'slow-a', url: `http://127.0.0.1:${slow.port}` },
				{ id: 'slow-b', url: `http://127.0.0.1:${slow.port}` }
			]
		});
		const failures: string[] = [];
		const gateway = createBunGateway({
			onUpstreamFailure: ({ kind }) => failures.push(kind),
			resolve: () => ({ tenantId: 'alpha' }),
			router,
			upstreamHeadersTimeoutMs: 50
		});
		const edge = Bun.serve({ ...gateway, port: 0 });

		try {
			const response = await fetch(`http://127.0.0.1:${edge.port}/`);
			expect(response.status).toBe(504);
			expect(asked).toBe(1);
			expect(failures).toEqual(['timeout']);
		} finally {
			await closeServer(edge);
			await closeServer(slow);
		}
	});

	test('a response slower than the headers deadline to stream still streams', async () => {
		const upstream = Bun.serve({
			fetch: () =>
				new Response(
					new ReadableStream({
						start: async (controller) => {
							controller.enqueue(new TextEncoder().encode('a'));
							await Bun.sleep(150);
							controller.enqueue(new TextEncoder().encode('b'));
							controller.close();
						}
					})
				),
			port: 0
		});
		const router = createRouter({
			shards: [{ id: 'live', url: `http://127.0.0.1:${upstream.port}` }]
		});
		const gateway = createBunGateway({
			resolve: () => ({ tenantId: 'alpha' }),
			router,
			upstreamHeadersTimeoutMs: 50
		});
		const edge = Bun.serve({ ...gateway, port: 0 });

		try {
			const response = await fetch(`http://127.0.0.1:${edge.port}/`);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('ab');
		} finally {
			await closeServer(edge);
			await closeServer(upstream);
		}
	});

	test('retries can be turned off', async () => {
		const upstream = Bun.serve({
			fetch: () => new Response('served'),
			port: 0
		});
		const router = createRouter(
			twoShards(await deadUrl(), `http://127.0.0.1:${upstream.port}`)
		);
		const gateway = createBunGateway({
			resolve: () => ({ tenantId: 'alpha' }),
			retry: false,
			router
		});
		const edge = Bun.serve({ ...gateway, port: 0 });

		try {
			const statuses = await Promise.all(
				Array.from({ length: 4 }, async () => {
					const response = await fetch(
						`http://127.0.0.1:${edge.port}/`
					);
					await response.text();

					return response.status;
				})
			);
			expect(statuses).toContain(502);
		} finally {
			await closeServer(edge);
			await closeServer(upstream);
		}
	});
});
