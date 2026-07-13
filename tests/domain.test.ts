import { describe, expect, test } from 'bun:test';
import { createDomainMap } from '../src';

describe('createDomainMap — 0.4.0', () => {
	test('exact match resolves the tenant', () => {
		const map = createDomainMap();
		map.add('app.acme.com', 'acme');
		expect(map.resolve('app.acme.com')).toEqual({
			matched: 'exact',
			tenantId: 'acme'
		});
	});

	test('hostnames are case-insensitive on both add and resolve', () => {
		const map = createDomainMap();
		map.add('App.ACME.com', 'acme');
		expect(map.resolve('APP.acme.COM')!.tenantId).toBe('acme');
	});

	test('resolve strips the port', () => {
		const map = createDomainMap();
		map.add('app.acme.com', 'acme');
		expect(map.resolve('app.acme.com:443')!.tenantId).toBe('acme');
		expect(map.resolve('app.acme.com:8080')!.tenantId).toBe('acme');
	});

	test('wildcard matches exactly one label', () => {
		const map = createDomainMap();
		map.add('*.acme.com', 'acme');
		expect(map.resolve('app.acme.com')).toEqual({
			matched: 'wildcard',
			tenantId: 'acme'
		});
		// Two labels deep does NOT match.
		expect(map.resolve('a.b.acme.com')).toBeNull();
		// Neither does the bare apex.
		expect(map.resolve('acme.com')).toBeNull();
	});

	test('exact beats wildcard', () => {
		const map = createDomainMap();
		map.add('*.acme.com', 'wildcard-tenant');
		map.add('app.acme.com', 'exact-tenant');
		expect(map.resolve('app.acme.com')).toEqual({
			matched: 'exact',
			tenantId: 'exact-tenant'
		});
		expect(map.resolve('other.acme.com')!.tenantId).toBe('wildcard-tenant');
	});

	test('fallback hook serves platform subdomains as matched: fallback', () => {
		const map = createDomainMap({
			fallback: (host) => {
				const suffix = '.cloud.absolutejs.com';
				return host.endsWith(suffix)
					? host.slice(0, -suffix.length)
					: undefined;
			}
		});
		expect(map.resolve('acme.cloud.absolutejs.com')).toEqual({
			matched: 'fallback',
			tenantId: 'acme'
		});
		// Fallback returning undefined is a miss.
		expect(map.resolve('unknown.example.org')).toBeNull();
	});

	test('registered entries beat the fallback', () => {
		const map = createDomainMap({ fallback: () => 'from-fallback' });
		map.add('app.acme.com', 'acme');
		expect(map.resolve('app.acme.com')!.matched).toBe('exact');
	});

	test('resolve returns null on a miss with no fallback', () => {
		const map = createDomainMap();
		expect(map.resolve('nowhere.example.com')).toBeNull();
	});

	test('remove deletes exact and wildcard entries', () => {
		const map = createDomainMap();
		map.add('app.acme.com', 'acme');
		map.add('*.beta.com', 'beta');
		map.remove('APP.acme.com');
		map.remove('*.beta.com');
		expect(map.resolve('app.acme.com')).toBeNull();
		expect(map.resolve('x.beta.com')).toBeNull();
		expect(map.metrics().entries).toBe(0);
	});

	test('add throws on unsupported wildcard patterns', () => {
		const map = createDomainMap();
		expect(() => map.add('*', 't')).toThrow('unsupported wildcard');
		expect(() => map.add('a.*.b.com', 't')).toThrow('unsupported wildcard');
		expect(() => map.add('*.*.com', 't')).toThrow('unsupported wildcard');
	});

	test('list returns every entry, wildcards in their *. form', () => {
		const map = createDomainMap();
		map.add('app.acme.com', 'acme');
		map.add('*.beta.com', 'beta');
		expect(map.list()).toEqual([
			{ hostname: 'app.acme.com', tenantId: 'acme' },
			{ hostname: '*.beta.com', tenantId: 'beta' }
		]);
	});

	test('snapshot serializes; restore recreates exact + wildcard entries', () => {
		const map = createDomainMap();
		map.add('app.acme.com', 'acme');
		map.add('*.beta.com', 'beta');

		const json = JSON.parse(JSON.stringify(map.snapshot()));

		const next = createDomainMap();
		next.restore(json);
		expect(next.resolve('app.acme.com')!.matched).toBe('exact');
		expect(next.resolve('x.beta.com')!.matched).toBe('wildcard');
		expect(next.metrics().entries).toBe(2);
	});

	test('metrics reports entries, resolves, hits, misses, lastResolveMs', () => {
		const map = createDomainMap();
		expect(map.metrics()).toEqual({
			entries: 0,
			hits: 0,
			lastResolveMs: 0,
			misses: 0,
			resolves: 0
		});
		map.add('app.acme.com', 'acme');
		map.add('*.beta.com', 'beta');
		map.resolve('app.acme.com'); // hit (exact)
		map.resolve('x.beta.com'); // hit (wildcard)
		map.resolve('nope.example.org'); // miss
		const m = map.metrics();
		expect(m.entries).toBe(2);
		expect(m.resolves).toBe(3);
		expect(m.hits).toBe(2);
		expect(m.misses).toBe(1);
		expect(m.lastResolveMs).toBeGreaterThanOrEqual(0);
	});

	test('fallback hits count as hits in metrics', () => {
		const map = createDomainMap({ fallback: () => 'tenant' });
		map.resolve('anything.example.com');
		expect(map.metrics().hits).toBe(1);
		expect(map.metrics().misses).toBe(0);
	});
});
