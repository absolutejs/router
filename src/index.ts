/**
 * @absolutejs/router — multi-tenant connection routing primitive for Bun PaaS
 * gateways.
 *
 * Sits between an incoming request / WS upgrade and N backend processes (each
 * one a `@absolutejs/runtime` instance hosting a `@absolutejs/sync` engine
 * for a subset of tenants). Decides which shard owns the tenant, whether the
 * tenant is over its rate limit (tenant-wide + per-route), whether the tenant
 * is over its connection cap, whether the caller-supplied allow hook approves,
 * and whether the chosen shard is healthy and not draining.
 *
 * v0.1.0 is bun/elysia-agnostic — pure logic, no `Bun.serve` or proxy code.
 * The caller wires the routing decision into whichever HTTP/WS layer they
 * have. An Elysia adapter ships in a later 0.0.x as a subpath.
 */

export type Shard = {
	id: string;
	/**
	 * Connection target for the chosen backend. Format is opaque to the router
	 * — `ws://host:port`, `https://host`, a unix socket path, whatever the
	 * caller's proxy layer understands.
	 */
	url: string;
	/**
	 * Relative weight for hash strategies that support it (rendezvous). Jump
	 * hash ignores weights — every shard is treated as weight 1. Default 1.
	 */
	weight?: number;
};

/**
 * Pure hash-strategy function. Given the routing key + the list of currently
 * eligible shards (healthy AND not draining), return the index in `shards` of
 * the chosen shard. The router never calls a strategy with an empty `shards`
 * array — that case is handled upstream as `no-shards`.
 */
export type HashStrategyFn = (key: string, shards: ReadonlyArray<Shard>) => number;

export type HashStrategy = 'jump' | 'rendezvous' | HashStrategyFn;

/**
 * Per-tenant token-bucket rate limit. `tokens` is the bucket capacity AND the
 * starting balance; `refillPerSecond` is added continuously up to capacity.
 * Defaults: `Infinity` tokens / `0` refill = no limit.
 */
export type RateLimit = {
	tokens: number;
	refillPerSecond: number;
};

/**
 * Optional caller-supplied gate. Called per-route with the tenant id; returning
 * `false` causes the route to return `decision: 'denied'`. The intended
 * use is `meter.allow` from `@absolutejs/metering` — pass it directly to refuse
 * routes for over-quota tenants without wiring the integration manually.
 */
export type AllowHook = (tenantId: string) => boolean;

/**
 * Optional caller-supplied load metric. Called per `route()` with a shard id;
 * returning a value > 1 makes the rendezvous strategy bias AWAY from this shard
 * (effective weight = `shard.weight / load`). Used to avoid hot-spotting when
 * a stickiness-locked shard is overloaded — the router can't move existing
 * tenants, but it can avoid sending NEW tenants there.
 *
 * Jump-hash ignores this — it has no per-call weight bias by design.
 */
export type ShardLoadFn = (shardId: string) => number;

export type RouterOptions = {
	/** Initial shard set. Can be empty (every `route()` returns `no-shards`). */
	shards: Shard[];
	/** Hash strategy. Default `'jump'`. */
	hashStrategy?: HashStrategy;
	/**
	 * Max concurrent connections per tenant (counted via `acquire()` /
	 * `release()`). Default `Infinity` (no cap). When reached, `route()`
	 * returns `'capped'`.
	 */
	perTenantConnectionCap?: number;
	/**
	 * Per-tenant token bucket. Default `{ tokens: Infinity, refillPerSecond: 0 }`
	 * (no limit). When the tenant's bucket is empty, `route()` returns
	 * `'rate-limited'`. One `route()` call costs one token.
	 */
	perTenantRateLimit?: RateLimit;
	/**
	 * Per-route token buckets layered on top of the tenant-wide bucket.
	 * Keyed by route name; supplied by the caller via
	 * `route({ route: 'someRoute' })`. The tenant bucket AND the route bucket
	 * must both have a token available. When the route bucket is empty,
	 * `route()` returns `'rate-limited'` with `routeId` set.
	 */
	perRouteRateLimits?: Record<string, RateLimit>;
	/** Optional load hook biasing the rendezvous strategy. */
	load?: ShardLoadFn;
	/** Optional caller-supplied allow gate. */
	allow?: AllowHook;
	/** Override `Date.now` for tests. */
	clock?: () => number;
};

export type RouteDecision =
	| 'allow'
	| 'rate-limited'
	| 'capped'
	| 'no-shards'
	| 'denied';

/**
 * Returned by {@link Router.metrics}. Combines point-in-time state with
 * cumulative counters since `createRouter()`. Survives `dispose()` so
 * post-shutdown introspection still reads totals. Added in 0.2.0.
 *
 * - `routes` — total `route()` calls (any decision).
 * - `acquires` — total `acquire()` calls.
 * - `rejectsByDecision` — counts per non-allow `RouteDecision`. The
 *   operator's "where am I shedding load?" answer.
 * - `shardLoadDistribution` — cumulative routes assigned per shard
 *   since `createRouter()`. With `markHealthy`/`drainShard` this is
 *   the "is rebalancing actually rebalancing?" signal. (Per-shard
 *   *active* connection count would require route-to-acquire
 *   correlation that the current `acquire(tenantId)` API doesn't
 *   capture; cumulative routes are the directly-observable proxy.)
 * - `lastRouteMs` — wall-clock of the most recent `route()` call (a
 *   climb means the hot path is getting slower — usually a sign that
 *   `load:` is doing too much work, or the shard count exploded).
 */
export type RouterMetrics = {
	routes: number;
	acquires: number;
	rejectsByDecision: Record<Exclude<RouteDecision, 'allow'>, number>;
	shardLoadDistribution: Record<string, number>;
	lastRouteMs: number;
};

export type RouteRequest = {
	tenantId: string;
	/**
	 * Optional sub-key within a tenant for shardable channels. When set, the
	 * hash key is `${tenantId}:${channelId}`. Use this when a single tenant is
	 * too hot for one engine and its work can be partitioned (e.g. per-doc,
	 * per-room) across multiple engines. Different channels of the same
	 * tenant may land on different shards.
	 */
	channelId?: string;
	/**
	 * Optional per-route rate-limit key. Looked up in `perRouteRateLimits`.
	 * Unknown routes pass without per-route gating (only the tenant-wide
	 * bucket applies).
	 */
	route?: string;
};

export type RouteResult = {
	decision: RouteDecision;
	/** The chosen shard. `null` when `decision !== 'allow'`. */
	shard: Shard | null;
	/**
	 * Set on a `'rate-limited'` result to tell the caller which bucket emptied:
	 * `'tenant'` for the tenant-wide bucket, the route id for a per-route bucket.
	 */
	emptiedBucket?: 'tenant' | string;
};

export type AcquireHandle = {
	/** Number of active connections for this tenant after acquire (>=1). */
	active: number;
	/** Releases one connection for this tenant. Idempotent — safe to call once. */
	release: () => void;
};

export type RouterSnapshot = {
	version: 1;
	at: number;
	shards: Array<Shard & { healthy: boolean; draining: boolean; active: number }>;
	tenants: Array<{
		tenant: string;
		active: number;
		tokens: number;
		lastRefillAt: number;
	}>;
	routeBuckets: Array<{
		tenant: string;
		route: string;
		tokens: number;
		lastRefillAt: number;
	}>;
};

export type Router = {
	route: (request: RouteRequest) => RouteResult;
	acquire: (tenantId: string) => AcquireHandle;
	markHealthy: (shardId: string) => void;
	markUnhealthy: (shardId: string) => void;
	/**
	 * Begin draining a shard — exclude it from new routing decisions while
	 * leaving existing acquires alone. Semantically distinct from
	 * `markUnhealthy` (an operator-intentional state, not a failure).
	 * `markHealthy` cancels both states. Use this before a planned shard
	 * shutdown — tenants on the shard rehash to healthy non-draining shards
	 * on their next route, but in-flight requests are NOT torn down.
	 */
	drainShard: (shardId: string) => void;
	isHealthy: (shardId: string) => boolean;
	isDraining: (shardId: string) => boolean;
	addShard: (shard: Shard) => void;
	removeShard: (shardId: string) => void;
	shards: () => Shard[];
	snapshot: () => RouterSnapshot;
	restore: (snapshot: RouterSnapshot) => void;
	/**
	 * Operator-shaped point-in-time + cumulative metrics since
	 * `createRouter()`. Use for tier dashboards and "where am I
	 * shedding load" alerts. Distinct from `snapshot()`, which is the
	 * persistence shape (preserves tenant + bucket state across a
	 * shard reboot). Added in 0.2.0.
	 */
	metrics: () => RouterMetrics;
	dispose: () => void;
};

// -----------------------------------------------------------------------------
// Hash strategies
// -----------------------------------------------------------------------------

/**
 * FNV-1a 32-bit. Cheap, no deps, good enough as a seed for the consistent
 * hash strategies below. Not cryptographic — do NOT use as a security hash.
 */
const fnv1a32 = (input: string): number => {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
};

/**
 * Jump-consistent-hash, Lamping & Veach 2014. Maps a 64-bit key to a bucket
 * in `[0, numBuckets)`. Properties: O(log n), no memory, exactly 1/N keys
 * move when buckets are added at the tail.
 */
const jumpHash = (key: string, numBuckets: number): number => {
	if (numBuckets <= 0) return -1;
	let k = BigInt(fnv1a32(key)) | (BigInt(fnv1a32(key + '#hi')) << 32n);
	let b = -1n;
	let j = 0n;
	while (j < BigInt(numBuckets)) {
		b = j;
		k = (k * 2862933555777941757n + 1n) & 0xffffffffffffffffn;
		const shifted = (k >> 33n) + 1n;
		j = ((b + 1n) * (1n << 31n)) / shifted;
	}
	return Number(b);
};

const jumpStrategy: HashStrategyFn = (key, shards) => jumpHash(key, shards.length);

const makeRendezvousStrategy = (load?: ShardLoadFn): HashStrategyFn => (key, shards) => {
	let bestIndex = 0;
	let bestScore = -Infinity;
	for (let i = 0; i < shards.length; i++) {
		const shard = shards[i]!;
		const baseWeight = shard.weight ?? 1;
		if (baseWeight <= 0) continue;
		const loadValue = load ? Math.max(load(shard.id), 0.0001) : 1;
		const effectiveWeight = baseWeight / loadValue;
		const seed = fnv1a32(`${key}|${shard.id}`);
		const u = (seed + 1) / 0x1_0000_0000;
		const score = effectiveWeight * -Math.log(u);
		if (score > bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}
	return bestIndex;
};

const resolveStrategy = (strategy: HashStrategy, load?: ShardLoadFn): HashStrategyFn => {
	if (strategy === 'jump') return jumpStrategy;
	if (strategy === 'rendezvous') return makeRendezvousStrategy(load);
	return strategy;
};

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

type Bucket = {
	tokens: number;
	lastRefillAt: number;
};

type TenantState = {
	active: number;
	bucket: Bucket;
};

export const createRouter = (options: RouterOptions): Router => {
	const clock = options.clock ?? Date.now;
	const strategy = resolveStrategy(options.hashStrategy ?? 'jump', options.load);
	const cap = options.perTenantConnectionCap ?? Infinity;
	const rate = options.perTenantRateLimit ?? { refillPerSecond: 0, tokens: Infinity };
	const perRouteRateLimits = options.perRouteRateLimits ?? {};
	const allowHook = options.allow;

	const shardList: Shard[] = [...options.shards];
	const healthy = new Map<string, boolean>();
	const draining = new Set<string>();
	for (const shard of shardList) healthy.set(shard.id, true);

	const tenants = new Map<string, TenantState>();
	/** Per-tenant per-route bucket. Key = `${tenant}|${route}`. */
	const routeBuckets = new Map<string, Bucket>();
	let disposed = false;
	// 0.2.0: cumulative operator counters. Per-shard active count is
	// derived from `acquires` minus per-shard releases — but tracking
	// per-shard requires routing → acquire correlation that the
	// existing API doesn't enforce. Use point-in-time aggregation from
	// `tenants` Map: each tenant's active count contributes to its
	// most-recently-routed shard. (Acquire isn't shard-tagged today;
	// adding a `shardId` to the AcquireHandle is a separate change.)
	let totalRoutes = 0;
	let totalAcquires = 0;
	let lastRouteMs = 0;
	const rejectsByDecision: Record<
		Exclude<RouteDecision, 'allow'>,
		number
	> = {
		'rate-limited': 0,
		'capped': 0,
		'no-shards': 0,
		'denied': 0
	};
	const shardLoadByShard = new Map<string, number>();

	const freshTenant = (now: number): TenantState => ({
		active: 0,
		bucket: { lastRefillAt: now, tokens: rate.tokens },
	});

	const ensureTenant = (id: string, now: number): TenantState => {
		const found = tenants.get(id);
		if (found) return found;
		const fresh = freshTenant(now);
		tenants.set(id, fresh);
		return fresh;
	};

	const refillBucket = (bucket: Bucket, rule: RateLimit, now: number) => {
		if (rule.refillPerSecond <= 0) return;
		const elapsedMs = now - bucket.lastRefillAt;
		if (elapsedMs <= 0) return;
		const added = (elapsedMs / 1000) * rule.refillPerSecond;
		bucket.tokens = Math.min(rule.tokens, bucket.tokens + added);
		bucket.lastRefillAt = now;
	};

	const ensureRouteBucket = (tenant: string, route: string, rule: RateLimit, now: number): Bucket => {
		const key = `${tenant}|${route}`;
		const found = routeBuckets.get(key);
		if (found) return found;
		const fresh: Bucket = { lastRefillAt: now, tokens: rule.tokens };
		routeBuckets.set(key, fresh);
		return fresh;
	};

	const eligibleShards = (): Shard[] =>
		shardList.filter((shard) => healthy.get(shard.id) === true && !draining.has(shard.id));

	const route: Router['route'] = (request) => {
		const routeStart = clock();
		totalRoutes += 1;
		const recordRejection = (
			decision: Exclude<RouteDecision, 'allow'>
		): RouteResult => {
			rejectsByDecision[decision] += 1;
			lastRouteMs = clock() - routeStart;
			return { decision, shard: null };
		};
		if (disposed) return recordRejection('no-shards');

		const live = eligibleShards();
		if (live.length === 0) return recordRejection('no-shards');

		if (allowHook && !allowHook(request.tenantId)) {
			return recordRejection('denied');
		}

		const now = routeStart;
		const state = ensureTenant(request.tenantId, now);

		if (state.active >= cap) {
			return recordRejection('capped');
		}

		refillBucket(state.bucket, rate, now);
		if (state.bucket.tokens < 1) {
			rejectsByDecision['rate-limited'] += 1;
			lastRouteMs = clock() - routeStart;
			return {
				decision: 'rate-limited',
				emptiedBucket: 'tenant',
				shard: null
			};
		}

		let routeBucket: Bucket | null = null;
		let routeRule: RateLimit | null = null;
		if (request.route !== undefined && perRouteRateLimits[request.route] !== undefined) {
			routeRule = perRouteRateLimits[request.route]!;
			routeBucket = ensureRouteBucket(request.tenantId, request.route, routeRule, now);
			refillBucket(routeBucket, routeRule, now);
			if (routeBucket.tokens < 1) {
				rejectsByDecision['rate-limited'] += 1;
				lastRouteMs = clock() - routeStart;
				return {
					decision: 'rate-limited',
					emptiedBucket: request.route,
					shard: null
				};
			}
		}

		// Commit both buckets only after both passed.
		state.bucket.tokens -= 1;
		if (routeBucket) routeBucket.tokens -= 1;

		const key = request.channelId === undefined
			? request.tenantId
			: `${request.tenantId}:${request.channelId}`;
		const index = strategy(key, live);
		const chosen = live[Math.max(0, Math.min(index, live.length - 1))]!;
		shardLoadByShard.set(
			chosen.id,
			(shardLoadByShard.get(chosen.id) ?? 0) + 1
		);
		lastRouteMs = clock() - routeStart;
		return { decision: 'allow', shard: chosen };
	};

	const acquire: Router['acquire'] = (tenantId) => {
		const now = clock();
		const state = ensureTenant(tenantId, now);
		state.active += 1;
		totalAcquires += 1;
		let released = false;
		return {
			active: state.active,
			release: () => {
				if (released) return;
				released = true;
				const current = tenants.get(tenantId);
				if (current && current.active > 0) current.active -= 1;
			},
		};
	};

	return {
		acquire,
		addShard: (shard) => {
			if (shardList.some((existing) => existing.id === shard.id)) return;
			shardList.push(shard);
			healthy.set(shard.id, true);
		},
		dispose: () => {
			disposed = true;
			shardList.length = 0;
			healthy.clear();
			draining.clear();
			tenants.clear();
			routeBuckets.clear();
		},
		drainShard: (id) => {
			if (healthy.has(id)) draining.add(id);
		},
		isDraining: (id) => draining.has(id),
		isHealthy: (id) => healthy.get(id) === true,
		metrics: () => ({
			acquires: totalAcquires,
			lastRouteMs,
			rejectsByDecision: { ...rejectsByDecision },
			routes: totalRoutes,
			shardLoadDistribution: Object.fromEntries(shardLoadByShard)
		}),
		markHealthy: (id) => {
			if (healthy.has(id)) {
				healthy.set(id, true);
				draining.delete(id);
			}
		},
		markUnhealthy: (id) => {
			if (healthy.has(id)) healthy.set(id, false);
		},
		removeShard: (id) => {
			const at = shardList.findIndex((shard) => shard.id === id);
			if (at >= 0) shardList.splice(at, 1);
			healthy.delete(id);
			draining.delete(id);
		},
		route,
		shards: () => shardList.map((shard) => ({ ...shard })),
		snapshot: () => {
			const now = clock();
			const tenantsOut: RouterSnapshot['tenants'] = [];
			for (const [tenant, state] of tenants) {
				tenantsOut.push({
					active: state.active,
					lastRefillAt: state.bucket.lastRefillAt,
					tenant,
					tokens: state.bucket.tokens,
				});
			}
			const routesOut: RouterSnapshot['routeBuckets'] = [];
			for (const [key, bucket] of routeBuckets) {
				const pipe = key.indexOf('|');
				if (pipe < 0) continue;
				routesOut.push({
					lastRefillAt: bucket.lastRefillAt,
					route: key.slice(pipe + 1),
					tenant: key.slice(0, pipe),
					tokens: bucket.tokens,
				});
			}
			return {
				at: now,
				routeBuckets: routesOut,
				shards: shardList.map((shard) => {
					const active = Array.from(tenants.values()).reduce((acc, state) => acc + state.active, 0);
					return {
						...shard,
						active,
						draining: draining.has(shard.id),
						healthy: healthy.get(shard.id) === true,
					};
				}),
				tenants: tenantsOut,
				version: 1,
			};
		},
		restore: (snap) => {
			tenants.clear();
			routeBuckets.clear();
			draining.clear();
			for (const t of snap.tenants) {
				tenants.set(t.tenant, {
					active: t.active,
					bucket: { lastRefillAt: t.lastRefillAt, tokens: t.tokens },
				});
			}
			for (const r of snap.routeBuckets) {
				routeBuckets.set(`${r.tenant}|${r.route}`, {
					lastRefillAt: r.lastRefillAt,
					tokens: r.tokens,
				});
			}
			for (const shard of snap.shards) {
				healthy.set(shard.id, shard.healthy);
				if (shard.draining) draining.add(shard.id);
			}
		},
	};
};
