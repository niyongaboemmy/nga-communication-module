import { describe, it, expect, afterAll } from 'vitest';
import { getPool, closeDb, checkRlsCoverage, formatRlsCoverage } from '@tupo/db';
import { runWithoutTenant } from '@tupo/tenancy';

/**
 * The deploy's `npm run db:rls-check` against the migrated test database: the
 * real schema passes, and a table that slips through without RLS fails it.
 * Catalog-only, so it holds under a superuser connection too (CI).
 */
afterAll(async () => { await closeDb(); });

describe('db:rls-check on the migrated schema', () => {
  it('every tenant table and partition is covered, including messages_/meeting_events_ partitions', async () => {
    const r = await runWithoutTenant('test', () => checkRlsCoverage(getPool()));
    expect(r.offenders).toEqual([]);
    expect(r.ok).toBe(true);
    for (const t of ['users', 'messages', 'messages_default', 'meeting_events_default', 'error_events', 'thread_follows']) {
      expect(r.covered).toContain(t);
    }
    expect(formatRlsCoverage(r)[0]).toBe(`RLS check: ${r.covered.length} tables/partitions covered, 0 missing`);
  });

  it('fails on a new tenant table without RLS, a weak policy, and an unlisted global table (rolled back)', async () => {
    const client = await runWithoutTenant('test', () => getPool().connect());
    try {
      await client.query('BEGIN');
      await client.query('CREATE TABLE rlscheck_no_rls (id BIGINT, tenant_id BIGINT)');
      await client.query('CREATE TABLE rlscheck_weak (id BIGINT, tenant_id BIGINT)');
      await client.query('ALTER TABLE rlscheck_weak ENABLE ROW LEVEL SECURITY');
      await client.query('ALTER TABLE rlscheck_weak FORCE ROW LEVEL SECURITY');
      await client.query('CREATE POLICY tenant_isolation ON rlscheck_weak USING (true) WITH CHECK (true)');
      await client.query('CREATE TABLE rlscheck_global (id BIGINT)');
      const r = await checkRlsCoverage(client);
      expect(r.ok).toBe(false);
      expect(r.offenders).toEqual([
        'rlscheck_global: no tenant_id column and not in the global-table allowlist',
        'rlscheck_no_rls: row level security not enabled; row level security not FORCEd; no tenant_isolation policy',
        'rlscheck_weak: tenant_isolation USING does not reference tupo_tenant_id(); tenant_isolation WITH CHECK does not reference tupo_tenant_id()',
      ]);
      expect(formatRlsCoverage(r)[0]).toMatch(/^RLS check: \d+ tables\/partitions covered, 3 missing$/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
