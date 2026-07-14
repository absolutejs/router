import { describe, expect, test } from 'bun:test';
import { createRouter } from '../src';

const shards = [
	{ id: 's1', url: 'http://shard-1.local', weight: 1 },
	{ id: 's2', url: 'http://shard-2.local', weight: 1 },
	{ id: 's3', url: 'http://shard-3.local', weight: 1 }
];

describe('router.metrics() — 0.2.0', () => {
	test('starts with zeroed counters', () => {
		const router = createRouter({ shards });
		const m = router.metrics();
		expect(m).toEqual({
			acquires: 0,
			lastRouteMs: 0,
			rejectsByDecision: {
				'rate-limited': 0,
				capped: 0,
				denied: 0,
				'no-region-shards': 0,
				'no-shards': 0,
				'no-tenant-shards': 0
			},
			routes: 0,
			shardLoadDistribution: {}
		});
	});

	test('routes counter bumps per route() call', () => {
		const router = createRouter({ shards });
		router.route({ tenantId: 'A' });
		router.route({ tenantId: 'B' });
		router.route({ tenantId: 'A' });
		expect(router.metrics().routes).toBe(3);
	});

	test('shardLoadDistribution counts allowed routes per shard', () => {
		const router = createRouter({ shards });
		for (let i = 0; i < 30; i++) {
			router.route({ tenantId: `tenant-${i}` });
		}
		const m = router.metrics();
		// Jump hash should spread roughly across shards; total should equal route count.
		const total = Object.values(m.shardLoadDistribution).reduce(
			(acc, n) => acc + n,
			0
		);
		expect(total).toBe(30);
	});

	test('rejectsByDecision.denied bumps when allow hook returns false', () => {
		const router = createRouter({
			allow: (tenant) => tenant !== 'banned',
			shards
		});
		router.route({ tenantId: 'banned' });
		router.route({ tenantId: 'fine' });
		const m = router.metrics();
		expect(m.rejectsByDecision.denied).toBe(1);
		expect(m.rejectsByDecision['rate-limited']).toBe(0);
		expect(m.routes).toBe(2);
	});

	test('rejectsByDecision["no-shards"] bumps when all shards unhealthy', () => {
		const router = createRouter({ shards });
		router.markUnhealthy('s1');
		router.markUnhealthy('s2');
		router.markUnhealthy('s3');
		router.route({ tenantId: 'A' });
		expect(router.metrics().rejectsByDecision['no-shards']).toBe(1);
	});

	test('rejectsByDecision.capped bumps when tenant connection cap is hit', () => {
		const router = createRouter({ perTenantConnectionCap: 2, shards });
		router.acquire('A');
		router.acquire('A');
		router.route({ tenantId: 'A' });
		expect(router.metrics().rejectsByDecision.capped).toBe(1);
	});

	test('rejectsByDecision["rate-limited"] bumps when tenant bucket empties', () => {
		const router = createRouter({
			perTenantRateLimit: { refillPerSecond: 0, tokens: 1 },
			shards
		});
		router.route({ tenantId: 'A' });
		router.route({ tenantId: 'A' });
		expect(router.metrics().rejectsByDecision['rate-limited']).toBe(1);
	});

	test('acquires counter bumps per acquire() call', () => {
		const router = createRouter({ shards });
		router.acquire('A');
		router.acquire('B');
		const handle = router.acquire('A');
		handle.release();
		expect(router.metrics().acquires).toBe(3);
	});

	test('lastRouteMs becomes positive after a route', () => {
		const router = createRouter({ shards });
		router.route({ tenantId: 'A' });
		expect(router.metrics().lastRouteMs).toBeGreaterThanOrEqual(0);
	});

	test('counters survive dispose()', () => {
		const router = createRouter({ shards });
		router.route({ tenantId: 'A' });
		router.acquire('A');
		router.dispose();
		const m = router.metrics();
		expect(m.routes).toBe(1);
		expect(m.acquires).toBe(1);
	});
});
