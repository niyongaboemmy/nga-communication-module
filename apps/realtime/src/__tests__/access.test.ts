import { describe, it, expect, vi } from 'vitest';
import { createAccessCache, decideAccess, type UserAccess } from '../access.js';

const active: UserAccess = { status: 'active', permissions: new Set(['MESSAGE_SEND']) };
const suspended: UserAccess = { status: 'suspended', permissions: new Set(['MESSAGE_SEND']) };

describe('decideAccess — the handshake rule', () => {
  it('admits an active account', () => {
    const d = decideAccess(active);
    expect(d.ok).toBe(true);
  });

  it('rejects a suspended account', () => {
    const d = decideAccess(suspended);
    expect(d).toMatchObject({ ok: false, reason: 'suspended' });
    if (!d.ok) expect(d.message).toMatch(/suspended/);
  });

  it('rejects a token whose user row no longer exists', () => {
    expect(decideAccess(null)).toMatchObject({ ok: false, reason: 'unknown_user' });
  });
});

describe('createAccessCache', () => {
  it('serves from cache inside the TTL and reloads after it', async () => {
    let t = 0;
    let state: UserAccess = active;
    const load = vi.fn(async () => state);
    const cache = createAccessCache({ load, ttlMs: 30_000, now: () => t });

    expect((await cache.get('u1')).ok).toBe(true);
    state = suspended;
    t = 10_000;
    // Still cached: the suspension has not been seen yet.
    expect((await cache.get('u1')).ok).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);

    t = 31_000;
    expect(await cache.get('u1')).toMatchObject({ ok: false, reason: 'suspended' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('fresh lookups (the handshake) bypass the cache', async () => {
    let state: UserAccess = active;
    const cache = createAccessCache({ load: async () => state, ttlMs: 60_000 });
    expect((await cache.get('u1')).ok).toBe(true);
    state = suspended;
    expect(await cache.get('u1', { fresh: true })).toMatchObject({ ok: false, reason: 'suspended' });
  });

  it('does not cache a failed lookup', async () => {
    let fail = true;
    const load = vi.fn(async () => { if (fail) throw new Error('db down'); return active; });
    const cache = createAccessCache({ load, ttlMs: 60_000 });
    await expect(cache.get('u1')).rejects.toThrow('db down');
    fail = false;
    expect((await cache.get('u1')).ok).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('invalidate forces the next lookup to reload', async () => {
    const load = vi.fn(async () => active);
    const cache = createAccessCache({ load, ttlMs: 60_000 });
    await cache.get('u1');
    cache.invalidate('u1');
    await cache.get('u1');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
