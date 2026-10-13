import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';

/** E-02: conversation calls are private to the conversation; feature switches need permission; safe edits. */

async function user(role: string, name: string) {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [role]);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, role.toLowerCase(), rows[0]!.id]);
  users.push(id);
  return { id, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: role.toLowerCase() }, config.jwtSecret) };
}
const as = (t: string) => ({
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
  patch: (p: string, b?: unknown) => request(app).patch(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idOf = (r: request.Response) => (r.body.data?.meeting ?? r.body.data).id as string;

const users: string[] = [];
const meetings: string[] = [];
let caller: Awaited<ReturnType<typeof user>>;
let friend: Awaited<ReturnType<typeof user>>;
let outsider: Awaited<ReturnType<typeof user>>;
let moderator: Awaited<ReturnType<typeof user>>;
let dm: string;

beforeAll(async () => {
  await seedRbac(getPool());
  caller = await user('Staff', 'Caller');
  friend = await user('Staff', 'Friend');
  outsider = await user('Staff', 'Outsider');
  moderator = await user('Moderator', 'Mod');
  dm = (await as(caller.token).post('/api/chat/conversations/direct', { userId: friend.id })).body.data.conversation.id;
});

afterAll(async () => {
  const pool = getPool();
  for (const t of ['meeting_invites', 'meeting_participants', 'meeting_events']) {
    await pool.query(`DELETE FROM ${t} WHERE meeting_id = ANY($1::text[])`, [meetings]).catch(() => {});
  }
  await pool.query('DELETE FROM meetings WHERE id = ANY($1::text[])', [meetings]);
  await pool.query('DELETE FROM messages WHERE conversation_id = $1', [dm]);
  await pool.query('DELETE FROM conversation_members WHERE conversation_id = $1', [dm]);
  await pool.query('DELETE FROM conversations WHERE id = $1', [dm]);
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [users]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
  await closeDb();
});

describe('a call started from a conversation (MEET-SEC4)', () => {
  it('only a member of the conversation can start it', async () => {
    const r = await as(outsider.token).post('/api/meet/instant', { conversationId: dm });
    expect(r.status).toBe(403);
  });

  it('is open to the conversation, not the institution', async () => {
    const r = await as(caller.token).post('/api/meet/instant', { conversationId: dm, title: 'DM call' });
    expect(r.status).toBe(201);
    const id = idOf(r); meetings.push(id);
    expect(r.body.data.settings.admissionPolicy).toBe('invited');

    const stranger = await as(outsider.token).post(`/api/meet/${id}/join`, {});
    expect(stranger.status).toBe(403);
    const member = await as(friend.token).post(`/api/meet/${id}/join`, {});
    expect(member.status).toBeLessThan(300);

    // Announced to the conversation only.
    await sleep(300);
    const { rows } = await getPool().query(
      `SELECT user_id FROM notifications WHERE subject_id = $1 AND kind = 'meet.live'`, [id]);
    const notified = rows.map((x: { user_id: string }) => x.user_id);
    expect(notified).toContain(friend.id);
    expect(notified).not.toContain(outsider.id);
  });

  it('the scheduler’s category picks who may join', async () => {
    const r = await as(caller.token).post('/api/meet', {
      title: 'Briefing', conversationId: dm, scheduledStart: new Date(Date.now() + 86400e3).toISOString(),
      settings: { category: 'loggedIn' } });
    expect(r.status).toBe(201);
    meetings.push(idOf(r));
    expect(r.body.data.settings.admissionPolicy).toBe('authenticated');
  });
});

describe('feature switches need their permission (MEET-SEC8)', () => {
  it('a moderator without MEET_RECORD cannot switch recording on — on create, instant or edit', async () => {
    expect((await as(moderator.token).post('/api/meet/instant', { settings: { recordingEnabled: true } })).status).toBe(403);
    expect((await as(moderator.token).post('/api/meet/instant', { settings: { autoRecord: true } })).status).toBe(403);
    const ok = await as(moderator.token).post('/api/meet/instant', {});
    expect(ok.status).toBe(201);
    const id = idOf(ok); meetings.push(id);
    expect((await as(moderator.token).patch(`/api/meet/${id}`, { settings: { recordingEnabled: true } })).status).toBe(403);
  });
});

describe('edits (MEET-SEC11)', () => {
  it('status can only be cancelled/restored, and not once the meeting has started', async () => {
    const r = await as(caller.token).post('/api/meet', { title: 'Later', scheduledStart: new Date(Date.now() + 86400e3).toISOString() });
    const id = idOf(r); meetings.push(id);
    expect((await as(caller.token).patch(`/api/meet/${id}`, { status: 'live' })).status).toBe(400);
    expect((await as(caller.token).patch(`/api/meet/${id}`, { status: 'cancelled' })).status).toBe(200);
    const live = await as(caller.token).post('/api/meet/instant', {});
    const liveId = idOf(live); meetings.push(liveId);
    expect((await as(caller.token).patch(`/api/meet/${liveId}`, { status: 'cancelled' })).status).toBe(409);
  });

  it('a repeat rule cannot smuggle extra calendar lines', async () => {
    const bad = await as(caller.token).post('/api/meet', {
      title: 'Weekly', scheduledStart: new Date(Date.now() + 86400e3).toISOString(),
      recurrenceRule: 'FREQ=WEEKLY\r\nATTENDEE:mailto:evil@example.com' });
    expect(bad.status).toBe(400);
    const good = await as(caller.token).post('/api/meet', {
      title: 'Weekly', scheduledStart: new Date(Date.now() + 86400e3).toISOString(), recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,WE' });
    expect(good.status).toBe(201);
    meetings.push(idOf(good));
  });
});
