# @absolutejs/router changelog

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
