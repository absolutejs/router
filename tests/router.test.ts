import { describe, expect, test } from 'bun:test';
import { createRouter, type Shard } from '../src';

const clockFrom = (start = 1_000_000) => {
	let now = start;
	return {
		advance: (ms: number) => {
			now += ms;
		},
		now: () => now,
		set: (value: number) => {
			now = value;
		}
	};
};

const makeShards = (n: number): Shard[] =>
	Array.from({ length: n }, (_, i) => ({
		id: `s${i}`,
		url: `ws://10.0.0.${i + 10}:3000`
	}));

describe('createRouter', () => {
	test('tenant-affine shards never receive another tenant', () => {
		const router = createRouter({
			shards: [
				{ id: 'alpha-only', tenants: ['alpha'], url: 'http://alpha' },
				{ id: 'beta-only', tenants: ['beta'], url: 'http://beta' }
			]
		});

		expect(router.route({ tenantId: 'alpha' })).toMatchObject({
			decision: 'allow',
			shard: { id: 'alpha-only' }
		});
		expect(router.route({ tenantId: 'beta' })).toMatchObject({
			decision: 'allow',
			shard: { id: 'beta-only' }
		});
		expect(router.route({ tenantId: 'gamma' })).toEqual({
			decision: 'no-tenant-shards',
			shard: null
		});
	});

	test('shared shards remain eligible alongside tenant-affine shards', () => {
		const router = createRouter({
			shards: [
				{ id: 'alpha-only', tenants: ['alpha'], url: 'http://alpha' },
				{ id: 'shared', url: 'http://shared' }
			]
		});

		expect(router.route({ tenantId: 'gamma' }).shard?.id).toBe('shared');
	});

	test('returns no-shards when nothing is registered', () => {
		const router = createRouter({ shards: [] });
		const result = router.route({ tenantId: 't1' });
		expect(result.decision).toBe('no-shards');
		expect(result.shard).toBeNull();
	});

	test('routes a tenant to a stable shard across repeated calls (stickiness)', () => {
		const router = createRouter({ shards: makeShards(4) });
		const first = router.route({ tenantId: 'acme' });
		expect(first.decision).toBe('allow');
		expect(first.shard).not.toBeNull();
		for (let i = 0; i < 100; i++) {
			const next = router.route({ tenantId: 'acme' });
			expect(next.shard!.id).toBe(first.shard!.id);
		}
	});

	test('distributes many tenants across all shards (jump hash)', () => {
		const router = createRouter({ shards: makeShards(4) });
		const counts = new Map<string, number>();
		for (let i = 0; i < 1000; i++) {
			const result = router.route({ tenantId: `tenant-${i}` });
			counts.set(
				result.shard!.id,
				(counts.get(result.shard!.id) ?? 0) + 1
			);
		}
		expect(counts.size).toBe(4);
		// Tolerance: with N=1000 and 4 shards, each should be ~250 ± 50.
		for (const value of counts.values()) {
			expect(value).toBeGreaterThan(150);
			expect(value).toBeLessThan(350);
		}
	});

	test('adding a shard moves ~1/N tenants and leaves the rest sticky (jump hash)', () => {
		const before = createRouter({ shards: makeShards(3) });
		const assignmentsBefore = new Map<string, string>();
		for (let i = 0; i < 1000; i++) {
			const result = before.route({ tenantId: `tenant-${i}` });
			assignmentsBefore.set(`tenant-${i}`, result.shard!.id);
		}

		const after = createRouter({ shards: makeShards(4) });
		let moved = 0;
		for (let i = 0; i < 1000; i++) {
			const result = after.route({ tenantId: `tenant-${i}` });
			if (result.shard!.id !== assignmentsBefore.get(`tenant-${i}`))
				moved++;
		}
		// Jump hash moves exactly 1/N keys when buckets are added at the tail.
		// Expect ~250 of 1000 — allow 100..400 for the FNV-seeded distribution.
		expect(moved).toBeGreaterThan(100);
		expect(moved).toBeLessThan(400);
	});

	test('channelId shards within a tenant', () => {
		const router = createRouter({ shards: makeShards(4) });
		const assignments = new Set<string>();
		for (let i = 0; i < 50; i++) {
			const result = router.route({
				channelId: `doc-${i}`,
				tenantId: 'acme'
			});
			assignments.add(result.shard!.id);
		}
		// At least 2 shards should have seen traffic for the single tenant.
		expect(assignments.size).toBeGreaterThan(1);
	});

	test('rendezvous strategy respects shard weights', () => {
		const router = createRouter({
			hashStrategy: 'rendezvous',
			shards: [
				{ id: 'big', url: 'ws://10.0.0.1', weight: 8 },
				{ id: 'small', url: 'ws://10.0.0.2', weight: 1 }
			]
		});
		const counts = { big: 0, small: 0 };
		for (let i = 0; i < 5000; i++) {
			const result = router.route({ tenantId: `t-${i}` });
			counts[result.shard!.id as 'big' | 'small'] += 1;
		}
		// Expect roughly 8:1 split — be generous on the bounds (HRW + 32-bit
		// seed has visible variance at this N).
		const ratio = counts.big / counts.small;
		expect(ratio).toBeGreaterThan(4);
		expect(ratio).toBeLessThan(16);
	});

	test('custom hash strategy is invoked with the resolved key', () => {
		const seen: string[] = [];
		const router = createRouter({
			hashStrategy: (key, shards) => {
				seen.push(key);
				return shards.length - 1;
			},
			shards: makeShards(3)
		});
		const result = router.route({ channelId: 'room-7', tenantId: 'acme' });
		expect(seen).toEqual(['acme:room-7']);
		expect(result.shard!.id).toBe('s2');
	});

	test('unhealthy shards are skipped; tenants on them rehash to healthy ones', () => {
		const router = createRouter({ shards: makeShards(4) });
		// Find a tenant that pins to s2 under jump hash.
		let pinnedTenant: string | undefined;
		for (let i = 0; i < 200; i++) {
			const tenant = `tenant-${i}`;
			const result = router.route({ tenantId: tenant });
			if (result.shard!.id === 's2') {
				pinnedTenant = tenant;
				break;
			}
		}
		expect(pinnedTenant).toBeDefined();

		router.markUnhealthy('s2');
		const rerouted = router.route({ tenantId: pinnedTenant! });
		expect(rerouted.decision).toBe('allow');
		expect(rerouted.shard!.id).not.toBe('s2');

		router.markHealthy('s2');
		const restored = router.route({ tenantId: pinnedTenant! });
		expect(restored.shard!.id).toBe('s2');
	});

	test('returns no-shards when every shard is unhealthy', () => {
		const router = createRouter({ shards: makeShards(2) });
		router.markUnhealthy('s0');
		router.markUnhealthy('s1');
		expect(router.route({ tenantId: 't' }).decision).toBe('no-shards');
	});

	test('per-tenant connection cap returns "capped" once exceeded', () => {
		const router = createRouter({
			perTenantConnectionCap: 2,
			shards: makeShards(2)
		});
		const handle1 = router.acquire('acme');
		const handle2 = router.acquire('acme');
		expect(handle1.active).toBe(1);
		expect(handle2.active).toBe(2);

		expect(router.route({ tenantId: 'acme' }).decision).toBe('capped');
		// A different tenant is unaffected.
		expect(router.route({ tenantId: 'other' }).decision).toBe('allow');

		handle1.release();
		expect(router.route({ tenantId: 'acme' }).decision).toBe('allow');
	});

	test('release is idempotent', () => {
		const router = createRouter({
			perTenantConnectionCap: 1,
			shards: makeShards(1)
		});
		const handle = router.acquire('acme');
		handle.release();
		handle.release();
		// Should not underflow; a fresh acquire should still work.
		const fresh = router.acquire('acme');
		expect(fresh.active).toBe(1);
	});

	test('token-bucket rate limit refuses past N requests/window then refills', () => {
		const clock = clockFrom();
		const router = createRouter({
			clock: clock.now,
			perTenantRateLimit: { refillPerSecond: 1, tokens: 3 },
			shards: makeShards(1)
		});

		expect(router.route({ tenantId: 'acme' }).decision).toBe('allow');
		expect(router.route({ tenantId: 'acme' }).decision).toBe('allow');
		expect(router.route({ tenantId: 'acme' }).decision).toBe('allow');
		expect(router.route({ tenantId: 'acme' }).decision).toBe(
			'rate-limited'
		);

		// 1 second elapses → 1 token refilled.
		clock.advance(1000);
		expect(router.route({ tenantId: 'acme' }).decision).toBe('allow');
		expect(router.route({ tenantId: 'acme' }).decision).toBe(
			'rate-limited'
		);
	});

	test('rate-limit bucket never overflows past capacity', () => {
		const clock = clockFrom();
		const router = createRouter({
			clock: clock.now,
			perTenantRateLimit: { refillPerSecond: 1, tokens: 3 },
			shards: makeShards(1)
		});
		// 10 seconds idle — bucket should clamp at 3, not 13.
		clock.advance(10_000);
		expect(router.route({ tenantId: 'acme' }).decision).toBe('allow');
		expect(router.route({ tenantId: 'acme' }).decision).toBe('allow');
		expect(router.route({ tenantId: 'acme' }).decision).toBe('allow');
		expect(router.route({ tenantId: 'acme' }).decision).toBe(
			'rate-limited'
		);
	});

	test('addShard / removeShard adjust membership at runtime', () => {
		const router = createRouter({ shards: makeShards(2) });
		expect(router.shards().map((shard) => shard.id)).toEqual(['s0', 's1']);

		router.addShard({ id: 's2', url: 'ws://10.0.0.99' });
		expect(router.shards().map((shard) => shard.id)).toEqual([
			's0',
			's1',
			's2'
		]);

		// Idempotent on duplicate id.
		router.addShard({ id: 's2', url: 'ws://10.0.0.99' });
		expect(router.shards()).toHaveLength(3);

		router.removeShard('s1');
		expect(router.shards().map((shard) => shard.id)).toEqual(['s0', 's2']);

		// Removed shard is no longer chosen.
		for (let i = 0; i < 100; i++) {
			const result = router.route({ tenantId: `t-${i}` });
			expect(result.shard!.id).not.toBe('s1');
		}
	});

	test('snapshot reports shard health + per-tenant state', () => {
		const router = createRouter({ shards: makeShards(2) });
		router.acquire('a');
		router.acquire('b');
		router.markUnhealthy('s1');
		const snap = router.snapshot();
		expect(snap.tenants).toHaveLength(2);
		const byId = Object.fromEntries(
			snap.shards.map((shard) => [shard.id, shard])
		);
		expect(byId.s0!.healthy).toBe(true);
		expect(byId.s1!.healthy).toBe(false);
	});

	test('dispose makes every subsequent route return no-shards', () => {
		const router = createRouter({ shards: makeShards(2) });
		router.dispose();
		expect(router.route({ tenantId: 't' }).decision).toBe('no-shards');
		expect(router.shards()).toEqual([]);
	});

	// ───────── 0.1.0 surface ──────────────────────────────────────────────

	test('drainShard excludes the shard from routing without marking it unhealthy', () => {
		const router = createRouter({ shards: makeShards(3) });
		// Find a tenant that pins to s1.
		let pinned: string | undefined;
		for (let i = 0; i < 200; i++) {
			const tenant = `tenant-${i}`;
			const result = router.route({ tenantId: tenant });
			if (result.shard!.id === 's1') {
				pinned = tenant;
				break;
			}
		}
		expect(pinned).toBeDefined();

		router.drainShard('s1');
		expect(router.isDraining('s1')).toBe(true);
		expect(router.isHealthy('s1')).toBe(true);

		const after = router.route({ tenantId: pinned! });
		expect(after.shard!.id).not.toBe('s1');

		router.markHealthy('s1');
		expect(router.isDraining('s1')).toBe(false);
		const restored = router.route({ tenantId: pinned! });
		expect(restored.shard!.id).toBe('s1');
	});

	test('load hook biases rendezvous toward less-loaded shards', () => {
		// Shard B reports 10x the load of A; A should win ~10/11 of the time.
		const router = createRouter({
			hashStrategy: 'rendezvous',
			load: (id) => (id === 'B' ? 10 : 1),
			shards: [
				{ id: 'A', url: 'ws://a' },
				{ id: 'B', url: 'ws://b' }
			]
		});
		const counts = { A: 0, B: 0 };
		for (let i = 0; i < 2000; i++) {
			const result = router.route({ tenantId: `t-${i}` });
			counts[result.shard!.id as 'A' | 'B'] += 1;
		}
		// Expect A to clearly dominate. Be generous on bounds; rendezvous + 32-bit seed has variance.
		expect(counts.A).toBeGreaterThan(counts.B * 5);
	});

	test('per-route rate limit gates independently of the tenant bucket', () => {
		const clock = clockFrom();
		const router = createRouter({
			clock: clock.now,
			perRouteRateLimits: {
				expensive: { refillPerSecond: 1, tokens: 2 }
			},
			perTenantRateLimit: { refillPerSecond: 10, tokens: 100 },
			shards: makeShards(1)
		});
		const route = 'expensive';
		expect(router.route({ route, tenantId: 'acme' }).decision).toBe(
			'allow'
		);
		expect(router.route({ route, tenantId: 'acme' }).decision).toBe(
			'allow'
		);
		const refused = router.route({ route, tenantId: 'acme' });
		expect(refused.decision).toBe('rate-limited');
		expect(refused.emptiedBucket).toBe('expensive');
		// Other routes for the same tenant still work — the tenant bucket has 98 tokens left.
		expect(router.route({ tenantId: 'acme' }).decision).toBe('allow');
	});

	test('rate-limited result reports tenant bucket when that one drains first', () => {
		const router = createRouter({
			perTenantRateLimit: { refillPerSecond: 0, tokens: 1 },
			shards: makeShards(1)
		});
		expect(router.route({ tenantId: 't' }).decision).toBe('allow');
		const refused = router.route({ tenantId: 't' });
		expect(refused.decision).toBe('rate-limited');
		expect(refused.emptiedBucket).toBe('tenant');
	});

	test('allow hook gate refuses a tenant the meter has tripped', () => {
		const tripped = new Set<string>();
		const router = createRouter({
			allow: (tenant) => !tripped.has(tenant),
			shards: makeShards(1)
		});
		expect(router.route({ tenantId: 'acme' }).decision).toBe('allow');
		tripped.add('acme');
		const refused = router.route({ tenantId: 'acme' });
		expect(refused.decision).toBe('denied');
		expect(refused.shard).toBeNull();
		// Other tenants are unaffected.
		expect(router.route({ tenantId: 'other' }).decision).toBe('allow');
	});

	test('failed bucket gates do not consume the OTHER bucket', () => {
		const router = createRouter({
			perRouteRateLimits: {
				maxed: { refillPerSecond: 0, tokens: 0 }
			},
			perTenantRateLimit: { refillPerSecond: 0, tokens: 100 },
			shards: makeShards(1)
		});
		const refused = router.route({ route: 'maxed', tenantId: 't' });
		expect(refused.decision).toBe('rate-limited');
		expect(refused.emptiedBucket).toBe('maxed');
		// Tenant bucket should still have 100 — the route failed before we committed.
		for (let i = 0; i < 100; i++) {
			expect(router.route({ tenantId: 't' }).decision).toBe('allow');
		}
	});

	test('snapshot serializes; restore recreates rate-limit state', () => {
		let now = 1_000_000;
		const router = createRouter({
			clock: () => now,
			perRouteRateLimits: { hot: { refillPerSecond: 0, tokens: 5 } },
			perTenantRateLimit: { refillPerSecond: 0, tokens: 10 },
			shards: makeShards(2)
		});
		// Drain some tokens.
		router.route({ tenantId: 'acme' });
		router.route({ tenantId: 'acme' });
		router.route({ route: 'hot', tenantId: 'acme' });
		router.drainShard('s1');

		const snap = router.snapshot();
		const json = JSON.parse(JSON.stringify(snap));

		const next = createRouter({
			clock: () => now,
			perRouteRateLimits: { hot: { refillPerSecond: 0, tokens: 5 } },
			perTenantRateLimit: { refillPerSecond: 0, tokens: 10 },
			shards: makeShards(2)
		});
		next.restore(json);

		// Drain state survived.
		expect(next.isDraining('s1')).toBe(true);

		// Tenant token state survived (we had 10, used 3 — leaving 7).
		// 7 more allow calls succeed; the 8th is rate-limited.
		for (let i = 0; i < 7; i++) {
			expect(next.route({ tenantId: 'acme' }).decision).toBe('allow');
		}
		expect(next.route({ tenantId: 'acme' }).decision).toBe('rate-limited');
	});

	test('snapshot tenants/routeBuckets are the persistable shape (arrays)', () => {
		const router = createRouter({
			perTenantRateLimit: { refillPerSecond: 0, tokens: 5 },
			shards: makeShards(1)
		});
		router.route({ tenantId: 'a' });
		router.route({ tenantId: 'b' });
		const snap = router.snapshot();
		expect(Array.isArray(snap.tenants)).toBe(true);
		expect(Array.isArray(snap.routeBuckets)).toBe(true);
		expect(snap.tenants).toHaveLength(2);
	});

	test('restore can reset connection counts after a gateway restart', () => {
		const router = createRouter({
			perTenantConnectionCap: 1,
			shards: makeShards(1)
		});
		router.acquire('acme');
		const snapshot = router.snapshot();
		const restored = createRouter({
			perTenantConnectionCap: 1,
			shards: makeShards(1)
		});

		restored.restore(snapshot, { resetConnections: true });

		expect(restored.route({ tenantId: 'acme' }).decision).toBe('allow');
	});
});
