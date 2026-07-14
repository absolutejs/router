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
						'x-forwarded-for': 'spoofed'
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
		const upstream = Bun.serve({
			fetch: (request, server) =>
				server.upgrade(request)
					? undefined
					: new Response('upgrade failed', { status: 500 }),
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
});
