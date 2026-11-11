import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import {
  getPool, closeDb, snowflake, seedRbac, seedTenant, tenantPoolStats, __forgetProvisioned,
  checkDbRole, guardDbRole, recordError, UnsafeDbRoleError,
} from '@tupo/db';
import {
  primaryTenantCtx, runAsPlatform, runWithTenant, runWithoutTenant, tenantRegistry,
  TenantContextMissing, type TenantCtx,
} from '@tupo/tenancy';
import { app } from '../app.js';
import { config } from '../config.js';

/**
 * Multi-tenancy, Phase 6: row-level security, the tenant-scoped pool, the
 * request gates (contract §6), provisioning (§5) and tenant-bounded oversight.
 *
 * RLS only binds a role that is neither superuser nor BYPASSRLS. Run against a
 * database owned by an ordinary role, as production is (see the report /
 * packages/db/migrations/0046_tenant.sql), e.g.
 *   TEST_DATABASE_URL=postgres://tupo_mt:tupo_mt@127.0.0.1:5432/tupo_mt_test
 * Against a superuser connection the suite is skipped with a notice.
 */

const SECRET = 'test-provision-secret';
const T1 = primaryTenantCtx();
const T2: TenantCtx = { tid: 2, slug: 'hillside', name: 'Hillside School', status: 'ACTIVE', isPrimary: false, timezone: 'Africa/Kigali', pkg: 'starter' };

let rlsBinds = false;

const inT = <R>(t: TenantCtx, fn: () => Promise<R>) => runWithTenant(t, fn);
const q = <R extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  getPool().query<R>(sql, params);

async function purgeTenants(tids: number[]) {
  await runAsPlatform('test clean-up', async () => {
    for (const table of [
      'audit_log', 'message_receipts', 'messages', 'conversation_members', 'conversations', 'mail_recipients',
      'mail_messages', 'mail_threads', 'feed_page_editors', 'feed_posts', 'feed_pages', 'notifications', 'files',
      'session_revocations', 'space_members', 'users', 'spaces', 'roles',
    ]) {
      await q(`DELETE FROM ${table} WHERE tenant_id = ANY($1::bigint[])`, [tids]);
    }
  });
  await runWithoutTenant('test clean-up', () => q('DELETE FROM tenants WHERE tid = ANY($1::bigint[])', [tids]));
  __forgetProvisioned();
  tenantRegistry().invalidate();
}

function tokenFor(user: { id: string }, extra: Record<string, unknown> = {}) {
  return jwt.sign({ id: user.id, misUserId: user.id, name: 'T', email: `${user.id}@x.test`, role: 'staff', ...extra },
    config.jwtSecret, { expiresIn: '10m' });
}

async function userIn(t: TenantCtx, roleName: string | null, misUserId?: string) {
  return inT(t, async () => {
    const id = snowflake();
    const roleId = roleName ? (await q<{ id: number }>('SELECT id FROM roles WHERE name = $1', [roleName])).rows[0]?.id ?? null : null;
    await q(`INSERT INTO users (id, mis_user_id, name, email, role, role_id, academic_level, last_seen_at, last_login_at)
             VALUES ($1, $2, $3, $4, 'staff', $5, $6, now(), now())`,
      [id, misUserId ?? id, `CANARY-${t.tid} user`, `${id}@x.test`, roleId, roleName === 'Admin' ? 'super_admin' : null]);
    return { id, token: tokenFor({ id }, t.tid === 1 ? {} : { tid: t.tid }) };
  });
}

/** One canary row in each tenant-owned area: chat, mail, feed, files, notifications. */
async function canaries(t: TenantCtx, ownerId: string) {
  return inT(t, async () => {
    const space = (await q<{ id: string }>(`SELECT id FROM spaces WHERE slug = 'staff'`)).rows[0]!.id;
    const conv = snowflake();
    await q(`INSERT INTO conversations (id, space_id, type, name, created_by, member_count) VALUES ($1,$2,'group',$3,$4,1)`,
      [conv, space, `CANARY-${t.tid} group`, ownerId]);
    await q('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)', [conv, ownerId]);
    await q(`INSERT INTO messages (id, conversation_id, seq, sender_id, nonce, body) VALUES ($1,$2,1,$3,$4,$5)`,
      [snowflake(), conv, ownerId, randomBytes(6).toString('hex'), `CANARY-${t.tid} message`]);
    const thread = snowflake(); const msg = snowflake();
    await q('INSERT INTO mail_threads (id, subject) VALUES ($1,$2)', [thread, `CANARY-${t.tid} mail`]);
    await q('INSERT INTO mail_messages (id, thread_id, from_user_id, subject) VALUES ($1,$2,$3,$4)', [msg, thread, ownerId, `CANARY-${t.tid} mail`]);
    await q('INSERT INTO mail_recipients (id, message_id, thread_id, address, user_id) VALUES ($1,$2,$3,$4,$5)',
      [snowflake(), msg, thread, `${ownerId}@x.test`, ownerId]);
    const page = (await q<{ id: string }>(`SELECT id FROM feed_pages WHERE lower(slug) = 'academics'`)).rows[0]!.id;
    await q(`INSERT INTO feed_posts (id, page_id, author_id, body, status, published_at) VALUES ($1,$2,$3,$4,'published',now())`,
      [snowflake(), page, ownerId, `CANARY-${t.tid} post`]);
    await q(`INSERT INTO files (id, owner_id, storage_driver, storage_key, original_name, mime_type, size_bytes, status)
             VALUES ($1,$2,'local',$3,$4,'text/plain',1,'ready')`, [snowflake(), ownerId, `t${t.tid}/canary`, `CANARY-${t.tid}.txt`]);
    await q(`INSERT INTO notifications (id, user_id, kind, title) VALUES ($1,$2,'system',$3)`, [snowflake(), ownerId, `CANARY-${t.tid} note`]);
    return { conv };
  });
}

const AREAS: Array<[string, string]> = [
  ['users', 'SELECT name AS v FROM users'],
  ['conversations', 'SELECT name AS v FROM conversations'],
  ['messages', 'SELECT body AS v FROM messages'],
  ['mail', 'SELECT subject AS v FROM mail_messages'],
  ['feed', 'SELECT body AS v FROM feed_posts'],
  ['files', 'SELECT original_name AS v FROM files'],
  ['notifications', 'SELECT title AS v FROM notifications'],
];

let t1Admin: { id: string; token: string };
let t2Admin: { id: string; token: string };
let t1Conv: string;

beforeAll(async () => {
  const { rows } = await runWithoutTenant('test', () => q<{ bypass: boolean }>(
    `SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`));
  rlsBinds = !rows[0]?.bypass;
  if (!rlsBinds) {
    console.warn('[tenancy.test] connected as a superuser/BYPASSRLS role: RLS cannot bind, suite skipped. Use a non-superuser TEST_DATABASE_URL.');
    return;
  }
  process.env.TENANCY_PROVISION_SECRET = SECRET;
  await purgeTenants([2, 3, 4]);
  await inT(T1, () => seedRbac(getPool()));
  // Tenant 1's spaces and pages, as `npm run db:seed` makes them (idempotent).
  await seedTenant(T1);
});

afterEach(() => {
  delete process.env.TENANCY_MODE;
  delete process.env.TENANCY_LEGACY_DEFAULT_TID;
});

afterAll(async () => {
  if (rlsBinds) {
    await purgeTenants([2, 3, 4]);
    await inT(T1, async () => {
      const mine = `SELECT id FROM users WHERE name LIKE 'CANARY-%'`;
      await q(`DELETE FROM messages WHERE sender_id IN (${mine})`);
      await q(`DELETE FROM conversation_members WHERE user_id IN (${mine})`);
      await q(`DELETE FROM conversations WHERE created_by IN (${mine})`);
      await q(`DELETE FROM mail_recipients WHERE user_id IN (${mine})`);
      await q(`DELETE FROM mail_messages WHERE from_user_id IN (${mine})`);
      await q(`DELETE FROM mail_threads WHERE subject LIKE 'CANARY-%'`);
      await q(`DELETE FROM feed_posts WHERE author_id IN (${mine})`);
      await q(`DELETE FROM files WHERE owner_id IN (${mine})`);
      await q(`DELETE FROM notifications WHERE user_id IN (${mine})`);
      await q(`DELETE FROM users WHERE name LIKE 'CANARY-%'`);
    });
  }
  delete process.env.TENANCY_PROVISION_SECRET;
  await closeDb();
});

describe('provisioning endpoint (contract §5)', () => {
  it('is refused without the secret, and disabled when the secret is unset', async () => {
    if (!rlsBinds) return;
    const bad = await request(app).post('/api/integration/tenants/2/provision').set('Authorization', 'Bearer nope').send(T2);
    expect(bad.status).toBe(401);
    delete process.env.TENANCY_PROVISION_SECRET;
    const off = await request(app).post('/api/integration/tenants/2/provision').set('Authorization', `Bearer ${SECRET}`).send(T2);
    expect(off.status).toBe(503);
    process.env.TENANCY_PROVISION_SECRET = SECRET;
  });

  it('seeds a tenant once and is idempotent', async () => {
    if (!rlsBinds) return;
    const first = await request(app).post('/api/integration/tenants/2/provision').set('Authorization', `Bearer ${SECRET}`).send(T2);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, tid: 2, created: true });
    const again = await request(app).post('/api/integration/tenants/2/provision').set('Authorization', `Bearer ${SECRET}`).send(T2);
    expect(again.body).toEqual({ ok: true, tid: 2, created: false });

    const seeded = await inT(T2, async () => ({
      spaces: (await q<{ slug: string }>('SELECT slug FROM spaces ORDER BY slug')).rows.map((r) => r.slug),
      pages: (await q<{ slug: string }>('SELECT slug FROM feed_pages ORDER BY slug')).rows.map((r) => r.slug),
      roles: Number((await q<{ n: string }>('SELECT count(*) AS n FROM roles WHERE is_system')).rows[0]!.n),
      grants: Number((await q<{ n: string }>('SELECT count(*) AS n FROM role_permissions')).rows[0]!.n),
    }));
    expect(seeded.spaces).toEqual(['parents', 'staff', 'students', 'subjects']);
    expect(seeded.pages).toEqual(['academics', 'hillside-official', 'sports-clubs']);
    expect(seeded.roles).toBeGreaterThanOrEqual(5);
    expect(seeded.grants).toBeGreaterThan(0);
  });

  it('rejects a body that names another tenant', async () => {
    if (!rlsBinds) return;
    const res = await request(app).post('/api/integration/tenants/2/provision').set('Authorization', `Bearer ${SECRET}`).send({ ...T2, tid: 3 });
    expect(res.status).toBe(400);
  });
});

describe('row-level security', () => {
  it('keeps tenant 1 canaries invisible to tenant 2 in every area, and the reverse', async () => {
    if (!rlsBinds) return;
    t1Admin = await userIn(T1, 'Admin');
    t2Admin = await userIn(T2, 'Admin');
    t1Conv = (await canaries(T1, t1Admin.id)).conv;
    await canaries(T2, t2Admin.id);

    for (const [area, sql] of AREAS) {
      const in2 = (await inT(T2, () => q<{ v: string }>(sql))).rows.map((r) => r.v ?? '');
      const in1 = (await inT(T1, () => q<{ v: string }>(sql))).rows.map((r) => r.v ?? '');
      expect(in2.some((v) => v.startsWith('CANARY-1')), `${area}: tenant 1 leaked into 2`).toBe(false);
      expect(in2.some((v) => v.startsWith('CANARY-2')), `${area}: tenant 2 sees its own`).toBe(true);
      expect(in1.some((v) => v.startsWith('CANARY-2')), `${area}: tenant 2 leaked into 1`).toBe(false);
    }
    // Even by id: tenant 2 cannot reach tenant 1's conversation.
    const direct = await inT(T2, () => q('SELECT 1 FROM messages WHERE conversation_id = $1', [t1Conv]));
    expect(direct.rowCount).toBe(0);
    // Nor update or delete it.
    const upd = await inT(T2, () => q(`UPDATE conversations SET name = 'pwned' WHERE id = $1`, [t1Conv]));
    expect(upd.rowCount).toBe(0);
  });

  it('refuses to write a row into another tenant', async () => {
    if (!rlsBinds) return;
    await expect(inT(T2, () => q(`INSERT INTO spaces (id, slug, name, tenant_id) VALUES ($1, 'x', 'x', 1)`, [snowflake()])))
      .rejects.toThrow(/row-level security/);
  });

  it('allows the same natural keys in two tenants (composite uniques)', async () => {
    if (!rlsBinds) return;
    const misId = `shared-${snowflake()}`;
    await userIn(T1, null, misId);
    await userIn(T2, null, misId);
    // Same slug for spaces, feed pages, lists and role names already exists in both tenants after seeding.
    const slugs = await runAsPlatform('test', () => q<{ n: string }>(`SELECT count(DISTINCT tenant_id) AS n FROM spaces WHERE slug = 'staff'`));
    expect(Number(slugs.rows[0]!.n)).toBe(2);
    const roles = await runAsPlatform('test', () => q<{ n: string }>(`SELECT count(DISTINCT tenant_id) AS n FROM roles WHERE name = 'Admin'`));
    expect(Number(roles.rows[0]!.n)).toBe(2);
    for (const t of [T1, T2]) {
      await inT(t, () => q(`INSERT INTO mail_distribution_lists (id, slug, name) VALUES ($1, 'all-staff-canary', 'x')
                            ON CONFLICT (tenant_id, lower(slug)) DO NOTHING`, [snowflake()]));
      await inT(t, () => q(`INSERT INTO subjects (id, name) VALUES ('42', 'Maths')
                            ON CONFLICT (tenant_id, id) DO UPDATE SET name = EXCLUDED.name`));
    }
    const subj = await runAsPlatform('test', () => q<{ n: string }>(`SELECT count(*) AS n FROM subjects WHERE id = '42'`));
    expect(Number(subj.rows[0]!.n)).toBe(2);
    // Still unique inside one tenant.
    await expect(userIn(T2, null, misId)).rejects.toThrow(/duplicate key/);
    await runAsPlatform('test', async () => {
      await q(`DELETE FROM mail_distribution_lists WHERE slug = 'all-staff-canary'`);
      await q(`DELETE FROM subjects WHERE id = '42'`);
      await q(`DELETE FROM users WHERE mis_user_id = $1`, [misId]);
    });
  });

  it('fails closed with no tenant: the pool throws in enforce mode, the database refuses a raw insert', async () => {
    if (!rlsBinds) return;
    process.env.TENANCY_MODE = 'enforce';
    await expect(q('SELECT 1 FROM users')).rejects.toBeInstanceOf(TenantContextMissing);
    delete process.env.TENANCY_MODE;

    // A connection that bypasses the wrapper has no app.tenant_id at all.
    const raw = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await raw.connect();
    try {
      expect((await raw.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
      await expect(raw.query(`INSERT INTO spaces (id, slug, name) VALUES ('raw-${snowflake()}', 'raw', 'raw')`))
        .rejects.toThrow(/row-level security|null value/);
    } finally {
      await raw.end();
    }
    // runWithoutTenant: tenant tables read empty.
    const none = await runWithoutTenant('test', () => q<{ n: string }>('SELECT count(*) AS n FROM users'));
    expect(Number(none.rows[0]!.n)).toBe(0);
  });

  it('lets explicitly marked platform code see every tenant, but not insert without naming one', async () => {
    if (!rlsBinds) return;
    const seen = await runAsPlatform('test', () => q<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id FROM users WHERE name LIKE 'CANARY-%' ORDER BY 1`));
    expect(seen.rows.map((r) => Number(r.tenant_id))).toEqual([1, 2]);
    await expect(runAsPlatform('test', () => q(`INSERT INTO spaces (id, slug, name) VALUES ($1,'p','p')`, [snowflake()])))
      .rejects.toThrow(/null value|row-level security/);
    // And a tenant block nested inside a platform block is the tenant again.
    const nested = await runAsPlatform('test', () => inT(T2, () => q<{ n: string }>(`SELECT count(*) AS n FROM users WHERE name LIKE 'CANARY-1%'`)));
    expect(Number(nested.rows[0]!.n)).toBe(0);
  });

  it('applies the tenant once per connection, not per query', async () => {
    if (!rlsBinds) return;
    await inT(T1, () => q('SELECT 1'));
    const N = 1000;
    for (let i = 0; i < 50; i++) await inT(T1, () => q('SELECT id FROM users LIMIT 1'));
    const before = tenantPoolStats.switches;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) await inT(T1, () => q('SELECT id FROM users LIMIT 1'));
    const wrapped = performance.now() - t0;
    // At most one switch per pooled connection (pool max 10), none per query.
    expect(tenantPoolStats.switches - before).toBeLessThanOrEqual(10);

    // Baselines on a plain pg pool: no tenant at all, and BEGIN/set_config/COMMIT per query.
    const plain = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    try {
      for (let i = 0; i < 50; i++) await plain.query('SELECT id FROM users LIMIT 1');
      let t = performance.now();
      for (let i = 0; i < N; i++) await plain.query('SELECT id FROM users LIMIT 1');
      const bare = performance.now() - t;
      t = performance.now();
      for (let i = 0; i < N; i++) {
        const c = await plain.connect();
        try {
          await c.query(`BEGIN; SELECT set_config('app.tenant_id', '1', true)`);
          await c.query('SELECT id FROM users LIMIT 1');
          await c.query('COMMIT');
        } finally { c.release(); }
      }
      const perQueryTx = performance.now() - t;
      console.log(`[tenancy.test] ${N} queries: plain ${bare.toFixed(1)} ms, tenant pool ${wrapped.toFixed(1)} ms, BEGIN/set_config/COMMIT ${perQueryTx.toFixed(1)} ms`);
    } finally {
      await plain.end();
    }
  });
});

describe('request gates (contract §6)', () => {
  it('runs a session in its own tenant: the directory and oversight see only that school', async () => {
    if (!rlsBinds) return;
    const list = await request(app).get('/api/oversight/conversations').set('Authorization', `Bearer ${t2Admin.token}`);
    expect(list.status).toBe(200);
    const body = JSON.stringify(list.body);
    expect(body).toContain('CANARY-2');
    expect(body).not.toContain('CANARY-1');

    const peek = await request(app).get(`/api/oversight/conversations/${t1Conv}/messages?reason=conduct%20review`).set('Authorization', `Bearer ${t2Admin.token}`);
    expect(peek.status).toBe(404);
    expect(JSON.stringify(peek.body)).not.toContain('CANARY-1');

    const stats = await request(app).get('/api/oversight/stats').set('Authorization', `Bearer ${t2Admin.token}`);
    expect(stats.status).toBe(200);

    const dash = await request(app).get('/api/dashboard/overview').set('Authorization', `Bearer ${t2Admin.token}`);
    expect(dash.status).toBe(200);
    const total2 = await inT(T2, () => q<{ n: string }>(`SELECT count(*) AS n FROM users WHERE status = 'active'`));
    expect(dash.body.data.people.total).toBeLessThanOrEqual(Number(total2.rows[0]!.n));

    const dir = await request(app).get('/api/users').set('Authorization', `Bearer ${t2Admin.token}`);
    expect(dir.status).toBe(200);
    expect(JSON.stringify(dir.body)).not.toContain('CANARY-1');
  });

  it('treats a legacy token (no tid) as tenant 1, and refuses it once legacy tokens are off', async () => {
    if (!rlsBinds) return;
    const legacy = tokenFor(t1Admin);
    expect((await request(app).get('/api/sso/me').set('Authorization', `Bearer ${legacy}`)).status).toBe(200);
    process.env.TENANCY_LEGACY_DEFAULT_TID = 'none';
    const res = await request(app).get('/api/sso/me').set('Authorization', `Bearer ${legacy}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TENANT_REQUIRED');
  });

  it('does not let a tenant-1 user id authenticate as tenant 2', async () => {
    if (!rlsBinds) return;
    const forged = tokenFor(t1Admin, { tid: 2 });
    const res = await request(app).get('/api/sso/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('answers TENANT_UNKNOWN, TENANT_PENDING and TENANT_SUSPENDED', async () => {
    if (!rlsBinds) return;
    const unknown = await request(app).get('/api/sso/me').set('Authorization', `Bearer ${tokenFor(t2Admin, { tid: 99 })}`);
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('TENANT_UNKNOWN');

    for (const [tid, status, code] of [[3, 'PENDING', 'TENANT_PENDING'], [4, 'SUSPENDED', 'TENANT_SUSPENDED']] as const) {
      const p = await request(app).post(`/api/integration/tenants/${tid}/provision`).set('Authorization', `Bearer ${SECRET}`)
        .send({ ...T2, tid, slug: `school-${tid}`, name: `School ${tid}`, status });
      expect(p.status).toBe(200);
      const res = await request(app).get('/api/sso/me').set('Authorization', `Bearer ${tokenFor(t2Admin, { tid })}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(code);
    }
  });

  it('answers TENANT_MISMATCH when the MIS token inside the session names another school', async () => {
    if (!rlsBinds) return;
    const misToken = jwt.sign({ sub: '1', tid: 1 }, 'mis-secret');
    const res = await request(app).get('/api/sso/me').set('Authorization', `Bearer ${tokenFor(t2Admin, { tid: 2, misToken })}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TENANT_MISMATCH');

    const same = jwt.sign({ sub: '1', tid: 2 }, 'mis-secret');
    const ok = await request(app).get('/api/sso/me').set('Authorization', `Bearer ${tokenFor(t2Admin, { tid: 2, misToken: same })}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.id).toBe(t2Admin.id);
  });
});

describe('System page is per school (security review)', () => {
  it('records each school\'s errors under its tenant and shows an admin only its own', async () => {
    if (!rlsBinds) return;
    const clean = () => runAsPlatform('test clean-up', () => q(`DELETE FROM error_events WHERE message LIKE 'CANARY-%'`));
    await clean();
    // Same text shape, so the same fingerprint: two schools still get two rows.
    for (const [who, msg] of [[t2Admin, 'CANARY-2 crash'], [t1Admin, 'CANARY-1 crash']] as const) {
      const r = await request(app).post('/api/system/client-errors').set('Authorization', `Bearer ${who.token}`).send({ message: msg, route: '/app/x' });
      expect(r.status).toBe(202);
    }
    await recordError({ source: 'api', message: 'CANARY-process crash' }); // no context: process-level
    await new Promise((r) => setTimeout(r, 200));
    const stored = await runAsPlatform('test', () => q<{ message: string; tenant_id: string | null }>(
      `SELECT message, tenant_id FROM error_events WHERE message LIKE 'CANARY-%' ORDER BY message`));
    expect(stored.rows).toEqual([
      { message: 'CANARY-1 crash', tenant_id: '1' },
      { message: 'CANARY-2 crash', tenant_id: '2' },
      { message: 'CANARY-process crash', tenant_id: null },
    ]);

    const list = async (who: { token: string }) => {
      const res = await request(app).get('/api/system/errors?status=all').set('Authorization', `Bearer ${who.token}`);
      expect(res.status).toBe(200);
      return res.body.data.errors as Array<{ message: string; fingerprint: string; scope: string }>;
    };
    const seen2 = (await list(t2Admin)).map((e) => e.message);
    expect(seen2).toContain('CANARY-2 crash');
    expect(seen2).not.toContain('CANARY-1 crash');
    expect(seen2).not.toContain('CANARY-process crash');
    const errs1 = await list(t1Admin);
    expect(errs1.map((e) => e.message)).toEqual(expect.arrayContaining(['CANARY-1 crash', 'CANARY-process crash']));
    expect(errs1.map((e) => e.message)).not.toContain('CANARY-2 crash');
    expect(errs1.find((e) => e.message === 'CANARY-process crash')?.scope).toBe('process');

    // Tenant 2 cannot triage tenant 1's or the process-level rows.
    const procFp = errs1.find((e) => e.message === 'CANARY-process crash')!.fingerprint;
    const fp1 = errs1.find((e) => e.message === 'CANARY-1 crash')!.fingerprint;
    for (const fp of [procFp]) {
      const res = await request(app).patch(`/api/system/errors/${fp}`).set('Authorization', `Bearer ${t2Admin.token}`).send({ status: 'ignored' });
      expect(res.status).toBe(404);
    }
    // fp1 equals tenant 2's own fingerprint: resolving it touches only tenant 2's row.
    const own = await request(app).patch(`/api/system/errors/${fp1}`).set('Authorization', `Bearer ${t2Admin.token}`).send({ status: 'resolved' });
    expect(own.status).toBe(200);
    const after = await runAsPlatform('test', () => q<{ message: string; status: string }>(
      `SELECT message, status FROM error_events WHERE message LIKE 'CANARY-%' ORDER BY message`));
    expect(after.rows.map((r) => r.status)).toEqual(['open', 'resolved', 'open']);

    // The database itself: a tenant connection never sees another school's or process-level rows,
    // and cannot write one.
    expect((await inT(T2, () => q(`SELECT 1 FROM error_events WHERE tenant_id IS DISTINCT FROM 2`))).rowCount).toBe(0);
    await expect(inT(T2, () => q(
      `INSERT INTO error_events (fingerprint, source, message, tenant_id) VALUES ('canaryfp', 'web', 'CANARY-forged', 1)`))).rejects.toThrow(/row-level security/);
    await expect(inT(T2, () => q(
      `INSERT INTO error_events (fingerprint, source, message) VALUES ('canaryfp', 'web', 'CANARY-forged')`))).rejects.toThrow(/row-level security/);
    await clean();
  });

  it('keeps host metrics and alert state for the primary tenant', async () => {
    if (!rlsBinds) return;
    await runWithoutTenant('test', () => q(
      `INSERT INTO alert_state (rule, firing, detail) VALUES ('canary_rule', true, 'CANARY-alert')
       ON CONFLICT (rule) DO UPDATE SET firing = true, detail = 'CANARY-alert'`));
    try {
      const a2 = await request(app).get('/api/system/alerts').set('Authorization', `Bearer ${t2Admin.token}`);
      expect(a2.status).toBe(200);
      expect(a2.body.data).toEqual({ alerts: [], platformOnly: true });
      const m2 = await request(app).get('/api/system/metrics').set('Authorization', `Bearer ${t2Admin.token}`);
      expect(m2.body.data.series).toEqual({});
      expect(m2.body.data.platformOnly).toBe(true);
      const a1 = await request(app).get('/api/system/alerts').set('Authorization', `Bearer ${t1Admin.token}`);
      expect(JSON.stringify(a1.body)).toContain('CANARY-alert');
    } finally {
      await runWithoutTenant('test', () => q(`DELETE FROM alert_state WHERE rule = 'canary_rule'`));
    }
  });
});

describe('database role startup guard', () => {
  const fakePool = (row: Record<string, unknown>) => ({ query: async () => ({ rows: [row] }) }) as unknown as pg.Pool;
  const superuser = fakePool({ role: 'postgres', superuser: true, bypass_rls: true, inherits_platform: true });
  const bypass = fakePool({ role: 'tupo', superuser: false, bypass_rls: true, inherits_platform: false });
  const inheriting = fakePool({ role: 'tupo', superuser: false, bypass_rls: false, inherits_platform: true });

  it('passes the ordinary app role the suite runs as', async () => {
    if (!rlsBinds) return;
    const info = await checkDbRole();
    expect(info).toMatchObject({ superuser: false, bypassRls: false, inheritsPlatform: false });
    expect(await guardDbRole('test', { mode: 'enforce' })).toMatchObject({ role: info.role });
  });

  it('refuses a superuser, BYPASSRLS or platform-inheriting role in enforce mode', async () => {
    for (const [p, why] of [[superuser, /SUPERUSER/], [bypass, /BYPASSRLS/], [inheriting, /inherits tupo_platform/]] as const) {
      await expect(guardDbRole('test', { pool: p, mode: 'enforce' })).rejects.toThrow(UnsafeDbRoleError);
      await expect(guardDbRole('test', { pool: p, mode: 'enforce' })).rejects.toThrow(why);
    }
  });

  it('only warns, loudly, in shadow mode', async () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    try {
      expect(await guardDbRole('test', { pool: bypass, mode: 'shadow' })).toMatchObject({ bypassRls: true });
    } finally {
      console.error = orig;
    }
    expect(errors.join('\n')).toMatch(/WARNING: .*BYPASSRLS/);
  });

  it('re-checks in the background when the database is unreachable, and exits then if unsafe', async () => {
    let calls = 0;
    const flaky = { query: async () => { calls++; if (calls === 1) throw new Error('down'); return { rows: [{ role: 'postgres', superuser: true, bypass_rls: true, inherits_platform: false }] }; } } as unknown as pg.Pool;
    const refused: string[] = [];
    const warn = console.warn; console.warn = () => {};
    try {
      expect(await guardDbRole('test', { pool: flaky, mode: 'enforce', retryMs: 10, onUnsafe: (e) => refused.push(e.message) })).toBeNull();
      await new Promise((r) => setTimeout(r, 60));
    } finally { console.warn = warn; }
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/refusing to start/);
  });
});
