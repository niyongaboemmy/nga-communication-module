import { describe, it, expect, afterAll } from 'vitest';
import { getPool, loadLocalTenants, syncLocalTenants } from '@tupo/db';
import { createMisTenantRegistry, gateTenant, runWithoutTenant, type TenantCtx } from '@tupo/tenancy';

/**
 * The local `tenants` table follows MIS (2026-11-26: a school first seen while
 * PENDING stayed PENDING here, so the realtime gateway, which read only this
 * table, refused it for ever while the API let it in).
 */
const TID = 9_471;
const ctx = (over: Partial<TenantCtx> = {}): TenantCtx => ({ tid: TID, slug: 'sync-school', name: 'Sync School', status: 'ACTIVE', isPrimary: false, timezone: 'Africa/Kigali', pkg: 'gold', ...over });
const row = async () => (await runWithoutTenant('test', () => getPool().query('SELECT slug, name, status, pkg FROM tenants WHERE tid = $1', [TID]))).rows[0];

afterAll(async () => {
  await runWithoutTenant('test', () => getPool().query('DELETE FROM tenants WHERE tid = $1', [TID]));
});

describe('local tenants follow MIS', () => {
  it('updates a stale row, leaves an equal one alone, and never creates one', async () => {
    await runWithoutTenant('test', () => getPool().query(
      `INSERT INTO tenants (tid, slug, name, status, is_primary, timezone, pkg, provisioned_at) VALUES ($1, 'sync-school', 'Old Name', 'PENDING', false, 'Africa/Kigali', 'starter', now())
       ON CONFLICT (tid) DO UPDATE SET name = 'Old Name', status = 'PENDING', pkg = 'starter'`, [TID]));

    // What the gateway saw before: the local copy says PENDING, so the school is refused.
    const localOnly = createMisTenantRegistry({ source: 'local', localLoad: () => loadLocalTenants(), ttlMs: 0 });
    expect(await gateTenant(TID, localOnly)).toMatchObject({ ok: false, code: 'TENANT_PENDING' });

    expect(await syncLocalTenants([ctx(), ctx({ tid: TID + 1, slug: 'unknown' })])).toEqual([TID]);
    expect(await row()).toEqual({ slug: 'sync-school', name: 'Sync School', status: 'ACTIVE', pkg: 'gold' });
    expect(await gateTenant(TID, localOnly)).toMatchObject({ ok: true });
    // Same again: nothing to write. A school MIS names but Tupo never provisioned is not created.
    expect(await syncLocalTenants([ctx()])).toEqual([]);
    const { rows } = await runWithoutTenant('test', () => getPool().query('SELECT 1 FROM tenants WHERE tid = $1', [TID + 1]));
    expect(rows).toHaveLength(0);
    // A suspension reaches the local copy too.
    expect(await syncLocalTenants([ctx({ status: 'SUSPENDED' })])).toEqual([TID]);
    expect(await gateTenant(TID, localOnly)).toMatchObject({ ok: false, code: 'TENANT_SUSPENDED' });
  });
});
