import { describe, expect, test } from 'bun:test';
import {
	createRegionDirectory,
	createRouter,
	type Region,
	type Shard
} from '../src';

const makeRegions = (ids: string[]): Region[] => ids.map((id) => ({ id }));

describe('createRegionDirectory — 0.4.0', () => {
	test('throws when no regions are supplied', () => {
		expect(() => createRegionDirectory({ regions: [] })).toThrow(
			'at least one region'
		);
	});

	test('regionFor is sticky across repeated calls', () => {
		const directory = createRegionDirectory({
			regions: makeRegions(['us-east', 'eu-west', 'ap-south'])
		});
		const first = directory.regionFor('acme');
		for (let i = 0; i < 100; i++) {
			expect(directory.regionFor('acme')).toBe(first);
		}
	});

	test('assignment is deterministic — two directories with the same regions agree', () => {
		const regions = makeRegions(['us-east', 'eu-west', 'ap-south']);
		const a = createRegionDirectory({ regions });
		const b = createRegionDirectory({ regions });
		for (let i = 0; i < 200; i++) {
			const tenant = `tenant-${i}`;
			expect(a.regionFor(tenant)).toBe(b.regionFor(tenant));
		}
	});

	test('default strategy spreads tenants across all regions', () => {
		const directory = createRegionDirectory({
			regions: makeRegions(['us-east', 'eu-west', 'ap-south'])
		});
		const counts = new Map<string, number>();
		for (let i = 0; i < 1000; i++) {
			const region = directory.regionFor(`tenant-${i}`);
			counts.set(region, (counts.get(region) ?? 0) + 1);
		}
		expect(counts.size).toBe(3);
		// ~333 each ± tolerance for the FNV-seeded distribution.
		for (const value of counts.values()) {
			expect(value).toBeGreaterThan(200);
			expect(value).toBeLessThan(470);
		}
	});

	test('default strategy respects region weights', () => {
		const directory = createRegionDirectory({
			regions: [
				{ id: 'big', weight: 8 },
				{ id: 'small', weight: 1 }
			]
		});
		const counts = { big: 0, small: 0 };
		for (let i = 0; i < 5000; i++) {
			counts[directory.regionFor(`t-${i}`) as 'big' | 'small'] += 1;
		}
		// Expect roughly 8:1 — generous bounds, same variance as the
		// router's rendezvous shard strategy.
		const ratio = counts.big / counts.small;
		expect(ratio).toBeGreaterThan(4);
		expect(ratio).toBeLessThan(16);
	});

	test('assign hook wins; undefined falls back to the default strategy', () => {
		const directory = createRegionDirectory({
			assign: (tenant) => (tenant === 'pinned' ? 'eu-west' : undefined),
			regions: makeRegions(['us-east', 'eu-west'])
		});
		expect(directory.regionFor('pinned')).toBe('eu-west');
		// Non-pinned tenants still get a region (the default strategy).
		const other = directory.regionFor('other');
		expect(['us-east', 'eu-west']).toContain(other);
	});

	test('assign hook returning an unknown region falls back to the default strategy', () => {
		const directory = createRegionDirectory({
			assign: () => 'mars-1',
			regions: makeRegions(['us-east', 'eu-west'])
		});
		expect(['us-east', 'eu-west']).toContain(directory.regionFor('t'));
	});

	test('assignRegion overrides the sticky assignment; throws on unknown region', () => {
		const directory = createRegionDirectory({
			regions: makeRegions(['us-east', 'eu-west'])
		});
		directory.regionFor('acme');
		directory.assignRegion('acme', 'eu-west');
		expect(directory.regionFor('acme')).toBe('eu-west');
		expect(() => directory.assignRegion('acme', 'mars-1')).toThrow(
			'unknown region'
		);
	});

	test('release forgets the assignment; next regionFor re-assigns via strategy', () => {
		const directory = createRegionDirectory({
			regions: makeRegions(['us-east', 'eu-west'])
		});
		const natural = directory.regionFor('acme');
		const overridden = natural === 'us-east' ? 'eu-west' : 'us-east';
		directory.assignRegion('acme', overridden);
		expect(directory.regionFor('acme')).toBe(overridden);
		directory.release('acme');
		// Back to the deterministic strategy pick.
		expect(directory.regionFor('acme')).toBe(natural);
	});

	test('addRegion / removeRegion adjust membership; removal re-assigns lazily', () => {
		const directory = createRegionDirectory({
			regions: makeRegions(['us-east', 'eu-west'])
		});
		directory.addRegion({ id: 'ap-south' });
		// Idempotent on duplicate id.
		directory.addRegion({ id: 'ap-south' });
		expect(directory.regions().map((region) => region.id)).toEqual([
			'us-east',
			'eu-west',
			'ap-south'
		]);

		// Find a tenant assigned to eu-west, then remove that region.
		let pinned: string | undefined;
		for (let i = 0; i < 200; i++) {
			const tenant = `tenant-${i}`;
			if (directory.regionFor(tenant) === 'eu-west') {
				pinned = tenant;
				break;
			}
		}
		expect(pinned).toBeDefined();

		directory.removeRegion('eu-west');
		const reassigned = directory.regionFor(pinned!);
		expect(reassigned).not.toBe('eu-west');
		// And the re-assignment is itself sticky.
		expect(directory.regionFor(pinned!)).toBe(reassigned);
	});

	test('snapshot serializes; restore recreates assignments + override flags', () => {
		const regions = makeRegions(['us-east', 'eu-west']);
		const directory = createRegionDirectory({ regions });
		const natural = directory.regionFor('sticky');
		directory.assignRegion(
			'moved',
			natural === 'us-east' ? 'eu-west' : 'us-east'
		);

		const snap = directory.snapshot();
		const json = JSON.parse(JSON.stringify(snap));

		const next = createRegionDirectory({ regions });
		next.restore(json);
		expect(next.regionFor('sticky')).toBe(natural);
		expect(next.regionFor('moved')).toBe(
			natural === 'us-east' ? 'eu-west' : 'us-east'
		);
		expect(next.metrics().overrides).toBe(1);
	});

	test('metrics reports assignments, byRegion distribution, and overrides', () => {
		const directory = createRegionDirectory({
			regions: makeRegions(['us-east', 'eu-west'])
		});
		expect(directory.metrics()).toEqual({
			assignments: 0,
			byRegion: {},
			overrides: 0
		});
		for (let i = 0; i < 50; i++) directory.regionFor(`tenant-${i}`);
		directory.assignRegion('vip', 'eu-west');
		const m = directory.metrics();
		expect(m.assignments).toBe(51);
		expect(m.overrides).toBe(1);
		const total = Object.values(m.byRegion).reduce((acc, n) => acc + n, 0);
		expect(total).toBe(51);
	});
});

describe('region-aware route() — 0.4.0', () => {
	const regionalShards: Shard[] = [
		{ id: 'us-1', region: 'us-east', url: 'ws://10.0.0.11:3000' },
		{ id: 'us-2', region: 'us-east', url: 'ws://10.0.0.12:3000' },
		{ id: 'eu-1', region: 'eu-west', url: 'ws://10.1.0.11:3000' }
	];

	test('route with a region only picks shards in that region', () => {
		const router = createRouter({ shards: regionalShards });
		for (let i = 0; i < 100; i++) {
			const result = router.route({
				region: 'us-east',
				tenantId: `tenant-${i}`
			});
			expect(result.decision).toBe('allow');
			expect(result.shard!.region).toBe('us-east');
		}
		const eu = router.route({ region: 'eu-west', tenantId: 'acme' });
		expect(eu.shard!.id).toBe('eu-1');
	});

	test('region-less shards remain candidates for any region (back-compat)', () => {
		const router = createRouter({
			shards: [
				{ id: 'legacy', url: 'ws://10.0.0.9:3000' },
				{ id: 'eu-1', region: 'eu-west', url: 'ws://10.1.0.11:3000' }
			]
		});
		const seen = new Set<string>();
		for (let i = 0; i < 100; i++) {
			const result = router.route({
				region: 'eu-west',
				tenantId: `tenant-${i}`
			});
			expect(result.decision).toBe('allow');
			seen.add(result.shard!.id);
		}
		// Both the regional AND the region-less shard receive traffic.
		expect(seen).toEqual(new Set(['legacy', 'eu-1']));
	});

	test('route without a region sees ALL shards (back-compat)', () => {
		const router = createRouter({ shards: regionalShards });
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			const result = router.route({ tenantId: `tenant-${i}` });
			expect(result.decision).toBe('allow');
			seen.add(result.shard!.id);
		}
		expect(seen.size).toBe(3);
	});

	test('no candidate shards in the region → no-region-shards, and metrics count it', () => {
		const router = createRouter({ shards: regionalShards });
		const refused = router.route({
			region: 'ap-south',
			tenantId: 'acme'
		});
		expect(refused.decision).toBe('no-region-shards');
		expect(refused.shard).toBeNull();
		expect(router.metrics().rejectsByDecision['no-region-shards']).toBe(1);
		// The cluster-wide counter is untouched — the two are distinguishable.
		expect(router.metrics().rejectsByDecision['no-shards']).toBe(0);
	});

	test('an unhealthy regional shard rehashes within the region', () => {
		const router = createRouter({ shards: regionalShards });
		// Find a tenant pinned to us-1.
		let pinned: string | undefined;
		for (let i = 0; i < 200; i++) {
			const tenant = `tenant-${i}`;
			const result = router.route({
				region: 'us-east',
				tenantId: tenant
			});
			if (result.shard!.id === 'us-1') {
				pinned = tenant;
				break;
			}
		}
		expect(pinned).toBeDefined();

		router.markUnhealthy('us-1');
		const rerouted = router.route({
			region: 'us-east',
			tenantId: pinned!
		});
		expect(rerouted.decision).toBe('allow');
		expect(rerouted.shard!.id).toBe('us-2');

		// Every regional shard down → no-region-shards (eu-1 is still live).
		router.markUnhealthy('us-2');
		expect(
			router.route({ region: 'us-east', tenantId: pinned! }).decision
		).toBe('no-region-shards');
	});

	test('shard region survives snapshot() JSON round-trip', () => {
		const router = createRouter({ shards: regionalShards });
		const json = JSON.parse(JSON.stringify(router.snapshot()));
		const byId = Object.fromEntries(
			json.shards.map((shard: Shard) => [shard.id, shard])
		);
		expect(byId['us-1'].region).toBe('us-east');
		expect(byId['eu-1'].region).toBe('eu-west');
	});

	test('directory + router wire-up: regionFor feeds route()', () => {
		const directory = createRegionDirectory({
			regions: [{ id: 'us-east' }, { id: 'eu-west' }]
		});
		const router = createRouter({ shards: regionalShards });
		for (let i = 0; i < 50; i++) {
			const tenantId = `tenant-${i}`;
			const result = router.route({
				region: directory.regionFor(tenantId),
				tenantId
			});
			expect(result.decision).toBe('allow');
			expect(result.shard!.region).toBe(directory.regionFor(tenantId));
		}
	});
});
