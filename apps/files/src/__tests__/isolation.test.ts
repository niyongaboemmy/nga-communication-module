import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closeDb, snowflake } from '@tupo/db';
import { primaryTenantCtx, runAsPlatform, runWithTenant, runWithoutTenant, tenantRegistry, type TenantCtx } from '@tupo/tenancy';
import { canDeleteFile, internalFileFor, softDeleteFile } from '../access.js';

/**
 * School isolation audit 2026-11-25, tupo-files findings:
 *   TP-ISO-4  deleting another school's file said {deleted:true};
 *   TP-ISO-5  the internal content read ran with no school.
 * RLS only binds a non-superuser role (see apps/api tenancy.test.ts); against a
 * superuser connection the cross-school cases are skipped with a notice.
 */
const T1 = primaryTenantCtx();
const T6: TenantCtx = { tid: 6, slug: 'isofix-six', name: 'Isofix Six', status: 'ACTIVE', isPrimary: false, timezone: 'Africa/Kigali', pkg: 'starter' };
const q = (sql: string, params: unknown[] = []) => getPool().query(sql, params);

let rlsBinds = false;
const ids = { u1: snowflake(), u6: snowflake(), f1: snowflake(), f6: snowflake() };

async function seed(t: TenantCtx, userId: string, fileId: string) {
  await runWithTenant(t, async () => {
    await q(`INSERT INTO users (id, mis_user_id, name, email, role) VALUES ($1, $1, $2, $3, 'staff')`,
      [userId, `CANARY-${t.tid} owner`, `${userId}@x.test`]);
    await q(`INSERT INTO files (id, owner_id, storage_driver, storage_key, original_name, mime_type, size_bytes, status)
             VALUES ($1, $2, 'local', $3, $4, 'text/plain', 1, 'ready')`, [fileId, userId, `t${t.tid}/canary`, `CANARY-${t.tid}.txt`]);
  });
}

beforeAll(async () => {
  const { rows } = await runWithoutTenant('test', () => q(`SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`));
  rlsBinds = !rows[0]?.bypass;
  if (!rlsBinds) console.warn('[files isolation.test] superuser/BYPASSRLS connection: cross-school cases skipped. Use a non-superuser TEST_DATABASE_URL.');
  await runWithoutTenant('test', () => q(
    `INSERT INTO tenants (tid, slug, name, status, provisioned_at) VALUES ($1, $2, $3, 'ACTIVE', now()) ON CONFLICT (tid) DO NOTHING`,
    [T6.tid, T6.slug, T6.name]));
  tenantRegistry().invalidate();
  await seed(T1, ids.u1, ids.f1);
  await seed(T6, ids.u6, ids.f6);
});

afterAll(async () => {
  await runAsPlatform('test clean-up', async () => {
    await q('DELETE FROM files WHERE id = ANY($1)', [[ids.f1, ids.f6]]);
    await q('DELETE FROM users WHERE id = ANY($1)', [[ids.u1, ids.u6]]);
  });
  await runWithoutTenant('test clean-up', () => q('DELETE FROM tenants WHERE tid = $1', [T6.tid]));
  await closeDb();
});

describe('TP-ISO-4 delete answers only for a file that was really deleted', () => {
  it("another school's file: nothing changes and softDeleteFile says so (route answers 404)", async () => {
    if (!rlsBinds) return;
    // Even with FILE_DELETE_ANY the permission check passes, so the UPDATE count decides.
    expect(await runWithTenant(T6, () => canDeleteFile(ids.u6, ids.f1, true))).toBe(true);
    expect(await runWithTenant(T6, () => softDeleteFile(ids.f1))).toBe(false);
    const still = await runWithTenant(T1, () => q('SELECT deleted_at FROM files WHERE id = $1', [ids.f1]));
    expect(still.rows[0]?.deleted_at).toBeNull();
  });

  it('an unknown id is not deleted; a second delete of the same file is not either', async () => {
    expect(await runWithTenant(T6, () => softDeleteFile(snowflake()))).toBe(false);
  });
});

describe('TP-ISO-5 internal content read runs inside the named school', () => {
  it('refuses a read with no or a malformed school', async () => {
    for (const raw of [undefined, '', 'abc', '0', '-1', '1.5']) {
      expect((await internalFileFor(raw, ids.f1)).status).toBe(400);
    }
  });

  it('an unknown school is refused by the tenant gate', async () => {
    expect((await internalFileFor('99', ids.f1)).status).toBeGreaterThanOrEqual(400);
  });

  it("finds a file in its own school and not in another school's", async () => {
    expect(await internalFileFor('1', ids.f1)).toMatchObject({ status: 200, file: { storage_key: 't1/canary' } });
    expect(await internalFileFor(String(T6.tid), ids.f6)).toMatchObject({ status: 200, file: { storage_key: 't6/canary' } });
    if (!rlsBinds) return;
    expect((await internalFileFor(String(T6.tid), ids.f1)).status).toBe(404);
    expect((await internalFileFor('1', ids.f6)).status).toBe(404);
  });
});

describe('TP-ISO-4 own file', () => {
  it('the owner school deletes its own file', async () => {
    expect(await runWithTenant(T6, () => softDeleteFile(ids.f6))).toBe(true);
    expect(await runWithTenant(T6, () => softDeleteFile(ids.f6))).toBe(false);
  });
});
