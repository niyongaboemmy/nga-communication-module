import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';

/** B-05: blocking closes DMs and silences the blocked person; reports reach moderators. */

async function user(role: string, name: string) {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [role]);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, role.toLowerCase(), rows[0]!.id]);
  users.push(id);
  return { id, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: role.toLowerCase() }, config.jwtSecret) };
}
const as = (t: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${t}`),
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
  put: (p: string, b?: unknown) => request(app).put(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
  patch: (p: string, b?: unknown) => request(app).patch(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
  del: (p: string) => request(app).delete(p).set('Authorization', `Bearer ${t}`),
});
const nonce = () => randomBytes(8).toString('hex');

const users: string[] = [];
const convs: string[] = [];
let ann: Awaited<ReturnType<typeof user>>;
let bob: Awaited<ReturnType<typeof user>>;
let mod: Awaited<ReturnType<typeof user>>;
let dm: string;
let group: string;

beforeAll(async () => {
  await seedRbac(getPool());
  ann = await user('Staff', 'Ann');
  bob = await user('Staff', 'Bob');
  mod = await user('Moderator', 'Mod');
  dm = (await as(ann.token).post('/api/chat/conversations/direct', { userId: bob.id })).body.data.conversation.id;
  group = (await as(ann.token).post('/api/chat/conversations', { type: 'group', name: `g-${nonce()}`, memberIds: [bob.id] })).body.data.conversation.id;
  convs.push(dm, group);
});

afterAll(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM user_reports WHERE reporter_id = ANY($1::text[])', [users]);
  await pool.query('DELETE FROM user_blocks WHERE blocker_id = ANY($1::text[])', [users]);
  for (const t of ['message_reactions', 'message_mentions', 'message_receipts']) {
    await pool.query(`DELETE FROM ${t} WHERE conversation_id = ANY($1::text[])`, [convs]).catch(() => {});
  }
  await pool.query('DELETE FROM messages WHERE conversation_id = ANY($1::text[])', [convs]);
  await pool.query('DELETE FROM conversation_members WHERE conversation_id = ANY($1::text[])', [convs]);
  await pool.query('DELETE FROM conversations WHERE id = ANY($1::text[])', [convs]);
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [users]);
  await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1::text[])', [users]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
  await closeDb();
});

const send = (t: string, conv: string, body: string) =>
  as(t).post(`/api/chat/conversations/${conv}/messages`, { body, nonce: nonce() });

describe('blocking', () => {
  it('cannot block yourself', async () => {
    expect((await as(ann.token).put(`/api/chat/blocks/${ann.id}`)).status).toBe(400);
  });

  it('closes the DM both ways, and unblocking reopens it', async () => {
    expect((await send(bob.token, dm, 'before')).status).toBe(201);
    expect((await as(ann.token).put(`/api/chat/blocks/${bob.id}`)).status).toBe(200);
    expect((await send(bob.token, dm, 'after block')).status).toBe(403);
    expect((await send(ann.token, dm, 'from the blocker')).status).toBe(403);
    expect((await as(bob.token).post('/api/chat/conversations/direct', { userId: ann.id })).status).toBe(403);
    expect((await as(ann.token).get('/api/chat/blocks')).body.data.blocks.map((b: { id: string }) => b.id)).toContain(bob.id);
    expect((await as(ann.token).del(`/api/chat/blocks/${bob.id}`)).status).toBe(200);
    expect((await send(bob.token, dm, 'after unblock')).status).toBe(201);
  });

  it('a blocked person’s mentions never notify the blocker', async () => {
    await as(ann.token).put(`/api/chat/blocks/${bob.id}`);
    await getPool().query('DELETE FROM notifications WHERE user_id = $1', [ann.id]);
    expect((await send(bob.token, group, `hey <@${ann.id}> look`)).status).toBe(201);
    await new Promise((r) => setTimeout(r, 200));
    const { rows } = await getPool().query('SELECT kind FROM notifications WHERE user_id = $1', [ann.id]);
    expect(rows).toHaveLength(0);
    await as(ann.token).del(`/api/chat/blocks/${bob.id}`);
  });

  it('hides presence both ways and tells the blocker it is blocked', async () => {
    await as(ann.token).put(`/api/chat/blocks/${bob.id}`);
    const mine = (await as(ann.token).get(`/api/chat/profile/${bob.id}`)).body.data.profile;
    expect(mine.blockedByMe).toBe(true);
    expect(mine.presence).toBe('offline');
    const theirs = (await as(bob.token).get(`/api/chat/profile/${ann.id}`)).body.data.profile;
    expect(theirs.presence).toBe('offline');
    expect(theirs.blockedByMe).toBe(false);   // the blocked person is not told
    await as(ann.token).del(`/api/chat/blocks/${bob.id}`);
  });
});

describe('reporting', () => {
  it('a member reports a message; the snapshot survives an edit', async () => {
    const m = (await send(bob.token, group, 'ORIGINAL NASTY WORDS')).body.data.message;
    const r = await as(ann.token).post('/api/chat/reports', { conversationId: group, messageId: m.id, reason: 'harassment', details: 'not ok' });
    expect(r.status).toBe(201);
    await as(bob.token).patch(`/api/chat/conversations/${group}/messages/${m.id}`, { body: 'sanitised' });
    const again = await as(ann.token).post('/api/chat/reports', { conversationId: group, messageId: m.id, reason: 'harassment' });
    expect(again.body.data.duplicate).toBe(true);

    const queue = await as(mod.token).get('/api/chat/reports');
    expect(queue.status).toBe(200);
    const row = queue.body.data.reports.find((x: { id: string }) => x.id === r.body.data.reportId);
    expect(row.messageExcerpt).toBe('ORIGINAL NASTY WORDS');
    expect(row.reported.id).toBe(bob.id);
  });

  it('only members can report a message, and nobody reports themselves', async () => {
    const outsider = await user('Staff', 'Out');
    const m = (await send(bob.token, group, 'hello')).body.data.message;
    expect((await as(outsider.token).post('/api/chat/reports', { conversationId: group, messageId: m.id, reason: 'spam' })).status).toBe(404);
    expect((await as(bob.token).post('/api/chat/reports', { userId: bob.id, reason: 'spam' })).status).toBe(400);
    expect((await as(ann.token).post('/api/chat/reports', { userId: bob.id, reason: 'nonsense' })).status).toBe(400);
  });

  it('the queue is for moderators; resolving tells the reporter, once', async () => {
    const r = await as(ann.token).post('/api/chat/reports', { userId: bob.id, reason: 'other', details: 'person report' });
    expect((await as(bob.token).get('/api/chat/reports')).status).toBe(403);
    expect((await as(mod.token).patch(`/api/chat/reports/${r.body.data.reportId}`, { status: 'resolved', note: 'spoke to them' })).status).toBe(200);
    expect((await as(mod.token).patch(`/api/chat/reports/${r.body.data.reportId}`, { status: 'dismissed' })).status).toBe(409);
    const { rows } = await getPool().query(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'moderation.report'`, [ann.id]);
    expect(rows.length).toBe(1);
  });

  it('report-and-block blocks at the same time', async () => {
    const r = await as(ann.token).post('/api/chat/reports', { userId: bob.id, reason: 'spam', alsoBlock: true });
    expect(r.status).toBeLessThan(300);
    expect((await send(bob.token, dm, 'still there?')).status).toBe(403);
    await as(ann.token).del(`/api/chat/blocks/${bob.id}`);
  });
});
