import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { getPool, closeDb, snowflake, seedRbac, seedTenant, releasedInTransaction, clientInTransaction } from '@tupo/db';
import { visibleUserIds } from '@tupo/chat';
import { primaryTenantCtx, runAsPlatform, runWithTenant, runWithoutTenant, tenantRegistry, type TenantCtx } from '@tupo/tenancy';
import { app } from '../app.js';
import { config } from '../config.js';

/**
 * Cross-school check (school isolation audit 2026-11-25, kept as a regression
 * suite): the catalog says every school-owned table AND partition is under
 * FORCE RLS, the app role in one school reads 0 rows of the other from every
 * table, and every GET route of the API, called with one school's token and
 * the other school's ids, never returns the other school's canary marker.
 * Also: TP-ISO-2 (presence visibility), TP-ISO-3 (partition RLS, incl. new
 * partitions), TP-ISO-6 (a client released mid-transaction).
 *
 * ISOLATION_SWEEP_ALL=1 also sends every POST/PUT/PATCH/DELETE route with the
 * other school's ids and checks the other school's rows are byte-for-byte
 * unchanged (slow; for audits).
 *
 * RLS only binds a non-superuser role: run with a TEST_DATABASE_URL owned by
 * an ordinary role (see tenancy.test.ts). Against a superuser it is skipped.
 */
const T1 = primaryTenantCtx();
const T5: TenantCtx = { tid: 5, slug: 'isofix-five', name: 'Isofix Five', status: 'ACTIVE', isPrimary: false, timezone: 'Africa/Kigali', pkg: 'starter' };
const MARK = (t: TenantCtx) => `ISOCANARY-${t.tid}`;

/** Tables with no tenant_id by design (global). A new one must be added here on purpose. */
const GLOBAL_TABLES = ['_migrations', 'alert_state', 'link_previews', 'metric_samples', 'permissions', 'tenants'];

const q = <R extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) => getPool().query<R>(sql, params);
const inT = <R>(t: TenantCtx, fn: () => Promise<R>) => runWithTenant(t, fn);

let rlsBinds = false;
interface School { t: TenantCtx; admin: { id: string; token: string }; ids: Record<string, string> }
const schools: School[] = [];

async function tenantTables(): Promise<Array<{ name: string; partition: boolean }>> {
  const { rows } = await runWithoutTenant('catalog', () => q<{ relname: string; relispartition: boolean }>(
    `SELECT c.relname, c.relispartition FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      ORDER BY 1`));
  return rows.map((r) => ({ name: r.relname, partition: r.relispartition }));
}

async function makeSchool(t: TenantCtx): Promise<School> {
  if (t.tid !== 1) await seedTenant(t);
  else { await inT(t, () => seedRbac(getPool())); await seedTenant(t); }
  return inT(t, async () => {
    const id = snowflake();
    const roleId = (await q<{ id: number }>(`SELECT id FROM roles WHERE name = 'Admin'`)).rows[0]?.id ?? null;
    await q(`INSERT INTO users (id, mis_user_id, name, email, role, role_id, academic_level, last_seen_at)
             VALUES ($1, $1, $2, $3, 'staff', $4, 'super_admin', now())`, [id, `${MARK(t)} admin`, `${id}@x.test`, roleId]);
    const token = jwt.sign({ id, misUserId: id, name: 'Iso', email: `${id}@x.test`, role: 'staff', tid: t.tid }, config.jwtSecret, { expiresIn: '30m' });
    const space = (await q<{ id: string }>(`SELECT id FROM spaces WHERE slug = 'staff'`)).rows[0]!.id;
    const conv = snowflake(); const msg = snowflake(); const thread = snowflake(); const mail = snowflake();
    const post = snowflake(); const file = snowflake(); const note = snowflake();
    await q(`INSERT INTO conversations (id, space_id, type, name, created_by, member_count) VALUES ($1,$2,'group',$3,$4,1)`, [conv, space, `${MARK(t)} group`, id]);
    await q('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)', [conv, id]);
    await q('INSERT INTO messages (id, conversation_id, seq, sender_id, nonce, body) VALUES ($1,$2,1,$3,$4,$5)',
      [msg, conv, id, randomBytes(6).toString('hex'), `${MARK(t)} message`]);
    await q('INSERT INTO mail_threads (id, subject) VALUES ($1,$2)', [thread, `${MARK(t)} mail`]);
    await q('INSERT INTO mail_messages (id, thread_id, from_user_id, subject) VALUES ($1,$2,$3,$4)', [mail, thread, id, `${MARK(t)} mail`]);
    await q('INSERT INTO mail_recipients (id, message_id, thread_id, address, user_id) VALUES ($1,$2,$3,$4,$5)', [snowflake(), mail, thread, `${id}@x.test`, id]);
    const page = (await q<{ id: string }>(`SELECT id FROM feed_pages WHERE lower(slug) = 'academics'`)).rows[0]!.id;
    await q(`INSERT INTO feed_posts (id, page_id, author_id, body, status, published_at) VALUES ($1,$2,$3,$4,'published',now())`, [post, page, id, `${MARK(t)} post`]);
    await q(`INSERT INTO files (id, owner_id, storage_driver, storage_key, original_name, mime_type, size_bytes, status)
             VALUES ($1,$2,'local',$3,$4,'text/plain',1,'ready')`, [file, id, `t${t.tid}/isocanary`, `${MARK(t)}.txt`]);
    await q(`INSERT INTO notifications (id, user_id, kind, title) VALUES ($1,$2,'system',$3)`, [note, id, `${MARK(t)} note`]);
    return { t, admin: { id, token }, ids: { user: id, conv, msg, thread, mail, post, page, file, note } };
  });
}

beforeAll(async () => {
  const { rows } = await runWithoutTenant('test', () => q<{ bypass: boolean }>(
    `SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`));
  rlsBinds = !rows[0]?.bypass;
  if (!rlsBinds) {
    console.warn('[schoolIsolation.test] superuser/BYPASSRLS connection: RLS cannot bind, suite skipped. Use a non-superuser TEST_DATABASE_URL.');
    return;
  }
  // No outside calls (MIS, AI, unfurl): fail fast instead of hanging a route.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
  tenantRegistry().invalidate();
  schools.push(await makeSchool(T1), await makeSchool(T5));
  // A meeting in each school, through the API. Members-only: a public meeting's
  // /public card is world-readable by design (guests have no account).
  for (const s of schools) {
    const res = await request(app).post('/api/meet/instant').set('Authorization', `Bearer ${s.admin.token}`)
      .send({ title: `${MARK(s.t)} meeting`, settings: { admissionPolicy: 'permission' } });
    expect(res.status).toBe(201);
    s.ids.meeting = res.body.data.id;
    s.ids.code = res.body.data.join_code;
  }
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (rlsBinds) {
    // Every row of tenant 5, parents only (partitions go with them); FK order by retrying.
    const tables = (await tenantTables()).filter((t) => !t.partition).map((t) => t.name);
    await runAsPlatform('test clean-up', async () => {
      for (let pass = 0; pass < 8; pass++) {
        let failed = 0;
        for (const table of tables) {
          try { await q(`DELETE FROM ${table} WHERE tenant_id = 5`); } catch { failed++; }
        }
        if (!failed) break;
      }
    });
    await runWithoutTenant('test clean-up', () => q('DELETE FROM tenants WHERE tid = 5'));
    const s1 = schools[0];
    if (s1) {
      await inT(T1, async () => {
        const me = s1.admin.id;
        await q('DELETE FROM meeting_participants WHERE meeting_id IN (SELECT id FROM meetings WHERE host_id = $1)', [me]);
        await q('DELETE FROM meetings WHERE host_id = $1', [me]);
        await q('DELETE FROM messages WHERE sender_id = $1', [me]);
        await q('DELETE FROM conversation_members WHERE user_id = $1', [me]);
        await q('DELETE FROM conversations WHERE created_by = $1', [me]);
        await q('DELETE FROM mail_recipients WHERE user_id = $1', [me]);
        await q('DELETE FROM mail_messages WHERE from_user_id = $1', [me]);
        await q('DELETE FROM mail_threads WHERE id = $1', [s1.ids.thread]);
        await q('DELETE FROM feed_posts WHERE author_id = $1', [me]);
        await q('DELETE FROM files WHERE owner_id = $1', [me]);
        await q('DELETE FROM users WHERE id = $1', [me]);
      }).catch((e) => console.warn('[schoolIsolation.test] clean-up:', (e as Error).message));
    }
    tenantRegistry().invalidate();
  }
  await closeDb();
});

describe('catalog: every school-owned table and partition is under FORCE RLS', () => {
  it('relrowsecurity + relforcerowsecurity + tenant_isolation policy on every table with tenant_id (TP-ISO-3)', async () => {
    if (!rlsBinds) return;
    const { rows } = await runWithoutTenant('catalog', () => q<{ relname: string; rls: boolean; force: boolean; has_tenant: boolean; policy: boolean; partition: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force, c.relispartition AS partition,
              EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`));
    const unprotected = rows.filter((r) => r.has_tenant && !(r.rls && r.force && r.policy)).map((r) => r.relname);
    expect(unprotected).toEqual([]);
    expect(rows.filter((r) => !r.has_tenant).map((r) => r.relname).sort()).toEqual(GLOBAL_TABLES);
    expect(rows.filter((r) => r.partition && /^(messages|meeting_events)_/.test(r.relname)).length).toBeGreaterThanOrEqual(4);
  });
});

describe('row counts: the app role in one school reads 0 rows of the other, from every table and partition', () => {
  it('both directions', async () => {
    if (!rlsBinds) return;
    const tables = await tenantTables();
    for (const [me, other] of [[T1, T5], [T5, T1]] as const) {
      const leaks: string[] = [];
      for (const { name } of tables) {
        const n = Number((await inT(me, () => q<{ n: string }>(`SELECT count(*) AS n FROM ${name} WHERE tenant_id = $1`, [other.tid]))).rows[0]!.n);
        if (n) leaks.push(`${name}=${n}`);
      }
      expect(leaks, `tenant ${me.tid} sees tenant ${other.tid}`).toEqual([]);
    }
    // And the other school's rows do exist (the check is not vacuous).
    const seen = await runAsPlatform('test', () => q<{ n: string }>(`SELECT count(*) AS n FROM messages WHERE body LIKE 'ISOCANARY-%'`));
    expect(Number(seen.rows[0]!.n)).toBe(2);
  });
});

describe('TP-ISO-3 partitions read directly', () => {
  it("as tenant 5, selecting from a messages partition returns 0 of school 1's rows; writing one is refused", async () => {
    if (!rlsBinds) return;
    const part = (await runAsPlatform('test', () => q<{ part: string }>(
      `SELECT tableoid::regclass::text AS part FROM messages WHERE id = $1`, [schools[0]!.ids.msg]))).rows[0]!.part;
    expect(part).toMatch(/^messages_/);
    expect((await inT(T5, () => q(`SELECT 1 FROM ${part} WHERE tenant_id = 1`))).rowCount).toBe(0);
    expect((await inT(T5, () => q(`SELECT 1 FROM messages_default WHERE tenant_id = 1`))).rowCount).toBe(0);
    expect((await inT(T1, () => q(`SELECT 1 FROM ${part} WHERE id = $1`, [schools[0]!.ids.msg]))).rowCount).toBe(1);
    await expect(inT(T5, () => q(`UPDATE ${part} SET body = 'pwned' WHERE id = $1 RETURNING 1`, [schools[0]!.ids.msg])))
      .resolves.toMatchObject({ rowCount: 0 });
    await expect(inT(T5, () => q(
      `INSERT INTO ${part} (id, conversation_id, seq, sender_id, nonce, body, tenant_id) VALUES ($1, $2, 99, $3, 'x', 'forged', 1)`,
      [snowflake(), schools[0]!.ids.conv, schools[0]!.ids.user]))).rejects.toThrow(/row-level security/);
  });

  it('partitions:ensure secures new partitions and still moves stragglers out of the (now RLS) default', async () => {
    if (!rlsBinds) return;
    const before = new Set((await tenantTables()).map((t) => t.name));
    // A message dated 7 months ahead has no partition yet: it lands in the default.
    const ahead = await runWithoutTenant('t', () => q<{ month: string; at: string }>(
      `SELECT to_char(date_trunc('month', now()) + interval '7 month', 'YYYY_MM') AS month,
              (date_trunc('month', now()) + interval '7 month' + interval '3 day')::text AS at`));
    const { month, at } = ahead.rows[0]!;
    const straggler = snowflake();
    await inT(T1, () => q(`INSERT INTO messages (id, conversation_id, seq, sender_id, nonce, body, created_at)
                           VALUES ($1, $2, 2, $3, 'straggler', 'ISOCANARY-1 straggler', $4)`,
      [straggler, schools[0]!.ids.conv, schools[0]!.ids.user, at]));
    expect((await inT(T1, () => q(`SELECT tableoid::regclass::text AS p FROM messages WHERE id = $1`, [straggler]))).rows[0]!.p).toBe('messages_default');

    // As the worker runs it: the app role, no tenant.
    const created = Number((await runWithoutTenant('job partitions:ensure', () => q<{ n: number }>('SELECT tupo_ensure_partitions(7) AS n'))).rows[0]!.n);
    expect(created).toBeGreaterThan(0);
    try {
      const where = await inT(T1, () => q<{ p: string }>(`SELECT tableoid::regclass::text AS p FROM messages WHERE id = $1`, [straggler]));
      expect(where.rows[0]!.p).toBe(`messages_${month}`);
      const fresh = (await tenantTables()).map((t) => t.name).filter((n) => !before.has(n));
      expect(fresh).toContain(`messages_${month}`);
      expect(fresh).toContain(`meeting_events_${month}`);
      const cat = await runWithoutTenant('catalog', () => q<{ relname: string; rls: boolean; force: boolean; policies: number }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
                (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname IN ('tenant_isolation', 'platform_access')) AS policies
           FROM pg_class c WHERE c.relname = ANY($1::text[])`, [[...fresh, 'messages_default', 'meeting_events_default']]));
      for (const r of cat.rows) expect(r, r.relname).toMatchObject({ rls: true, force: true, policies: 2 });
      expect((await inT(T5, () => q(`SELECT 1 FROM messages_${month}`))).rowCount).toBe(0);
    } finally {
      await inT(T1, () => q('DELETE FROM messages WHERE id = $1', [straggler]));
      const fresh = (await tenantTables()).map((t) => t.name).filter((n) => !before.has(n));
      await runWithoutTenant('test clean-up', async () => { for (const n of fresh) await q(`DROP TABLE IF EXISTS ${n}`); });
    }
  });
});

describe('TP-ISO-2 presence visibility', () => {
  it('visibleUserIds returns only people of the current school', async () => {
    if (!rlsBinds) return;
    const [s1, s5] = schools as [School, School];
    expect([...await inT(T5, () => visibleUserIds([s1.ids.user!, s5.ids.user!, 'nobody']))]).toEqual([s5.ids.user]);
    expect([...await inT(T1, () => visibleUserIds([s1.ids.user!, s5.ids.user!]))]).toEqual([s1.ids.user]);
  });
});

describe('TP-ISO-6 a client released inside an open transaction is destroyed, not reused', () => {
  it('another school never inherits the transaction or its SET LOCAL', async () => {
    if (!rlsBinds) return;
    const before = releasedInTransaction.count;
    const client = await inT(T1, () => getPool().connect());
    await client.query('BEGIN');
    // Inside the transaction, a local switch the cache knows nothing about.
    await client.query(`SELECT set_config('app.tenant_id', '1', true)`);
    expect(clientInTransaction(client)).toBe(true);
    client.release();
    expect(releasedInTransaction.count).toBe(before + 1);
    // Every pooled connection now answers tenant 5 for tenant 5, with no open transaction.
    for (let i = 0; i < 12; i++) {
      const r = await inT(T5, () => q<{ tid: string; tx: string }>(
        `SELECT current_setting('app.tenant_id') AS tid, (SELECT count(*) FROM users WHERE tenant_id = 1)::text AS tx`));
      expect(r.rows[0]).toEqual({ tid: '5', tx: '0' });
    }
    // A client released idle is reused as before.
    const idle = await inT(T5, () => getPool().connect());
    expect(clientInTransaction(idle)).toBe(false);
    idle.release();
    expect(releasedInTransaction.count).toBe(before + 1);
  });
});

/* ── API sweep ──────────────────────────────────────────────────────────── */

type Layer = { route?: { path: string; methods: Record<string, boolean> }; name?: string; handle?: { stack?: Layer[] }; regexp?: RegExp & { fast_slash?: boolean } };

function mountPath(layer: Layer): string {
  if (!layer.regexp || layer.regexp.fast_slash) return '';
  return layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/').replace(/\?\(\?=.*$/, '');
}

function routes(stack: Layer[], prefix = ''): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const [m, on] of Object.entries(layer.route.methods)) if (on && m !== '_all') out.push({ method: m, path: prefix + layer.route.path });
    } else if (layer.name === 'router' && layer.handle?.stack) {
      out.push(...routes(layer.handle.stack, prefix + mountPath(layer)));
    }
  }
  return out;
}

function fill(path: string, id: string): string {
  return path.replace(/:([A-Za-z0-9_]+)(\([^)]*\))?\??/g, () => encodeURIComponent(id));
}

async function checksum(t: TenantCtx): Promise<Record<string, string>> {
  const tables = (await tenantTables()).filter((x) => !x.partition).map((x) => x.name);
  const out: Record<string, string> = {};
  await runAsPlatform('checksum', async () => {
    for (const name of tables) {
      const r = await q<{ h: string | null }>(`SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) AS h FROM ${name} x WHERE tenant_id = $1`, [t.tid]);
      out[name] = r.rows[0]!.h ?? '';
    }
  });
  return out;
}

describe('API sweep: every route with the other school\'s token and ids', () => {
  it('no GET answer carries the other school\'s canary (both directions)', async () => {
    if (!rlsBinds) return;
    const all = routes((app as unknown as { _router: { stack: Layer[] } })._router.stack);
    const gets = all.filter((r) => r.method === 'get');
    expect(gets.length).toBeGreaterThan(100);
    const leaks: string[] = [];
    let sent = 0;
    for (const [me, other] of [[schools[1]!, schools[0]!], [schools[0]!, schools[1]!]] as const) {
      const candidates = [...new Set(Object.values(other.ids))];
      for (const r of gets) {
        const paths = r.path.includes(':') ? candidates.map((id) => fill(r.path, id)) : [r.path];
        for (const p of paths) {
          const res = await request(app).get(p).set('Authorization', `Bearer ${me.admin.token}`);
          sent++;
          if ((res.text ?? '').includes(MARK(other.t))) leaks.push(`${me.t.tid}->${other.t.tid} GET ${p} ${res.status}`);
        }
      }
    }
    // Control: the same sweep with a school's own ids does find its marker, so
    // the check above is not vacuous.
    let own = 0;
    for (const me of schools) {
      const candidates = [...new Set(Object.values(me.ids))];
      for (const r of gets) {
        const paths = r.path.includes(':') ? candidates.map((id) => fill(r.path, id)) : [r.path];
        for (const p of paths) {
          const res = await request(app).get(p).set('Authorization', `Bearer ${me.admin.token}`);
          if ((res.text ?? '').includes(MARK(me.t))) own++;
        }
      }
    }
    console.log(`[schoolIsolation.test] GET sweep: ${gets.length} routes, ${sent} cross-school requests, ${own} own-school answers with the marker`);
    expect(leaks).toEqual([]);
    expect(own).toBeGreaterThan(20);
  }, 300_000);

  it.runIf(process.env.ISOLATION_SWEEP_ALL === '1')('no write route changes the other school\'s rows (both directions)', async () => {
    if (!rlsBinds) return;
    const all = routes((app as unknown as { _router: { stack: Layer[] } })._router.stack);
    const writes = all.filter((r) => r.method !== 'get' && r.method !== 'head' && r.method !== 'options');
    const leaks: string[] = [];
    let sent = 0;
    for (const [me, other] of [[schools[1]!, schools[0]!], [schools[0]!, schools[1]!]] as const) {
      const before = await checksum(other.t);
      const candidates = [...new Set(Object.values(other.ids))];
      for (const r of writes) {
        if (/backchannel-logout|\/integration\//.test(r.path)) continue;
        const paths = r.path.includes(':') ? candidates.map((id) => fill(r.path, id)) : [r.path];
        for (const p of paths) {
          const body = { id: candidates[0], userId: other.ids.user, conversationId: other.ids.conv, fileId: other.ids.file, messageId: other.ids.msg, userIds: [other.ids.user], memberIds: [other.ids.user], body: 'x', title: 'x', name: 'x' };
          const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[r.method]!(p).set('Authorization', `Bearer ${me.admin.token}`).send(body);
          sent++;
          if ((res.text ?? '').includes(MARK(other.t))) leaks.push(`${me.t.tid}->${other.t.tid} ${r.method.toUpperCase()} ${p} ${res.status} (marker)`);
        }
      }
      const after = await checksum(other.t);
      for (const [table, h] of Object.entries(before)) if (after[table] !== h) leaks.push(`${me.t.tid}->${other.t.tid} changed ${table}`);
    }
    console.log(`[schoolIsolation.test] write sweep: ${writes.length} routes, ${sent} requests`);
    expect(leaks).toEqual([]);
  }, 900_000);
});
