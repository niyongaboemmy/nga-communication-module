import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';

/** E-03: attendance is the sum of legs; one participant row per person. */

async function user(role: string, name: string) {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [role]);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, role.toLowerCase(), rows[0]!.id]);
  users.push(id);
  return { id, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: role.toLowerCase() }, config.jwtSecret) };
}
const post = (t: string, p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${t}`).send(b ?? {});

const users: string[] = [];
const meetings: string[] = [];
let host: Awaited<ReturnType<typeof user>>;
let pupil: Awaited<ReturnType<typeof user>>;
let meetingId: string;

beforeAll(async () => {
  await seedRbac(getPool());
  host = await user('Staff', 'Host');
  pupil = await user('Staff', 'Pupil');
  const r = await post(host.token, '/api/meet/instant', { settings: { admissionPolicy: 'authenticated', lobbyEnabled: false } });
  meetingId = (r.body.data?.meeting ?? r.body.data).id;
  meetings.push(meetingId);
});

afterAll(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM meeting_attendance_segments WHERE meeting_id = ANY($1::text[])', [meetings]);
  for (const t of ['meeting_participants', 'meeting_events', 'meeting_invites']) {
    await pool.query(`DELETE FROM ${t} WHERE meeting_id = ANY($1::text[])`, [meetings]).catch(() => {});
  }
  await pool.query('DELETE FROM meetings WHERE id = ANY($1::text[])', [meetings]);
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [users]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
  await closeDb();
});

const row = async () => (await getPool().query<{ id: string; duration_seconds: number; state: string }>(
  'SELECT id, duration_seconds, state FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2', [meetingId, pupil.id])).rows;
/** Pretend the open leg started `minutes` ago. */
const backdate = (minutes: number) => getPool().query(
  `UPDATE meeting_participants SET segment_started_at = now() - make_interval(mins => $3)
    WHERE meeting_id = $1 AND user_id = $2`, [meetingId, pupil.id, minutes]);

describe('attendance (MEET-BUG1)', () => {
  it('two 10-minute legs are 20 minutes, not the span since the first join', async () => {
    expect((await post(pupil.token, `/api/meet/${meetingId}/join`)).status).toBeLessThan(300);
    await backdate(10);
    expect((await post(pupil.token, `/api/meet/${meetingId}/leave`)).status).toBeLessThan(300);
    // Rejoin much later: the first join is now 40 minutes back.
    await getPool().query(`UPDATE meeting_participants SET joined_at = now() - interval '40 minutes' WHERE meeting_id = $1 AND user_id = $2`, [meetingId, pupil.id]);
    expect((await post(pupil.token, `/api/meet/${meetingId}/join`)).status).toBeLessThan(300);
    await backdate(10);
    await post(pupil.token, `/api/meet/${meetingId}/leave`);

    const [r] = await row();
    expect(r!.duration_seconds).toBeGreaterThanOrEqual(1195);
    expect(r!.duration_seconds).toBeLessThanOrEqual(1210);
    const { rows: legs } = await getPool().query('SELECT 1 FROM meeting_attendance_segments WHERE participant_id = $1', [r!.id]);
    expect(legs).toHaveLength(2);
  });
});

describe('one participant per person (MEET-BUG2)', () => {
  it('several tabs joining at once share one row', async () => {
    const other = await user('Staff', 'Tabs');
    await Promise.all([1, 2, 3, 4].map(() => post(other.token, `/api/meet/${meetingId}/join`)));
    const { rows } = await getPool().query('SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2', [meetingId, other.id]);
    expect(rows).toHaveLength(1);
  });
});
