import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, snowflake, seedRbac } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';

/**
 * TP-ISO-1 (school isolation audit 2026-11-25): the Meet router has its own
 * auth (meetAuth) and must honour single sign-out exactly like authMiddleware —
 * a person-wide revocation (session_revocations) and a browser-session one by
 * sid (session_sid_revocations, a school switch).
 */
let userId: string;
const misUserId = String(700_000_000 + (Date.now() % 100_000_000));
const SID_A = 'sidMeetAAAAAAA';
const SID_B = 'sidMeetBBBBBBB';

const session = (sid: string | null, iatSecondsAgo = 30) => jwt.sign(
  {
    id: userId, misUserId, name: 'Aline', email: `${userId}@amashuri.com`, role: 'staff', tid: 1,
    misToken: jwt.sign({ sub: misUserId, tid: 1, ...(sid ? { sid } : {}) }, 'mis-secret'),
    iat: Math.floor(Date.now() / 1000) - iatSecondsAgo,
  },
  config.jwtSecret, { expiresIn: '1h' },
);

const meetingId = snowflake();
const routes = (token: string) => [
  request(app).get('/api/meet').set('Authorization', `Bearer ${token}`),
  request(app).get(`/api/meet/${meetingId}`).set('Authorization', `Bearer ${token}`),
  request(app).post(`/api/meet/${meetingId}/join`).set('Authorization', `Bearer ${token}`).send({}),
];
async function statuses(token: string) {
  const out: { status: number; code?: string }[] = [];
  for (const r of routes(token)) { const res = await r; out.push({ status: res.status, code: res.body?.code }); }
  return out;
}

let host: { id: string; token: string };

beforeAll(async () => {
  await seedRbac(getPool());
  const roleId = (await getPool().query<{ id: number }>(`SELECT id FROM roles WHERE name = 'Staff'`)).rows[0]?.id ?? null;
  host = { id: snowflake(), token: '' };
  await getPool().query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1, $2, 'Host', $3, 'staff', $4)`,
    [host.id, `h${host.id}`.slice(0, 18), `${host.id}@amashuri.com`, roleId],
  );
  host.token = jwt.sign({ id: host.id, misUserId: `h${host.id}`, name: 'Host', email: `${host.id}@amashuri.com`, role: 'staff', tid: 1 },
    config.jwtSecret, { expiresIn: '10m' });
  userId = snowflake();
  await getPool().query(
    `INSERT INTO users (id, mis_user_id, name, email, role) VALUES ($1, $2, 'Aline', $3, 'staff')`,
    [userId, misUserId, `${userId}@amashuri.com`],
  );
});

afterAll(async () => {
  await getPool().query('DELETE FROM meeting_participants WHERE meeting_id IN (SELECT id FROM meetings WHERE host_id = $1)', [host.id]);
  await getPool().query('DELETE FROM meetings WHERE host_id = $1', [host.id]);
  await getPool().query('DELETE FROM users WHERE id = ANY($1)', [[userId, host.id]]);
  await closeDb();
});

describe('TP-ISO-1 meetAuth honours single sign-out', () => {
  it('a sid revocation (school switch) ends that browser session on /api/meet/*, not other sessions', async () => {
    const a = session(SID_A);
    const b = session(SID_B);
    for (const s of await statuses(a)) expect(s.status).not.toBe(401);

    await getPool().query(
      `INSERT INTO session_sid_revocations (tenant_id, user_id, sid, revoked_at) VALUES (1, $1, $2, now())`,
      [userId, SID_A],
    );
    for (const s of await statuses(a)) expect(s).toEqual({ status: 401, code: 'SESSION_ENDED' });
    for (const s of await statuses(b)) expect(s.status).not.toBe(401);
  });

  it('a person-wide revocation (MIS sign-out) ends every older session on /api/meet/*', async () => {
    const b = session(SID_B);
    await getPool().query(
      `INSERT INTO session_revocations (tenant_id, user_id, revoked_at) VALUES (1, $1, now())
         ON CONFLICT (user_id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at`,
      [userId],
    );
    for (const s of await statuses(b)) expect(s).toEqual({ status: 401, code: 'SESSION_ENDED' });

    // A sign-in after the revocation works again.
    await new Promise((r) => setTimeout(r, 1100));
    for (const s of await statuses(session(SID_B, 0))) expect(s.status).not.toBe(401);
  });
});

describe('TP-ISO-7 guest join does not tell a private meeting from an unknown one', () => {
  const guest = (code: string) => request(app).post(`/api/meet/${code}/guest`)
    .set('X-Forwarded-For', `41.186.9.${Math.floor(Math.random() * 200) + 1}`).send({ displayName: 'Visitor' });

  it('answers 404 with the same message for a members-only meeting and an unknown code', async () => {
    const res = await request(app).post('/api/meet/instant').set('Authorization', `Bearer ${host.token}`)
      .send({ title: 'Staff only', settings: { admissionPolicy: 'permission' } });
    expect(res.status).toBe(201);
    const priv = await guest(res.body.data.join_code);
    const unknown = await guest('zzz-zzzz-zzq');
    expect(priv.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(priv.body.message).toBe(unknown.body.message);
  });

  it('still lets a guest knock on a public meeting', async () => {
    const res = await request(app).post('/api/meet/instant').set('Authorization', `Bearer ${host.token}`)
      .send({ title: 'Open day', settings: { admissionPolicy: 'public' } });
    expect(res.status).toBe(201);
    expect((await guest(res.body.data.join_code)).status).toBe(201);
  });
});
