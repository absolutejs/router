# @absolutejs/router

Multi-tenant connection routing primitive for Bun PaaS gateways. Sits in front
of N backend processes (each a [`@absolutejs/runtime`](https://github.com/absolutejs/runtime)
instance hosting a [`@absolutejs/sync`](https://github.com/absolutejs/sync) engine
for a subset of tenants) and decides — per request:

1. Which shard owns this tenant (consistent hash, sticky)
2. Is the tenant over its connection cap?
3. Is the tenant over its rate limit?
4. Is the chosen shard healthy?

Pure logic, zero Bun / Elysia surface. Wire `router.route(...)` into whichever
HTTP/WS layer you have (Bun.serve, Elysia, native node:http, anything that can
return a 503). An Elysia adapter ships in a later 0.0.x as a subpath.

```ts
import { createRouter } from '@absolutejs/router';

const router = createRouter({
  shards: [
    { id: 'engine-1', url: 'ws://10.0.0.11:3000' },
    { id: 'engine-2', url: 'ws://10.0.0.12:3000' },
  ],
  hashStrategy: 'jump',
  perTenantConnectionCap: 100,
  perTenantRateLimit: { tokens: 100, refillPerSecond: 10 },
});

// In your WS upgrade handler:
const decision = router.route({ tenantId, channelId });
if (decision.decision !== 'allow') {
  return new Response(decision.decision, { status: 429 });
}
const handle = router.acquire(tenantId);
ws.data = { ...ws.data, release: handle.release, upstream: decision.shard!.url };
// ...proxy WS frames to decision.shard.url; call handle.release() on close.
```

## v0.0.1 surface

| API | Purpose |
|---|---|
| `createRouter(options)` | Factory. Returns a `Router`. |
| `router.route({ tenantId, channelId? })` | Returns `{ shard, decision }`. Decision is `allow` / `rate-limited` / `capped` / `no-shards`. |
| `router.acquire(tenantId)` | Increment a tenant's active-connection counter; returns `{ active, release }`. `release` is idempotent. |
| `router.markHealthy(id)` / `router.markUnhealthy(id)` | Caller-driven health state. Unhealthy shards are skipped; tenants on them rehash to healthy ones. |
| `router.addShard(shard)` / `router.removeShard(id)` | Runtime shard membership changes. |
| `router.shards()` / `router.snapshot()` | Inspection. |
| `router.dispose()` | Stop accepting routes; all subsequent `route()` returns `no-shards`. |

### Hash strategies

- **`jump`** (default) — Lamping & Veach 2014. O(log n) with no memory, exactly
  1/N keys move when shards are added at the tail. Ignores `weight`.
- **`rendezvous`** — HRW hash. Supports per-shard `weight` for heterogeneous
  engine sizes. O(N) per lookup.
- **Custom**: pass `(key, shards) => index`.

### Connection cap

`perTenantConnectionCap` is the max concurrent connections one tenant can hold,
counted via `acquire()` / the returned `release()`. When reached, `route()`
returns `capped` — your gateway should refuse the upgrade with `429` /
`503`. Default `Infinity` (no cap).

### Rate limit

`perTenantRateLimit` is a token bucket per tenant: `tokens` is bucket capacity
AND starting balance; `refillPerSecond` continuously refills up to capacity.
Each successful `route()` costs one token. Bucket is computed lazily at lookup
time — no timer churn for idle tenants. Default `{ tokens: Infinity,
refillPerSecond: 0 }` (no limit).

### Health

The router does not probe backends itself — keeping it bun/elysia-free means
no I/O. Wire your own health-check loop and call `markHealthy` / `markUnhealthy`.
A live health-checking adapter is a candidate for a later 0.0.x subpath.

## Architectural role

- **`@absolutejs/sync`** — the engine each backend shard runs.
- **`@absolutejs/runtime`** — the process pool each backend shard spawns from.
- **`@absolutejs/metering`** — counts the bill; `meter.allow(tenant)` reads.
- **`@absolutejs/router`** — *this library*. The edge decision before traffic reaches a shard. `meter.allow()` can be wired into the gateway alongside `router.route()` to refuse over-quota tenants without paying for the upstream hop.

## What v0.0.1 does NOT include

- The actual WS proxy implementation. Caller wires `Bun.serve` (or any HTTP/WS layer) to `router.route()` and forwards bytes themselves.
- The Elysia adapter (subpath in a later 0.0.x).
- Distributed router state across multiple edge replicas (v0.2+).
- Backend health-checking probe loop.
- TLS / HTTP3 termination.

## License

BSL 1.1 with a named carveout for the hosted multi-tenant connection routing / WebSocket edge gateway category (Cloudflare Workers WebSockets, Cloudflare Smart Placement, Vercel edge router, Liveblocks' WebSocket fan-out, PartyKit, Ably, Pusher, Soketi). See [LICENSE](./LICENSE). Change Date: 4 years from first release; Change License: Apache 2.0.
