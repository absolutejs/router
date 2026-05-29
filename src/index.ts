/**
 * @absolutejs/router — multi-tenant connection routing primitive for Bun PaaS
 * gateways.
 *
 * Sits between an incoming request / WS upgrade and N backend processes (each
 * one a `@absolutejs/runtime` instance hosting a `@absolutejs/sync` engine
 * for a subset of tenants). Decides which shard owns the tenant, whether the
 * tenant is over its rate limit, whether the tenant is over its connection
 * cap, and whether the chosen shard is healthy.
 *
 * v0.0.1 is intentionally bun/elysia-agnostic — pure logic, no `Bun.serve`
 * or proxy code. The caller wires the routing decision into whichever HTTP/WS
 * layer they have. An Elysia adapter ships in a later 0.0.x as a subpath.
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
 * healthy shards (with their weights), return the index in `shards` of the
 * chosen shard. The router never calls a strategy with an empty `shards`
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
	/** Override `Date.now` for tests. */
	clock?: () => number;
};

export type RouteDecision = 'allow' | 'rate-limited' | 'capped' | 'no-shards';

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
};

export type RouteResult = {
	decision: RouteDecision;
	/** The chosen shard. `null` only when `decision === 'no-shards'`. */
	shard: Shard | null;
};

export type AcquireHandle = {
	/** Number of active connections for this tenant after acquire (>=1). */
	active: number;
	/** Releases one connection for this tenant. Idempotent — safe to call once. */
	release: () => void;
};

export type RouterSnapshot = {
	shards: Array<Shard & { healthy: boolean; active: number }>;
	tenants: number;
};

export type Router = {
	route: (request: RouteRequest) => RouteResult;
	acquire: (tenantId: string) => AcquireHandle;
	markHealthy: (shardId: string) => void;
	markUnhealthy: (shardId: string) => void;
	addShard: (shard: Shard) => void;
	removeShard: (shardId: string) => void;
	shards: () => Shard[];
	snapshot: () => RouterSnapshot;
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
 * move when buckets are added at the tail. We mix a 32-bit FNV-1a into a
 * 64-bit-ish state via bigint to satisfy the 64-bit arithmetic the algorithm
 * expects.
 */
const jumpHash = (key: string, numBuckets: number): number => {
	if (numBuckets <= 0) return -1;
	let k = BigInt(fnv1a32(key)) | (BigInt(fnv1a32(key + '#hi')) << 32n);
	let b = -1n;
	let j = 0n;
	while (j < BigInt(numBuckets)) {
		b = j;
		k = (k * 2862933555777941757n + 1n) & 0xffffffffffffffffn;
		// (b + 1) * (1 << 31) / ((k >> 33) + 1)
		const shifted = (k >> 33n) + 1n;
		j = ((b + 1n) * (1n << 31n)) / shifted;
	}
	return Number(b);
};

const jumpStrategy: HashStrategyFn = (key, shards) => jumpHash(key, shards.length);

/**
 * Rendezvous (highest-random-weight) hash. For each shard, compute
 * `score = weight * -ln(rand(hash(key + shard.id)))`; pick the shard with
 * the highest score. Properties: supports per-shard weighting, single-shard
 * change moves only that shard's "winning" keys, O(N) per lookup.
 */
const rendezvousStrategy: HashStrategyFn = (key, shards) => {
	let bestIndex = 0;
	let bestScore = -Infinity;
	for (let i = 0; i < shards.length; i++) {
		const shard = shards[i]!;
		const weight = shard.weight ?? 1;
		if (weight <= 0) continue;
		const seed = fnv1a32(`${key}|${shard.id}`);
		// Map [0, 2^32) to (0, 1) and take -ln. Heavier weight = higher expected score.
		const u = (seed + 1) / 0x1_0000_0000;
		const score = weight * -Math.log(u);
		if (score > bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}
	return bestIndex;
};

const resolveStrategy = (strategy: HashStrategy): HashStrategyFn => {
	if (strategy === 'jump') return jumpStrategy;
	if (strategy === 'rendezvous') return rendezvousStrategy;
	return strategy;
};

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

type TenantState = {
	active: number;
	tokens: number;
	lastRefillAt: number;
};

export const createRouter = (options: RouterOptions): Router => {
	const clock = options.clock ?? Date.now;
	const strategy = resolveStrategy(options.hashStrategy ?? 'jump');
	const cap = options.perTenantConnectionCap ?? Infinity;
	const rate = options.perTenantRateLimit ?? { refillPerSecond: 0, tokens: Infinity };

	const shardList: Shard[] = [...options.shards];
	const healthy = new Map<string, boolean>();
	for (const shard of shardList) healthy.set(shard.id, true);

	const tenants = new Map<string, TenantState>();
	let disposed = false;

	const freshTenant = (now: number): TenantState => ({
		active: 0,
		lastRefillAt: now,
		tokens: rate.tokens,
	});

	const ensureTenant = (id: string, now: number): TenantState => {
		const found = tenants.get(id);
		if (found) return found;
		const fresh = freshTenant(now);
		tenants.set(id, fresh);
		return fresh;
	};

	const refill = (state: TenantState, now: number) => {
		if (rate.refillPerSecond <= 0) return;
		const elapsedMs = now - state.lastRefillAt;
		if (elapsedMs <= 0) return;
		const added = (elapsedMs / 1000) * rate.refillPerSecond;
		state.tokens = Math.min(rate.tokens, state.tokens + added);
		state.lastRefillAt = now;
	};

	const healthyShards = (): Shard[] => shardList.filter((shard) => healthy.get(shard.id) === true);

	const route: Router['route'] = (request) => {
		if (disposed) return { decision: 'no-shards', shard: null };

		const live = healthyShards();
		if (live.length === 0) return { decision: 'no-shards', shard: null };

		const now = clock();
		const state = ensureTenant(request.tenantId, now);

		if (state.active >= cap) {
			return { decision: 'capped', shard: null };
		}

		refill(state, now);
		if (state.tokens < 1) {
			return { decision: 'rate-limited', shard: null };
		}
		state.tokens -= 1;

		const key = request.channelId === undefined
			? request.tenantId
			: `${request.tenantId}:${request.channelId}`;
		const index = strategy(key, live);
		const chosen = live[Math.max(0, Math.min(index, live.length - 1))]!;
		return { decision: 'allow', shard: chosen };
	};

	const acquire: Router['acquire'] = (tenantId) => {
		const now = clock();
		const state = ensureTenant(tenantId, now);
		state.active += 1;
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
			tenants.clear();
		},
		markHealthy: (id) => {
			if (healthy.has(id)) healthy.set(id, true);
		},
		markUnhealthy: (id) => {
			if (healthy.has(id)) healthy.set(id, false);
		},
		removeShard: (id) => {
			const at = shardList.findIndex((shard) => shard.id === id);
			if (at >= 0) shardList.splice(at, 1);
			healthy.delete(id);
		},
		route,
		shards: () => shardList.map((shard) => ({ ...shard })),
		snapshot: () => ({
			shards: shardList.map((shard) => ({
				...shard,
				active: 0,
				healthy: healthy.get(shard.id) === true,
			})),
			tenants: tenants.size,
		}),
	};
};
