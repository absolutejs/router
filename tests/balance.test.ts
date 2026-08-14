import { describe, expect, test } from 'bun:test';
import { createRouter, type Shard } from '../src';

const replicas: Shard[] = [
	{ id: 'r0', tenants: ['acme'], url: 'http://10.0.0.1:3000' },
	{ id: 'r1', tenants: ['acme'], url: 'http://10.0.0.2:3000' },
	{ id: 'r2', tenants: ['acme'], url: 'http://10.0.0.3:3000' }
];

const routeMany = (
	router: ReturnType<typeof createRouter>,
	count: number,
	request: Parameters<ReturnType<typeof createRouter>['route']>[0]
) =>
	Array.from({ length: count }, () => {
		const result = router.route(request);

		return result.shard?.id ?? result.decision;
	});

describe('balance: sticky (default)', () => {
	test('every call for one tenant pins to the same replica', () => {
		const router = createRouter({ shards: replicas });
		const chosen = routeMany(router, 30, { tenantId: 'acme' });
		expect(new Set(chosen).size).toBe(1);
	});

	test('a per-client channelId spreads clients but keeps each one pinned', () => {
		const router = createRouter({ shards: replicas });
		const first = routeMany(router, 5, {
			channelId: 'client-a',
			tenantId: 'acme'
		});
		const second = routeMany(router, 5, {
			channelId: 'client-b',
			tenantId: 'acme'
		});
		expect(new Set(first).size).toBe(1);
		expect(new Set(second).size).toBe(1);
	});
});

describe('balance: round-robin', () => {
	test('cycles through every replica evenly', () => {
		const router = createRouter({ balance: 'round-robin', shards: replicas });
		const chosen = routeMany(router, 9, { tenantId: 'acme' });
		const counts = new Map<string, number>();
		for (const id of chosen) counts.set(id, (counts.get(id) ?? 0) + 1);
		expect(counts.size).toBe(3);
		expect([...counts.values()]).toEqual([3, 3, 3]);
	});

	test('tenants rotate independently', () => {
		const router = createRouter({
			balance: 'round-robin',
			shards: [
				{ id: 'a', url: 'http://a' },
				{ id: 'b', url: 'http://b' }
			]
		});
		const first = router.route({ tenantId: 'one' }).shard?.id;
		const second = router.route({ tenantId: 'two' }).shard?.id;
		expect(first).toBe(second);
	});

	test('skips an unhealthy replica', () => {
		const router = createRouter({ balance: 'round-robin', shards: replicas });
		router.markUnhealthy('r1');
		const chosen = routeMany(router, 12, { tenantId: 'acme' });
		expect(chosen).not.toContain('r1');
		expect(new Set(chosen)).toEqual(new Set(['r0', 'r2']));
	});

	test('per-call balance overrides the router default', () => {
		const router = createRouter({ shards: replicas });
		const sticky = routeMany(router, 6, { tenantId: 'acme' });
		const spread = routeMany(router, 6, {
			balance: 'round-robin',
			tenantId: 'acme'
		});
		expect(new Set(sticky).size).toBe(1);
		expect(new Set(spread).size).toBe(3);
	});
});

describe('balance: least-connections', () => {
	test('routes to the replica holding the fewest active connections', () => {
		const router = createRouter({
			balance: 'least-connections',
			shards: replicas
		});
		router.acquire('acme', 'r0');
		router.acquire('acme', 'r0');
		router.acquire('acme', 'r1');
		expect(router.route({ tenantId: 'acme' }).shard?.id).toBe('r2');
	});

	test('release frees capacity back up', () => {
		const router = createRouter({
			balance: 'least-connections',
			shards: replicas
		});
		router.acquire('acme', 'r1');
		router.acquire('acme', 'r2');
		const handle = router.acquire('acme', 'r0');
		expect(router.route({ tenantId: 'acme' }).shard?.id).not.toBe('r0');
		handle.release();
		expect(router.route({ tenantId: 'acme' }).shard?.id).toBe('r0');
	});

	test('equally loaded replicas still spread instead of pinning to one', () => {
		const router = createRouter({
			balance: 'least-connections',
			shards: replicas
		});
		const chosen = routeMany(router, 9, { tenantId: 'acme' });
		expect(new Set(chosen).size).toBe(3);
	});

	test('an untagged acquire leaves per-shard accounting alone', () => {
		const router = createRouter({
			balance: 'least-connections',
			shards: replicas
		});
		router.acquire('acme');
		expect(router.metrics().shardActiveConnections).toEqual({});
	});
});

describe('per-shard active accounting', () => {
	test('metrics report live counts per shard', () => {
		const router = createRouter({ shards: replicas });
		router.acquire('acme', 'r0');
		const handle = router.acquire('acme', 'r1');
		handle.release();
		expect(router.metrics().shardActiveConnections).toEqual({ r0: 1, r1: 0 });
	});

	test('release is idempotent and never drives a count negative', () => {
		const router = createRouter({ shards: replicas });
		const handle = router.acquire('acme', 'r0');
		handle.release();
		handle.release();
		expect(router.metrics().shardActiveConnections.r0).toBe(0);
	});

	test('removeShard forgets the shard count', () => {
		const router = createRouter({ shards: replicas });
		router.acquire('acme', 'r0');
		router.removeShard('r0');
		expect(router.metrics().shardActiveConnections).toEqual({});
	});

	test('snapshot reports each shard its own active count', () => {
		const router = createRouter({ shards: replicas });
		router.acquire('acme', 'r0');
		router.acquire('acme', 'r0');
		router.acquire('acme', 'r1');
		const byId = new Map(
			router.snapshot().shards.map((shard) => [shard.id, shard.active])
		);
		expect(byId.get('r0')).toBe(2);
		expect(byId.get('r1')).toBe(1);
		expect(byId.get('r2')).toBe(0);
	});

	test('restore rebuilds counts, and resetConnections clears them', () => {
		const source = createRouter({ shards: replicas });
		source.acquire('acme', 'r0');
		const snapshot = source.snapshot();

		const restored = createRouter({ shards: replicas });
		restored.restore(snapshot);
		expect(restored.metrics().shardActiveConnections.r0).toBe(1);

		const reset = createRouter({ shards: replicas });
		reset.restore(snapshot, { resetConnections: true });
		expect(reset.metrics().shardActiveConnections).toEqual({});
	});
});
