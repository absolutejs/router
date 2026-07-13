import { describe, expect, test } from 'bun:test';
import {
	ABS_ATTRS,
	createNoopSpan,
	type Span,
	type Tracer,
	type TracerProvider
} from '@absolutejs/telemetry';
import { createDomainMap, createRegionDirectory, createRouter } from '../src';

const shards = [
	{ id: 's1', url: 'http://shard-1.local', weight: 1 },
	{ id: 's2', url: 'http://shard-2.local', weight: 1 }
];

type CapturedSpan = {
	name: string;
	attrs: Record<string, unknown>;
	status?: { code: number };
	ended: boolean;
};

const makeCapturingTracerProvider = () => {
	const spans: CapturedSpan[] = [];
	const makeSpan = (record: CapturedSpan): Span => {
		const noop = createNoopSpan();
		return {
			...noop,
			end: () => {
				record.ended = true;
			},
			isRecording: () => !record.ended,
			setAttribute: ((key: string, value: unknown) => {
				record.attrs[key] = value;
				return makeSpan(record);
			}) as Span['setAttribute'],
			setStatus: ((status) => {
				record.status = status;
				return makeSpan(record);
			}) as Span['setStatus']
		};
	};
	const tracer: Tracer = {
		startActiveSpan: ((name, optionsOrFn, maybeFn) => {
			const fn =
				typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
			const record: CapturedSpan = { attrs: {}, ended: false, name };
			spans.push(record);
			return (fn as (s: Span) => unknown)(makeSpan(record));
		}) as Tracer['startActiveSpan'],
		startSpan: (name, options) => {
			const record: CapturedSpan = {
				attrs: { ...(options?.attributes ?? {}) },
				ended: false,
				name
			};
			spans.push(record);
			return makeSpan(record);
		}
	};
	const provider: TracerProvider = { getTracer: () => tracer };
	return { provider, spans };
};

describe('router 0.3.0 — OTel via @absolutejs/telemetry', () => {
	test('route() emits router.route span on allow with decision + shard', () => {
		const { provider, spans } = makeCapturingTracerProvider();
		const router = createRouter({ shards, tracerProvider: provider });
		const result = router.route({ tenantId: 'tenant-A' });
		expect(result.decision).toBe('allow');
		const span = spans.find((s) => s.name === 'router.route');
		expect(span).toBeDefined();
		expect(span!.attrs[ABS_ATTRS.tenant]).toBe('tenant-A');
		expect(span!.attrs[ABS_ATTRS.routeDecision]).toBe('allow');
		expect(span!.attrs[ABS_ATTRS.routeShard]).toBe(result.shard!.id);
		expect(span!.status?.code).toBe(1);
		expect(span!.ended).toBe(true);
	});

	test('route() emits ERROR status on rejected decisions', () => {
		const { provider, spans } = makeCapturingTracerProvider();
		const router = createRouter({
			allow: () => false,
			shards,
			tracerProvider: provider
		});
		router.route({ tenantId: 'banned' });
		const span = spans.find((s) => s.name === 'router.route');
		expect(span!.attrs[ABS_ATTRS.routeDecision]).toBe('denied');
		expect(span!.attrs[ABS_ATTRS.routeShard]).toBeUndefined();
		expect(span!.status?.code).toBe(2);
	});

	test('rate-limited route still emits decision attr', () => {
		const { provider, spans } = makeCapturingTracerProvider();
		const router = createRouter({
			perTenantRateLimit: { refillPerSecond: 0, tokens: 1 },
			shards,
			tracerProvider: provider
		});
		router.route({ tenantId: 'A' }); // allow
		router.route({ tenantId: 'A' }); // rate-limited
		const routeSpans = spans.filter((s) => s.name === 'router.route');
		expect(routeSpans).toHaveLength(2);
		expect(routeSpans[0]!.attrs[ABS_ATTRS.routeDecision]).toBe('allow');
		expect(routeSpans[1]!.attrs[ABS_ATTRS.routeDecision]).toBe(
			'rate-limited'
		);
	});

	test('acquire() emits router.acquire span with active count', () => {
		const { provider, spans } = makeCapturingTracerProvider();
		const router = createRouter({ shards, tracerProvider: provider });
		router.acquire('A');
		router.acquire('A');
		const acquireSpans = spans.filter((s) => s.name === 'router.acquire');
		expect(acquireSpans).toHaveLength(2);
		expect(acquireSpans[0]!.attrs[ABS_ATTRS.tenant]).toBe('A');
		expect(acquireSpans[0]!.attrs['abs.tenant.active']).toBe(1);
		expect(acquireSpans[1]!.attrs['abs.tenant.active']).toBe(2);
	});

	test('without tracerProvider, router still works (noop)', () => {
		const router = createRouter({ shards });
		const result = router.route({ tenantId: 'A' });
		expect(result.decision).toBe('allow');
	});
});

describe('router 0.4.0 — region + domain spans', () => {
	test('regionFor emits router.region_assign on first-time assignment only', () => {
		const { provider, spans } = makeCapturingTracerProvider();
		const directory = createRegionDirectory({
			regions: [{ id: 'us-east' }, { id: 'eu-west' }],
			tracerProvider: provider
		});
		const region = directory.regionFor('tenant-A');
		directory.regionFor('tenant-A'); // steady-state — no new span
		const assignSpans = spans.filter(
			(s) => s.name === 'router.region_assign'
		);
		expect(assignSpans).toHaveLength(1);
		expect(assignSpans[0]!.attrs[ABS_ATTRS.tenant]).toBe('tenant-A');
		expect(assignSpans[0]!.attrs['abs.region']).toBe(region);
		expect(assignSpans[0]!.status?.code).toBe(1);
		expect(assignSpans[0]!.ended).toBe(true);
	});

	test('resolve emits router.domain_resolve with matched kind on hit', () => {
		const { provider, spans } = makeCapturingTracerProvider();
		const map = createDomainMap({ tracerProvider: provider });
		map.add('app.acme.com', 'acme');
		map.resolve('APP.acme.com:443');
		const span = spans.find((s) => s.name === 'router.domain_resolve');
		expect(span).toBeDefined();
		expect(span!.attrs['abs.domain.host']).toBe('app.acme.com');
		expect(span!.attrs[ABS_ATTRS.tenant]).toBe('acme');
		expect(span!.attrs['abs.domain.matched']).toBe('exact');
		expect(span!.status?.code).toBe(1);
		expect(span!.ended).toBe(true);
	});

	test('resolve emits ERROR status on a miss', () => {
		const { provider, spans } = makeCapturingTracerProvider();
		const map = createDomainMap({ tracerProvider: provider });
		map.resolve('nowhere.example.com');
		const span = spans.find((s) => s.name === 'router.domain_resolve');
		expect(span!.attrs[ABS_ATTRS.tenant]).toBeUndefined();
		expect(span!.status?.code).toBe(2);
	});

	test('without tracerProvider, directory + map still work (noop)', () => {
		const directory = createRegionDirectory({
			regions: [{ id: 'us-east' }]
		});
		expect(directory.regionFor('t')).toBe('us-east');
		const map = createDomainMap();
		map.add('a.b.com', 't');
		expect(map.resolve('a.b.com')!.tenantId).toBe('t');
	});
});
