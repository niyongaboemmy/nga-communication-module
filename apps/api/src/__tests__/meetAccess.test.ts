import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';

/** E-01: an invite-only meeting is invisible to people it is not for. */

async function user(role: string, name: string) {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [role]);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, role.toLowerCase(), rows[0]!.id]);
  return { id, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: role.toLowerCase() }, config.jwtSecret) };
}
const get = (t: string, p: string) => request(app).get(p).set('Authorization', `Bearer ${t}`);

let host: Awaited<ReturnType<typeof user>>;
let invitee: Awaited<ReturnType<typeof user>>;
let stranger: Awaited<ReturnType<typeof user>>;
let student: Awaited<ReturnType<typeof user>>;
let privateId: string;
let openId: string;

beforeAll(async () => {
  await seedRbac(getPool());
  host = await user('Staff', 'Host');
  invitee = await user('Staff', 'Invitee');
  stranger = await user('Staff', 'Stranger');
  student = await user('Student', 'Student');
  const priv = await request(app).post('/api/meet').set('Authorization', `Bearer ${host.token}`)
    .send({ title: 'Private staff meeting', settings: { admissionPolicy: 'invited' }, invitees: [invitee.id] });
  privateId = (priv.body.data?.meeting ?? priv.body.data).id;
  await getPool().query('INSERT INTO meeting_invites (meeting_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [privateId, invitee.id]);
  const open = await request(app).post('/api/meet').set('Authorization', `Bearer ${host.token}`)
    .send({ title: 'Assembly', settings: { admissionPolicy: 'authenticated' } });
  openId = (open.body.data?.meeting ?? open.body.data).id;
});

afterAll(async () => {
  const ids = [privateId, openId];
  await getPool().query('DELETE FROM meeting_invites WHERE meeting_id = ANY($1::text[])', [ids]);
  await getPool().query('DELETE FROM meeting_participants WHERE meeting_id = ANY($1::text[])', [ids]);
  await getPool().query('DELETE FROM meeting_events WHERE meeting_id = ANY($1::text[])', [ids]);
  await getPool().query('DELETE FROM meetings WHERE id = ANY($1::text[])', [ids]);
  await getPool().query('DELETE FROM users WHERE id = ANY($1::text[])', [[host.id, invitee.id, stranger.id, student.id]]);
  await closeDb();
});

describe('invite-only meeting', () => {
  it('the host and an invitee can read it', async () => {
    expect((await get(host.token, `/api/meet/${privateId}`)).status).toBe(200);
    expect((await get(invitee.token, `/api/meet/${privateId}`)).status).toBe(200);
    expect((await get(invitee.token, `/api/meet/${privateId}/ics`)).status).toBe(200);
  });

  it('anyone else gets the same 404 as a meeting that does not exist', async () => {
    for (const path of ['', '/recordings', '/ics', '/ai', '/transcript']) {
      expect((await get(stranger.token, `/api/meet/${privateId}${path}`)).status).toBe(404);
      expect((await get(student.token, `/api/meet/${privateId}${path}`)).status).toBe(404);
    }
  });
});

describe('meeting open to anyone signed in', () => {
  it('shows its details to a stranger, but not who attended or what it produced', async () => {
    const r = await get(stranger.token, `/api/meet/${openId}`);
    expect(r.status).toBe(200);
    expect(r.body.data.participants).toEqual([]);
    expect((await get(stranger.token, `/api/meet/${openId}/recordings`)).status).toBe(404);
    expect((await get(stranger.token, `/api/meet/${openId}/ai`)).status).toBe(404);
  });
});
