/**
 * Region directory — the "which region does this tenant live in?" primitive
 * that pairs with `createRouter`. 0.4.0, closes the multi-region gap (5.1)
 * from the PaaS guide.
 *
 * `createRouter` shards WITHIN a region; nothing decided which region a
 * tenant lives in. The directory owns that decision: sticky, deterministic
 * assignment (weighted rendezvous over region ids by default), an optional
 * caller hook for latency-based placement, and explicit overrides for
 * control-plane onboarding decisions. The intended wire-up:
 *
 * ```ts
 * router.route({ tenantId, region: directory.regionFor(tenantId) });
 * ```
 */

import {
	ABS_ATTRS,
	tracerOrNoop,
	type TracerProvider
} from '@absolutejs/telemetry';

export type Region = {
	id: string;
	/**
	 * Relative weight for the default assignment strategy (weighted
	 * rendezvous). Higher weight = proportionally more tenants land here.
	 * Default 1. Weights <= 0 exclude the region from default assignment
	 * (explicit `assignRegion` still works).
	 */
	weight?: number;
};

/**
 * Optional caller-supplied assignment hook, consulted on first-time
 * assignment (e.g. latency-based placement from an edge probe). Returning
 * `undefined` — or an id that is not a registered region — falls back to
 * the default weighted-rendezvous strategy.
 */
export type RegionAssignFn = (tenantId: string) => string | undefined;

export type RegionDirectoryOptions = {
	/** Region set. At least one region is required. */
	regions: Region[];
	/** Optional assignment hook. See {@link RegionAssignFn}. */
	assign?: RegionAssignFn;
	/** Override `Date.now` for tests. */
	clock?: () => number;
	/**
	 * Optional OpenTelemetry tracer provider. When set, first-time
	 * assignments are wrapped in `router.region_assign` spans with
	 * `abs.tenant` + `abs.region` attributes. When omitted, all tracing
	 * is a zero-allocation noop.
	 */
	tracerProvider?: TracerProvider;
};

/**
 * Returned by {@link RegionDirectory.metrics}. Point-in-time view of the
 * assignment table — the operator's "is my region spread what I think it
 * is?" answer.
 *
 * - `assignments` — number of tenants currently assigned.
 * - `byRegion` — current assignment count per region id.
 * - `overrides` — how many current assignments were explicit
 *   `assignRegion` overrides rather than strategy/hook picks.
 */
export type RegionDirectoryMetrics = {
	assignments: number;
	byRegion: Record<string, number>;
	overrides: number;
};

export type RegionDirectorySnapshot = {
	version: 1;
	at: number;
	regions: Region[];
	assignments: Array<{
		tenant: string;
		region: string;
		override: boolean;
	}>;
};

export type RegionDirectory = {
	/**
	 * The sticky assignment for a tenant, created on first call. Once
	 * assigned, every subsequent call returns the same region until
	 * `release()` or `removeRegion()` invalidates it. If the assigned
	 * region has been removed, the tenant is lazily re-assigned here.
	 */
	regionFor: (tenantId: string) => string;
	/**
	 * Explicit override — the control-plane onboarding decision. Throws
	 * on an unknown region id. Overrides survive `snapshot()`/`restore()`
	 * and are counted separately in `metrics().overrides`.
	 */
	assignRegion: (tenantId: string, regionId: string) => void;
	/** Forget a tenant's assignment. Next `regionFor` re-assigns. */
	release: (tenantId: string) => void;
	addRegion: (region: Region) => void;
	/**
	 * Remove a region. Tenants assigned to it are NOT eagerly moved —
	 * they re-assign lazily on their next `regionFor()` call.
	 */
	removeRegion: (regionId: string) => void;
	regions: () => Region[];
	snapshot: () => RegionDirectorySnapshot;
	/**
	 * Repopulate the assignment table from a previously captured
	 * `snapshot()` — assignments must survive control-plane restarts.
	 * Region membership itself comes from the factory options /
	 * `addRegion` (same contract as `Router.restore`, which does not
	 * recreate shard membership).
	 */
	restore: (snapshot: RegionDirectorySnapshot) => void;
	metrics: () => RegionDirectoryMetrics;
};

/** Same FNV-1a 32-bit as `createRouter`'s hash strategies. Not cryptographic. */
const fnv1a32 = (input: string): number => {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
};

type Assignment = {
	region: string;
	override: boolean;
};

export const createRegionDirectory = (
	options: RegionDirectoryOptions
): RegionDirectory => {
	if (options.regions.length === 0) {
		throw new Error('createRegionDirectory requires at least one region');
	}
	const clock = options.clock ?? Date.now;
	const assignHook = options.assign;
	const tracer = tracerOrNoop(options.tracerProvider, '@absolutejs/router');

	const regionList: Region[] = [...options.regions];
	const assignments = new Map<string, Assignment>();

	const hasRegion = (id: string): boolean =>
		regionList.some((region) => region.id === id);

	/**
	 * Weighted rendezvous over region ids — same scheme as the router's
	 * rendezvous shard strategy, minus the load hook. Deterministic and
	 * stable: a tenant's default region depends only on the tenant id +
	 * the region set, so add/remove of a region moves O(weight/total) of
	 * tenants and every replica computes the same answer.
	 */
	const pickRegion = (tenantId: string): string => {
		let bestId = regionList[0]!.id;
		let bestScore = -Infinity;
		for (const region of regionList) {
			const weight = region.weight ?? 1;
			if (weight <= 0) continue;
			const seed = fnv1a32(`${tenantId}|${region.id}`);
			const u = (seed + 1) / 0x1_0000_0000;
			const score = weight * -Math.log(u);
			if (score > bestScore) {
				bestScore = score;
				bestId = region.id;
			}
		}
		return bestId;
	};

	const regionFor: RegionDirectory['regionFor'] = (tenantId) => {
		const found = assignments.get(tenantId);
		// A stale assignment (region since removed) re-assigns lazily.
		if (found && hasRegion(found.region)) return found.region;
		// 0.4.0: span the first-time assignment only — steady-state
		// lookups are pure Map reads and stay span-free.
		const span = tracer.startSpan('router.region_assign', {
			attributes: { [ABS_ATTRS.tenant]: tenantId }
		});
		const hookChoice = assignHook?.(tenantId);
		const region =
			hookChoice !== undefined && hasRegion(hookChoice)
				? hookChoice
				: pickRegion(tenantId);
		assignments.set(tenantId, { override: false, region });
		span.setAttribute('abs.region', region);
		span.setStatus({ code: 1 /* OK */ });
		span.end();
		return region;
	};

	return {
		addRegion: (region) => {
			if (hasRegion(region.id)) return;
			regionList.push(region);
		},
		assignRegion: (tenantId, regionId) => {
			if (!hasRegion(regionId)) {
				throw new Error(`assignRegion: unknown region "${regionId}"`);
			}
			assignments.set(tenantId, { override: true, region: regionId });
		},
		metrics: () => {
			const byRegion: Record<string, number> = {};
			let overrides = 0;
			for (const assignment of assignments.values()) {
				byRegion[assignment.region] =
					(byRegion[assignment.region] ?? 0) + 1;
				if (assignment.override) overrides += 1;
			}
			return { assignments: assignments.size, byRegion, overrides };
		},
		regionFor,
		regions: () => regionList.map((region) => ({ ...region })),
		release: (tenantId) => {
			assignments.delete(tenantId);
		},
		removeRegion: (regionId) => {
			const at = regionList.findIndex((region) => region.id === regionId);
			if (at >= 0) regionList.splice(at, 1);
			// Assignments to the removed region are left in place — they
			// re-assign lazily on the tenant's next regionFor().
		},
		restore: (snap) => {
			assignments.clear();
			for (const a of snap.assignments) {
				assignments.set(a.tenant, {
					override: a.override,
					region: a.region
				});
			}
		},
		snapshot: () => {
			const assignmentsOut: RegionDirectorySnapshot['assignments'] = [];
			for (const [tenant, assignment] of assignments) {
				assignmentsOut.push({
					override: assignment.override,
					region: assignment.region,
					tenant
				});
			}
			return {
				assignments: assignmentsOut,
				at: clock(),
				regions: regionList.map((region) => ({ ...region })),
				version: 1
			};
		}
	};
};
