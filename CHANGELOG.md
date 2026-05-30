# @absolutejs/router changelog

## 0.3.0 — 2026-05-30

### Added — OpenTelemetry tracing via @absolutejs/telemetry

Closes G2 (deep-research audit) for the router.

- **`RouterOptions.tracerProvider?: TracerProvider`** — any
  `@opentelemetry/api`-compatible. Structural type via
  `@absolutejs/telemetry`; no peer-dep on `@opentelemetry/api`.
- **`router.route` span** per `route()` call. Attributes: `abs.tenant`,
  `abs.route.decision`, `abs.route.shard` (on allow), `abs.route.name`
  (when supplied). Status OK on `allow`; ERROR on rejection
  (`rate-limited` / `capped` / `denied` / `no-shards`).
- **`router.acquire` span** per `acquire()` with `abs.tenant` +
  `abs.tenant.active` (active count after the increment).
- `@absolutejs/telemetry` added as a regular dep.
- Zero-cost when `tracerProvider` is omitted (noop tracer singleton).

5 new tests in `tests/tracing.test.ts`: allow / denied / rate-limited /
acquire / noop fallback.

Test count: 34 → 39.

## 0.2.0 — 2026-05-29

Substrate-pattern uniformity. Backwards-compatible — `snapshot()` keeps
its persistence shape; `metrics()` is the new operator-shaped surface.

### Added

- **`Router.metrics()`** returning `RouterMetrics`:
  - `routes` — total `route()` calls (any decision).
  - `acquires` — total `acquire()` calls.
  - `rejectsByDecision` — `Record<Exclude<RouteDecision, 'allow'>, number>`
    counting `rate-limited` / `capped` / `no-shards` / `denied`. The
    operator's "where am I shedding load?" surface.
  - `shardLoadDistribution` — cumulative `allow` routes assigned per
    shard since start. With `markHealthy` / `drainShard` this is the
    "is rebalancing actually rebalancing?" signal.
  - `lastRouteMs` — wall-clock of the most recent `route()` call. A
    climb signals the hot path is getting slower (often the `load:`
    hook is doing too much work).
- Counters survive `dispose()` for post-shutdown introspection.

`snapshot()` kept unchanged — its job is persistence (restore tenant
+ bucket state across a shard reboot); `metrics()` is monitoring.

10 new tests in `tests/metrics.test.ts`. Test count: 24 → 34.

## 0.1.0 — 2026-05-29

Substrate-deepening pass. Mostly additive; one breaking change to the
0.0.1 `snapshot()` return shape — see "Breaking" below.

### Added

- **`drainShard(shardId)`** — exclude a shard from new routing decisions
  while leaving existing acquires alone. Semantically distinct from
  `markUnhealthy` (an operator-intentional state, not a failure).
  `markHealthy` cancels both states. Use this before a planned shard
  shutdown: tenants on the draining shard rehash to healthy non-draining
  shards on their next route; in-flight requests are NOT torn down.
- **`isDraining(shardId)` / `isHealthy(shardId)`** — inspect the state.
- **`load: (shardId) => number` option.** Bias the **rendezvous** strategy
  away from overloaded shards. `effectiveWeight = shard.weight / load(id)`.
  Higher load = lower effective weight = less likely to be picked. Jump
  hash ignores this (its by-design property: ~1/N movement on shard
  change). Useful when a stickiness-locked shard is hot — the router
  can't move existing tenants, but it can avoid sending NEW tenants there.
- **`perRouteRateLimits: Record<string, RateLimit>` option.** Per-route
  token buckets layered on top of the tenant-wide bucket. `route()` now
  accepts an optional `route` field; if set, the matching bucket is
  checked alongside the tenant bucket — both must have a token for the
  request to pass. A `rate-limited` result reports which bucket emptied
  via the new `emptiedBucket` field (`'tenant'` or the route id).
- **`allow: (tenantId) => boolean` option.** Caller-supplied gate. When
  it returns `false`, `route()` returns `{ decision: 'denied' }`. The
  intended pairing is `@absolutejs/metering`'s `meter.allow` — pass it
  directly and the router refuses routes for over-quota tenants without
  any wiring on the caller's side.
- **`route()` `denied` decision** — paired with the `allow` hook above.
- **`route()` `emptiedBucket` field** — set on `rate-limited` results so
  the caller knows which bucket to surface to the user (and which to
  watch for refill).
- **`restore(snapshot)`** — repopulate router state from a previously
  captured `snapshot()`. Preserves rate-limit tokens, shard health +
  drain state, per-tenant active counts. Useful so an edge restart
  doesn't suddenly let everyone fire one fresh token's worth of traffic.

### Breaking

- **`snapshot()` shape changed.** Was
  `{ shards, tenants: number }`; is now
  `{ version, at, shards, tenants: Array, routeBuckets: Array }`. The
  `tenants` field went from a count to a list of `{ tenant, active,
  tokens, lastRefillAt }`. Existing consumers reading `snap.tenants` as a
  number need to read `snap.tenants.length` instead. snapshot() was
  observation-only in 0.0.1 (no `restore()` existed); 0.1.0 makes it the
  serializable persistence format that pairs with `restore()`.

### Internal

- Rendezvous strategy now closes over the `load` hook at creation time
  rather than per-call. No observable behavior change beyond the load
  bias.

## 0.0.1 — 2026-05-29

Initial release.

- `createRouter({ shards, hashStrategy, perTenantConnectionCap, perTenantRateLimit, clock })`
  factory.
- `route({ tenantId, channelId? })` → `{ shard, decision }` where decision is
  one of `allow`, `rate-limited`, `capped`, `no-shards`. Stickiness keyed by
  `tenantId` by default; pass `channelId` to shard within a tenant when a
  single tenant is too hot for one engine.
- Hash strategies: `jump` (default, fast, ~5ns/lookup, exactly 1/N movement
  on shard change) and `rendezvous` (HRW; weighted shards). Pluggable via
  `hashStrategy: 'jump' | 'rendezvous' | (key, shards) => index`.
- `acquire(tenantId)` returns a release handle for WS connection accounting.
  When the per-tenant cap is hit, `route()` returns `capped`.
- `markHealthy(id)` / `markUnhealthy(id)` — caller-driven health state.
  Unhealthy shards are skipped; their tenants rehash onto healthy shards.
- `addShard(shard)` / `removeShard(id)` — runtime shard membership changes.
  Jump-hash means add/remove moves ~1/N of tenants; rendezvous moves O(weight-change/total).
- Per-tenant token-bucket rate limit; default `{ tokens: Infinity, refillPerSecond: 0 }` (no limit).
- Pure in-memory, single-process v0.0.1. Distributed coordination across
  multiple router replicas, the `bun.serve` / Elysia WS-proxy adapter, and
  the backend health-check probe loop all ship in later versions.
