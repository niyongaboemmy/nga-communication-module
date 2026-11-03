import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';
import { sweepMeetings, claimWrapUp } from '../services/meetLifecycle.js';

/** E-04: meetings close themselves; ending is idempotent; wrap-up is claimed once. */

async function user(role: string, name: string) {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [role]);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, role.toLowerCase(), rows[0]!.id]);
  users.push(id);
  return { id, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: role.toLowerCase() }, config.jwtSecret) };
}
const post = (t: string, p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${t}`).send(b ?? {});
const idOf = (r: request.Response) => (r.body.data?.meeting ?? r.body.data).id as string;
const status = async (id: string) => (await getPool().query<{ status: string; ended_at: Date | null }>(
  'SELECT status, ended_at FROM meetings WHERE id = $1', [id])).rows[0]!;

const users: string[] = [];
const meetings: string[] = [];
let host: Awaited<ReturnType<typeof user>>;

beforeAll(async () => {
  await seedRbac(getPool());
  host = await user('Staff', 'Host');
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

async function liveMeeting(): Promise<string> {
  const r = await post(host.token, '/api/meet/instant', {});
  const id = idOf(r); meetings.push(id);
  await post(host.token, `/api/meet/${id}/join`);
  return id;
}

describe('auto-close (MEET-RT2)', () => {
  it('ends a live meeting everyone left more than 10 minutes ago', async () => {
    const id = await liveMeeting();
    await post(host.token, `/api/meet/${id}/leave`);
    await getPool().query(`UPDATE meeting_participants SET left_at = now() - interval '15 minutes' WHERE meeting_id = $1`, [id]);
    const r = await sweepMeetings();
    expect(r.ended).toContain(id);
    expect((await status(id)).status).toBe('ended');
  });

  it('leaves a meeting alone while someone is in it, or only just left', async () => {
    const busy = await liveMeeting();
    const justLeft = await liveMeeting();
    await post(host.token, `/api/meet/${justLeft}/leave`);
    const r = await sweepMeetings();
    expect(r.ended).not.toContain(busy);
    expect(r.ended).not.toContain(justLeft);
    expect((await status(busy)).status).toBe('live');
  });

  it('ends a ghost meeting that has been live for 12 hours', async () => {
    const id = await liveMeeting();
    await getPool().query(`UPDATE meetings SET started_at = now() - interval '13 hours' WHERE id = $1`, [id]);
    expect((await sweepMeetings()).ended).toContain(id);
  });

  it('closes a one-off meeting that never happened, but not a recurring one', async () => {
    const when = new Date(Date.now() + 86400e3).toISOString();
    const once = idOf(await post(host.token, '/api/meet', { title: 'No-show', scheduledStart: when }));
    const weekly = idOf(await post(host.token, '/api/meet', { title: 'Weekly', scheduledStart: when, recurrenceRule: 'FREQ=WEEKLY' }));
    meetings.push(once, weekly);
    await getPool().query(`UPDATE meetings SET scheduled_start = now() - interval '5 hours', scheduled_end = NULL WHERE id = ANY($1::text[])`, [[once, weekly]]);
    await sweepMeetings();
    expect((await status(once)).status).toBe('ended');
    expect((await status(weekly)).status).toBe('scheduled');
  });
});

describe('ending (MEET-RT6)', () => {
  it('ending twice keeps the first end time', async () => {
    const id = await liveMeeting();
    expect((await post(host.token, `/api/meet/${id}/end`)).status).toBe(200);
    const first = (await status(id)).ended_at!.getTime();
    await new Promise((r) => setTimeout(r, 20));
    expect((await post(host.token, `/api/meet/${id}/end`)).status).toBe(200);
    expect((await status(id)).ended_at!.getTime()).toBe(first);
  });

  it('the wrap-up can be claimed only once', async () => {
    const id = await liveMeeting();
    await getPool().query(`UPDATE meetings SET status = 'ended', ended_at = now(), wrapup_queued_at = now() WHERE id = $1`, [id]);
    expect(await claimWrapUp(id)).toBe(false);
  });
});
