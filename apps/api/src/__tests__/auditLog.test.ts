import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import jwt from 'jsonwebtoken';
import { app } from '../app.js';
import { config } from '../config.js';

/** F-13: views, filters, cursor paging, readable targets, append-only storage. */

async function roleId(name: string) {
  return (await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [name])).rows[0]!.id;
}
async function user(name: string, role: string) {
  const id = snowflake();
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`,
    [id, name, `${id}@amashuri.com`, await roleId(role)]);
  return { id, auth: `Bearer ${jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' }, config.jwtSecret, { expiresIn: '10m' })}` };
}
async function entry(action: string, actorId: string, at: string, extra: { targetType?: string; targetId?: string; metadata?: object } = {}) {
  await getPool().query(
    `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, metadata, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [snowflake(), actorId, action, extra.targetType ?? null, extra.targetId ?? null, JSON.stringify(extra.metadata ?? {}), at]);
}

let admin: { id: string; auth: string };
beforeEach(async () => {
  await getPool().query('DELETE FROM audit_log');
  await getPool().query('DELETE FROM users');
  await seedRbac(getPool());
  admin = await user('Ada Admin', 'Admin');
});
afterAll(async () => { await closeDb(); });

describe('GET /api/audit', () => {
  it('opens on privileged actions; sign-ins and routine are separate views', async () => {
    await entry('user.role.assign', admin.id, '2026-10-01T10:00:00Z');
    await entry('auth.login', admin.id, '2026-10-01T09:00:00Z');
    await entry('feed.post.create', admin.id, '2026-10-01T08:00:00Z');
    await entry('feed.reel.create', admin.id, '2026-10-01T07:00:00Z');
    const priv = await request(app).get('/api/audit').set('Authorization', admin.auth);
    expect(priv.body.data.map((e: { action: string }) => e.action)).toEqual(['user.role.assign']);
    const signins = await request(app).get('/api/audit?view=signins').set('Authorization', admin.auth);
    expect(signins.body.data.map((e: { action: string }) => e.action)).toEqual(['auth.login']);
    const all = await request(app).get('/api/audit?view=all').set('Authorization', admin.auth);
    expect(all.body.data).toHaveLength(4);
    expect(all.body.data.find((e: { action: string }) => e.action === 'feed.reel.create').category).toBe('routine');
  });

  it('pages newest first by cursor without gaps or repeats', async () => {
    for (let i = 0; i < 7; i++) await entry('role.update', admin.id, `2026-10-0${i + 1}T10:00:00.123456Z`);
    // Two in the same microsecond: the id breaks the tie.
    await entry('role.update', admin.id, '2026-10-07T10:00:00.123456Z');
    const seen: string[] = [];
    let before: string | null = null;
    do {
      const res: { body: { data: Array<{ id: string }>; nextBefore: string | null } } = await request(app).get(`/api/audit?limit=3${before ? `&before=${encodeURIComponent(before)}` : ''}`).set('Authorization', admin.auth);
      seen.push(...res.body.data.map((e: { id: string }) => e.id));
      before = res.body.nextBefore;
    } while (before);
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  });

  it('filters by action, prefix, person, search and dates', async () => {
    const other = await user('Bea Other', 'Admin');
    await entry('role.create', admin.id, '2026-10-01T10:00:00Z');
    await entry('role.delete', other.id, '2026-10-05T10:00:00Z');
    await entry('user.role.assign', other.id, '2026-10-09T10:00:00Z');
    const get = async (qs: string) => (await request(app).get(`/api/audit?${qs}`).set('Authorization', admin.auth)).body.data.map((e: { action: string }) => e.action);
    expect(await get('action=role.create')).toEqual(['role.create']);
    expect((await get('action=role.')).sort()).toEqual(['role.create', 'role.delete']);
    expect(await get(`actor=${other.id}`)).toEqual(['user.role.assign', 'role.delete']);
    expect(await get('q=Bea')).toEqual(['user.role.assign', 'role.delete']);
    expect(await get('from=2026-10-02&to=2026-10-05')).toEqual(['role.delete']);
    expect((await request(app).get('/api/audit?from=nope').set('Authorization', admin.auth)).status).toBe(400);
  });

  it('names targets and the roles a role change moved between', async () => {
    const target = await user('Tom Target', 'Student');
    await entry('user.role.assign', admin.id, '2026-10-01T10:00:00Z',
      { targetType: 'user', targetId: target.id, metadata: { from: await roleId('Student'), to: await roleId('Staff') } });
    await entry('role.delete', admin.id, '2026-10-01T09:00:00Z', { targetType: 'role', targetId: '99999', metadata: { name: 'Old role' } });
    const res = await request(app).get('/api/audit').set('Authorization', admin.auth);
    const [assign, del] = res.body.data;
    expect(assign.target).toMatchObject({ label: 'Tom Target' });
    expect(assign.target.link).toContain('/app/admin/users');
    expect(res.body.refs.roles[String(await roleId('Student'))]).toBe('Student');
    expect(del.target).toMatchObject({ label: 'Old role', gone: true });
  });

  it('lists recorded actions with their view', async () => {
    await entry('auth.login', admin.id, '2026-10-01T10:00:00Z');
    await entry('auth.login', admin.id, '2026-10-01T11:00:00Z');
    const res = await request(app).get('/api/audit/actions').set('Authorization', admin.auth);
    expect(res.body.data).toEqual([{ action: 'auth.login', count: 2, category: 'signins' }]);
  });

  it('is refused without AUDIT_VIEW', async () => {
    const pupil = await user('Pia Pupil', 'Student');
    expect((await request(app).get('/api/audit').set('Authorization', pupil.auth)).status).toBe(403);
  });
});

describe('append-only storage (0039)', () => {
  it('refuses UPDATE, DELETE and TRUNCATE outside a maintenance session', async () => {
    await entry('role.create', admin.id, '2026-10-01T10:00:00Z');
    const client = await getPool().connect();
    try {
      await client.query(`SET tupo.audit_maintenance = 'off'`);
      await expect(client.query(`UPDATE audit_log SET action = 'forged'`)).rejects.toThrow(/append-only/);
      await expect(client.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
      await expect(client.query('TRUNCATE audit_log')).rejects.toThrow(/append-only/);
      // Writing new entries is what it is for.
      await client.query(`INSERT INTO audit_log (id, action) VALUES ($1, 'role.update')`, [snowflake()]);
    } finally {
      await client.query('RESET tupo.audit_maintenance');
      client.release();
    }
    const { rows } = await getPool().query(`SELECT action FROM audit_log ORDER BY created_at`);
    expect(rows.map((r) => r.action)).toEqual(['role.create', 'role.update']);
  });
});
