/**
 * Custom-domain map — hostname → tenant resolution for custom domains at
 * the edge gateway. 0.4.0, closes the edge-routing gap (5.6) from the
 * PaaS guide.
 *
 * A tenant's traffic arrives as `app.acme.com` (their CNAME), not as a
 * tenant id. The domain map is the first lookup in the edge gateway:
 *
 * ```ts
 * const hit = domainMap.resolve(request.headers.get('host') ?? '');
 * if (!hit) return new Response('unknown domain', { status: 404 });
 * router.route({ tenantId: hit.tenantId, region: directory.regionFor(hit.tenantId) });
 * ```
 *
 * Dependency-free and O(1)-ish: a Map for exact hosts, a Map keyed by
 * suffix for `*.example.com` wildcards (one lookup each — no per-entry
 * scan).
 */

import {
	ABS_ATTRS,
	tracerOrNoop,
	type TracerProvider
} from '@absolutejs/telemetry';

export type DomainMatch = 'exact' | 'wildcard' | 'fallback';

export type DomainResolution = {
	tenantId: string;
	matched: DomainMatch;
};

/**
 * Optional caller-supplied resolver of last resort, consulted when neither
 * an exact nor a wildcard entry matches. The intended use is the platform's
 * own subdomain scheme — parse `<workspace>.cloud.absolutejs.com` into a
 * tenant id without registering every workspace as an entry. Returning
 * `undefined` makes the resolve a miss (`resolve()` returns `null`).
 */
export type DomainFallbackFn = (hostname: string) => string | undefined;

export type DomainMapOptions = {
	/** Optional resolver of last resort. See {@link DomainFallbackFn}. */
	fallback?: DomainFallbackFn;
	/** Override `Date.now` for tests. */
	clock?: () => number;
	/**
	 * Optional OpenTelemetry tracer provider. When set, `resolve()` is
	 * wrapped in `router.domain_resolve` spans with `abs.domain.host`,
	 * and (on a hit) `abs.tenant` + `abs.domain.matched` attributes.
	 * Status OK on hit, ERROR on miss. When omitted, all tracing is a
	 * zero-allocation noop.
	 */
	tracerProvider?: TracerProvider;
};

export type DomainMapEntry = {
	/** Wildcard entries keep their `*.example.com` form here. */
	hostname: string;
	tenantId: string;
};

export type DomainMapSnapshot = {
	version: 1;
	at: number;
	entries: DomainMapEntry[];
};

/**
 * Returned by {@link DomainMap.metrics}.
 *
 * - `entries` — registered entries (exact + wildcard).
 * - `resolves` — total `resolve()` calls.
 * - `hits` / `misses` — resolves that found a tenant (any match kind)
 *   vs. resolves that returned `null`. A climbing miss rate usually
 *   means stale DNS pointing at the gateway after an offboard.
 * - `lastResolveMs` — wall-clock of the most recent `resolve()` call.
 */
export type DomainMapMetrics = {
	entries: number;
	resolves: number;
	hits: number;
	misses: number;
	lastResolveMs: number;
};

export type DomainMap = {
	/**
	 * Register a hostname → tenant entry. Hostnames are lowercased.
	 * `*.example.com` registers a wildcard matching exactly one label
	 * (`app.example.com` yes; `a.b.example.com` and the bare apex no).
	 * Throws on any other `*` placement.
	 */
	add: (hostname: string, tenantId: string) => void;
	remove: (hostname: string) => void;
	/**
	 * Resolve a request's `Host` value to a tenant. Strips the port,
	 * lowercases, then checks exact → wildcard → `fallback` hook (exact
	 * beats wildcard). Returns `null` on a miss.
	 */
	resolve: (hostname: string) => DomainResolution | null;
	list: () => DomainMapEntry[];
	snapshot: () => DomainMapSnapshot;
	restore: (snapshot: DomainMapSnapshot) => void;
	metrics: () => DomainMapMetrics;
};

/**
 * Lowercase + strip the `:port` suffix from a `Host` header value.
 * Bracketed IPv6 literals (`[::1]:8080`) keep their brackets.
 */
const normalizeHost = (hostname: string): string => {
	let host = hostname.trim().toLowerCase();
	if (host.startsWith('[')) {
		const close = host.indexOf(']');
		if (close >= 0) host = host.slice(0, close + 1);
		return host;
	}
	const colon = host.indexOf(':');
	if (colon >= 0) host = host.slice(0, colon);
	return host;
};

export const createDomainMap = (options: DomainMapOptions = {}): DomainMap => {
	const clock = options.clock ?? Date.now;
	const fallbackHook = options.fallback;
	const tracer = tracerOrNoop(options.tracerProvider, '@absolutejs/router');

	/** Exact hostname → tenant id. */
	const exact = new Map<string, string>();
	/** Wildcard suffix (the part after `*.`) → tenant id. */
	const wildcard = new Map<string, string>();

	let totalResolves = 0;
	let hits = 0;
	let misses = 0;
	let lastResolveMs = 0;

	const resolve: DomainMap['resolve'] = (hostname) => {
		const resolveStart = clock();
		totalResolves += 1;
		const host = normalizeHost(hostname);
		// 0.4.0: span the resolve. Hot-path safe — noop tracer when no
		// tracerProvider is set.
		const span = tracer.startSpan('router.domain_resolve', {
			attributes: { 'abs.domain.host': host }
		});
		const finish = (
			result: DomainResolution | null
		): DomainResolution | null => {
			if (result === null) {
				misses += 1;
				span.setStatus({ code: 2 /* ERROR */ });
			} else {
				hits += 1;
				span.setAttribute(ABS_ATTRS.tenant, result.tenantId);
				span.setAttribute('abs.domain.matched', result.matched);
				span.setStatus({ code: 1 /* OK */ });
			}
			span.end();
			lastResolveMs = clock() - resolveStart;
			return result;
		};

		const exactHit = exact.get(host);
		if (exactHit !== undefined) {
			return finish({ matched: 'exact', tenantId: exactHit });
		}

		// Wildcard matches exactly one label: strip the first label and
		// look the remainder up as a suffix. `a.b.example.com` produces
		// the suffix `b.example.com`, so a `*.example.com` entry does
		// NOT match two labels deep — by design (mirrors how TLS
		// wildcard certificates scope).
		const dot = host.indexOf('.');
		if (dot > 0) {
			const wildcardHit = wildcard.get(host.slice(dot + 1));
			if (wildcardHit !== undefined) {
				return finish({ matched: 'wildcard', tenantId: wildcardHit });
			}
		}

		const fallbackHit = fallbackHook?.(host);
		if (fallbackHit !== undefined) {
			return finish({ matched: 'fallback', tenantId: fallbackHit });
		}
		return finish(null);
	};

	const add: DomainMap['add'] = (hostname, tenantId) => {
		const host = normalizeHost(hostname);
		if (host.startsWith('*.')) {
			const suffix = host.slice(2);
			if (suffix.length === 0 || suffix.includes('*')) {
				throw new Error(
					`add: unsupported wildcard pattern "${hostname}" — only "*.example.com" (one leading label) is supported`
				);
			}
			wildcard.set(suffix, tenantId);
			return;
		}
		if (host.includes('*')) {
			throw new Error(
				`add: unsupported wildcard pattern "${hostname}" — only "*.example.com" (one leading label) is supported`
			);
		}
		exact.set(host, tenantId);
	};

	const list: DomainMap['list'] = () => {
		const entries: DomainMapEntry[] = [];
		for (const [hostname, tenantId] of exact) {
			entries.push({ hostname, tenantId });
		}
		for (const [suffix, tenantId] of wildcard) {
			entries.push({ hostname: `*.${suffix}`, tenantId });
		}
		return entries;
	};

	return {
		add,
		list,
		metrics: () => ({
			entries: exact.size + wildcard.size,
			hits,
			lastResolveMs,
			misses,
			resolves: totalResolves
		}),
		remove: (hostname) => {
			const host = normalizeHost(hostname);
			if (host.startsWith('*.')) {
				wildcard.delete(host.slice(2));
				return;
			}
			exact.delete(host);
		},
		resolve,
		restore: (snap) => {
			exact.clear();
			wildcard.clear();
			// Re-add through the same classification path so wildcard
			// entries land back in the suffix map.
			for (const entry of snap.entries) {
				add(entry.hostname, entry.tenantId);
			}
		},
		snapshot: () => ({
			at: clock(),
			entries: list(),
			version: 1
		})
	};
};
