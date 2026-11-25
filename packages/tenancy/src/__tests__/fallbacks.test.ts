import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  __resetFallbackReporting, __resetFallbacks, createMisTenantRegistry, effectiveTid, flushFallbacks, jobTid,
  legacyDefaultTid, localFallbackCounts, noteFallback, reportFallbacks, sessionTidFromClaims, setRegistryStrict,
  strictActive, strictFromRegistryBody, tenancyMode, type FallbackStore,
} from '../index.js';

/** An in-memory stand-in for the ioredis commands the counters use. */
function memStore(): FallbackStore & { hashes: Map<string, Map<string, number>>; sets: Map<string, Set<string>>; broken: boolean } {
  const hashes = new Map<string, Map<string, number>>();
  const sets = new Map<string, Set<string>>();
  const s = {
    hashes, sets, broken: false,
    async hincrby(key: string, field: string, n: number) {
      if (s.broken) throw new Error('redis down');
      const h = hashes.get(key) ?? new Map<string, number>();
      h.set(field, (h.get(field) ?? 0) + n);
      hashes.set(key, h);
      return h.get(field);
    },
    async hgetall(key: string) {
      if (s.broken) throw new Error('redis down');
      return Object.fromEntries([...(hashes.get(key) ?? new Map()).entries()].map(([k, v]) => [k, String(v)]));
    },
    async sadd(key: string, ...members: string[]) {
      if (s.broken) throw new Error('redis down');
      const set = sets.get(key) ?? new Set<string>();
      for (const m of members) set.add(m);
      sets.set(key, set);
      return members.length;
    },
    async smembers(key: string) { return [...(sets.get(key) ?? [])]; },
    async expire() { return 1; },
  };
  return s;
}

const DAY1 = Date.parse('2026-11-25T10:00:00Z');

beforeEach(() => {
  __resetFallbacks(() => DAY1);
  __resetFallbackReporting();
});
afterEach(() => {
  delete process.env.TENANCY_MODE;
  delete process.env.TENANCY_LEGACY_DEFAULT_TID;
  delete process.env.TENANCY_STRICT;
  setRegistryStrict(null);
  __resetFallbacks();
});

describe('fallback counters', () => {
  it('counts a data access with no tenant context as no_context', () => {
    expect(effectiveTid('db query')).toBe(1);
    expect(effectiveTid('db query')).toBe(1);
    const { counts, sites } = localFallbackCounts('2026-11-25');
    expect(counts).toEqual({ no_context: 2, legacy_tid: 0, payload_no_tid: 0 });
    expect(sites).toEqual(['no_context:db query']);
  });

  it('counts a job without tid as payload_no_tid, and a token without tid as legacy_tid', () => {
    expect(jobTid({})).toBe(1);
    expect(sessionTidFromClaims({ id: 'u' } as never)).toBe(1);
    expect(sessionTidFromClaims({ tid: 4 })).toBe(4);
    const { counts } = localFallbackCounts('2026-11-25');
    expect(counts).toEqual({ no_context: 0, legacy_tid: 1, payload_no_tid: 1 });
  });

  it('a token without tid under legacy "none" is refused, not counted', () => {
    process.env.TENANCY_LEGACY_DEFAULT_TID = 'none';
    expect(sessionTidFromClaims({})).toBeNull();
    expect(localFallbackCounts('2026-11-25').counts.legacy_tid).toBe(0);
  });

  it('adds every process\'s counts into one shared hash, keeping them when Redis fails', async () => {
    const store = memStore();
    noteFallback('payload_no_tid', 'chat relay');
    store.broken = true;
    await flushFallbacks(store);
    store.broken = false;
    noteFallback('payload_no_tid', 'chat relay');
    await flushFallbacks(store);
    await flushFallbacks(store); // nothing new: no double count
    expect(store.hashes.get('tupo:tenancy:fallbacks:2026-11-25')?.get('payload_no_tid')).toBe(2);
    expect([...store.sets.get('tupo:tenancy:fallback-sites:2026-11-25')!]).toEqual(['payload_no_tid:chat relay']);
  });
});

describe('report to MIS', () => {
  const capture = () => {
    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it('sends the day\'s cumulative counts with the service credentials, zeros included (heartbeat)', async () => {
    const { calls, fetchImpl } = capture();
    const out = await reportFallbacks({
      misBaseUrl: 'https://mis.test/', headers: { Authorization: 'Basic abc' }, fetchImpl, now: DAY1,
    });
    expect(out).toEqual([{ day: '2026-11-25', status: 200 }]);
    expect(calls[0]!.url).toBe('https://mis.test/platform/tenancy/fallbacks');
    expect(calls[0]!.headers.Authorization).toBe('Basic abc');
    expect(calls[0]!.body).toEqual({ app: 'tupo', day: '2026-11-25', counts: { no_context: 0, legacy_tid: 0, payload_no_tid: 0 } });
  });

  it('reports the shared totals, and yesterday\'s final counts once the day turns', async () => {
    const store = memStore();
    const { calls, fetchImpl } = capture();
    noteFallback('legacy_tid', 'session token');
    await reportFallbacks({ misBaseUrl: 'https://mis.test', headers: {}, store, fetchImpl, now: DAY1 });
    expect(calls[0]!.body.counts.legacy_tid).toBe(1);
    expect(calls[0]!.body.sites).toEqual(['legacy_tid:session token']);

    // Another process added one more before midnight, then the day turned.
    await store.hincrby('tupo:tenancy:fallbacks:2026-11-25', 'legacy_tid', 1);
    const DAY2 = DAY1 + 86_400_000;
    await reportFallbacks({ misBaseUrl: 'https://mis.test', headers: {}, store, fetchImpl, now: DAY2 });
    expect(calls.slice(1).map((c) => [c.body.day, c.body.counts.legacy_tid])).toEqual([['2026-11-25', 2], ['2026-11-26', 0]]);
  });

  it('never throws when MIS does not know the endpoint or cannot be reached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notFound = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await reportFallbacks({ misBaseUrl: 'https://mis.test', headers: {}, fetchImpl: notFound, now: DAY1 }))
      .toEqual([{ day: '2026-11-25', status: 404 }]);
    expect(await reportFallbacks({ misBaseUrl: 'https://mis.test', headers: {}, fetchImpl: down, now: DAY1 }))
      .toEqual([{ day: '2026-11-25', status: null }]);
    warn.mockRestore();
  });
});

describe('automatic strict mode', () => {
  it('reads tenancy.strict.tupo from the registry body; absent means off', () => {
    expect(strictFromRegistryBody({ tenancy: { strict: { tupo: true, mis: false } } })).toBe(true);
    expect(strictFromRegistryBody({ data: { tenancy: { strict: { tupo: true } } } })).toBe(true);
    expect(strictFromRegistryBody({ tenancy: { strict: { taskmentor: true } } })).toBe(false);
    expect(strictFromRegistryBody({ tenants: [] })).toBe(false);
  });

  it('strict = legacy none + enforce, unless TENANCY_STRICT=off', () => {
    expect(tenancyMode()).toBe('shadow');
    expect(legacyDefaultTid()).toBe(1);
    setRegistryStrict(true);
    expect(strictActive()).toBe(true);
    expect(tenancyMode()).toBe('enforce');
    expect(legacyDefaultTid()).toBeNull();
    expect(() => effectiveTid('db query')).toThrow();
    process.env.TENANCY_STRICT = 'off';
    expect(strictActive()).toBe(false);
    expect(tenancyMode()).toBe('shadow');
    expect(legacyDefaultTid()).toBe(1);
  });

  it('the registry fetch applies the flag each time MIS answers', async () => {
    let strict = true;
    const fetchImpl = (async () => new Response(JSON.stringify({
      tenants: [{ tid: 1, slug: 'nga', name: 'NGA', status: 'ACTIVE' }],
      ...(strict ? { tenancy: { strict: { tupo: true } } } : {}),
    }), { status: 200 })) as unknown as typeof fetch;
    const seen: boolean[] = [];
    const reg = createMisTenantRegistry({ misBaseUrl: 'https://mis.test', fetchImpl, ttlMs: 0, onStrict: (v) => seen.push(v) });
    await reg.list();
    strict = false; // an MIS that drops (or never had) the flag: off again
    await reg.list();
    expect(seen).toEqual([true, false]);
  });
});
