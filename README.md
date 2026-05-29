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

## Surface (0.1.0)

| API | Purpose |
|---|---|
| `createRouter(options)` | Factory. Returns a `Router`. |
| `router.route({ tenantId, channelId?, route? })` | Returns `{ shard, decision, emptiedBucket? }`. Decision is `allow` / `rate-limited` / `capped` / `no-shards` / `denied`. |
| `router.acquire(tenantId)` | Increment active-connection counter; returns `{ active, release }`. `release` is idempotent. |
| `router.markHealthy(id)` / `router.markUnhealthy(id)` | Caller-driven health state. Unhealthy shards are skipped. |
| `router.drainShard(id)` | Refuse new routes; existing acquires unaffected. Operator-intentional state distinct from unhealthy. `markHealthy` cancels it. |
| `router.isHealthy(id)` / `router.isDraining(id)` | Inspect state. |
| `router.addShard(shard)` / `router.removeShard(id)` | Runtime shard membership changes. |
| `router.shards()` | Inspect shard list. |
| `router.snapshot()` / `router.restore(snap)` | Serializable point-in-time state. Survive edge restarts without dropping rate-limit tokens. |
| `router.dispose()` | Stop accepting routes; all subsequent `route()` returns `no-shards`. |

### Hash strategies + load bias

- **`jump`** (default) — Lamping & Veach 2014. O(log n) with no memory, exactly 1/N keys move when shards are added at the tail. Ignores `weight` AND `load` (its design property is unconditional stickiness).
- **`rendezvous`** — HRW hash. Supports per-shard `weight` for heterogeneous engine sizes; ALSO supports the `load: (shardId) => number` hook for runtime hot-spot avoidance — `effectiveWeight = weight / load`. O(N) per lookup.
- **Custom**: pass `(key, shards) => index`.

### Drain mode

`drainShard(id)` excludes a shard from new routing without marking it broken. Use this before a planned shard shutdown — tenants on the draining shard rehash to healthy non-draining shards on their NEXT route, but in-flight requests aren't torn down. The caller waits for the shard to be quiet (e.g. via the runtime's stats), then `removeShard()`. `markHealthy()` cancels a drain in case ops changes their mind.

### Connection cap

`perTenantConnectionCap` is the max concurrent connections one tenant can hold,
counted via `acquire()` / the returned `release()`. When reached, `route()`
returns `capped` — your gateway should refuse the upgrade with `429` /
`503`. Default `Infinity` (no cap).

### Rate limits — tenant + per-route

`perTenantRateLimit` is a token bucket per tenant: `tokens` is bucket capacity AND starting balance; `refillPerSecond` continuously refills up to capacity. Each successful `route()` costs one token. Bucket is computed lazily at lookup time — no timer churn for idle tenants. Default `{ tokens: Infinity, refillPerSecond: 0 }` (no limit).

`perRouteRateLimits: Record<string, RateLimit>` layers a SECOND per-route bucket on top of the tenant-wide one. `route({ route: 'expensive' })` checks both; if either is empty, the call returns `rate-limited` with `emptiedBucket` reporting which one. Useful for "100 cheap calls / minute, 5 expensive calls / minute" shapes where one tenant-wide cap won't express the policy. **A failed route bucket does NOT consume the tenant bucket** — neither token is deducted unless both pass.

### Allow hook (meter integration)

`allow: (tenantId) => boolean` is a caller-supplied gate. Returning `false` makes `route()` return `{ decision: 'denied' }` immediately, before any bucket is touched. The intended pairing is `@absolutejs/metering`'s `meter.allow` — pass it directly:

```ts
const meter = createMeter({ ... });
const router = createRouter({
  shards,
  allow: meter.allow,                // refuse routes for over-quota tenants
  load: (id) => runtimeRoster.load(id), // and bias toward less-loaded shards
});
```

### Health

The router does not probe backends itself — keeping it bun/elysia-free means no I/O. Wire your own health-check loop and call `markHealthy` / `markUnhealthy`. A live health-checking adapter is a candidate for a later 0.0.x subpath.

### Snapshot + restore

```ts
const json = JSON.stringify(router.snapshot());
await persistToDisk('/var/lib/router/state.json', json);

// On edge restart:
const restored = createRouter({ ... same config ... });
restored.restore(JSON.parse(await readFromDisk('/var/lib/router/state.json')));
```

Captures rate-limit token counts, per-route bucket state, shard health + drain state, per-tenant active connection counts. Without this, an edge restart hands every tenant a fresh full bucket — instant rate-limit-bypass for anyone watching the deploy times.

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
