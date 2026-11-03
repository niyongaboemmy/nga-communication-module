import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';

/** A-04: malformed input is a 400 with a reason — never a 500, never stored. */

async function user(role: string, name: string) {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [role]);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, role.toLowerCase(), rows[0]!.id]);
  return { id, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: role.toLowerCase() }, config.jwtSecret) };
}
const as = (t: string) => ({
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
  put: (p: string, b?: unknown) => request(app).put(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
  patch: (p: string, b?: unknown) => request(app).patch(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
});
const nonce = () => randomBytes(8).toString('hex');

let admin: Awaited<ReturnType<typeof user>>;
let staff: Awaited<ReturnType<typeof user>>;
let group: string;
let other: string;
let msg: string;
let otherMsg: string;
let page: string;
let post: string;

beforeAll(async () => {
  await seedRbac(getPool());
  admin = await user('Admin', 'Adm');
  staff = await user('Staff', 'Sta');
  group = (await as(staff.token).post('/api/chat/conversations', { type: 'group', name: `v-${nonce()}`, memberIds: [] })).body.data.conversation.id;
  other = (await as(staff.token).post('/api/chat/conversations', { type: 'group', name: `w-${nonce()}`, memberIds: [] })).body.data.conversation.id;
  msg = (await as(staff.token).post(`/api/chat/conversations/${group}/messages`, { body: 'root', nonce: nonce() })).body.data.message.id;
  otherMsg = (await as(staff.token).post(`/api/chat/conversations/${other}/messages`, { body: 'elsewhere', nonce: nonce() })).body.data.message.id;
  page = (await as(admin.token).post('/api/feed/pages', { name: `Val ${snowflake()}`, audience: 'everyone' })).body.data.page.id;
  post = (await as(admin.token).post(`/api/feed/pages/${page}/posts`, { body: 'hello' })).body.data.postId;
});

afterAll(async () => {
  const pool = getPool();
  const convs = [group, other];
  for (const t of ['message_reactions', 'message_mentions', 'message_receipts']) {
    await pool.query(`DELETE FROM ${t} WHERE conversation_id = ANY($1::text[])`, [convs]).catch(() => {});
  }
  await pool.query('DELETE FROM polls WHERE conversation_id = ANY($1::text[])', [convs]);
  await pool.query('DELETE FROM thread_reads WHERE conversation_id = ANY($1::text[])', [convs]).catch(() => {});
  await pool.query('DELETE FROM messages WHERE conversation_id = ANY($1::text[])', [convs]);
  await pool.query('DELETE FROM conversation_members WHERE conversation_id = ANY($1::text[])', [convs]);
  await pool.query('DELETE FROM conversations WHERE id = ANY($1::text[])', [convs]);
  await pool.query('DELETE FROM feed_reactions WHERE post_id IN (SELECT id FROM feed_posts WHERE page_id = $1)', [page]);
  await pool.query('DELETE FROM feed_timeline WHERE post_id IN (SELECT id FROM feed_posts WHERE page_id = $1)', [page]).catch(() => {});
  await pool.query('DELETE FROM feed_posts WHERE page_id = $1', [page]);
  await pool.query('DELETE FROM feed_page_editors WHERE page_id = $1', [page]);
  await pool.query('DELETE FROM feed_page_followers WHERE page_id = $1', [page]);
  await pool.query('DELETE FROM feed_pages WHERE id = $1', [page]);
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [[admin.id, staff.id]]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[admin.id, staff.id]]);
  await closeDb();
});

describe('chat', () => {
  it('accepts a real emoji reaction and refuses text posing as one', async () => {
    const path = `/api/chat/conversations/${group}/messages/${msg}/reactions`;
    expect((await as(staff.token).post(path, { emoji: '👍🏽' })).status).toBe(200);
    for (const emoji of ['<script>', 'lol', '👍👍']) {
      expect((await as(staff.token).post(path, { emoji })).status, emoji).toBe(400);
    }
  });

  it('refuses a malformed mute time', async () => {
    const r = await as(staff.token).patch(`/api/chat/conversations/${group}/prefs`, { mutedUntil: 'tomorrow-ish' });
    expect(r.status).toBe(400);
    const ok = await as(staff.token).patch(`/api/chat/conversations/${group}/prefs`, { mutedUntil: new Date(Date.now() + 3600e3).toISOString() });
    expect(ok.status).toBe(200);
  });

  it('refuses a malformed or past status expiry and a non-emoji status emoji', async () => {
    expect((await as(staff.token).put('/api/chat/status', { text: 'Away', expiresAt: 'soon' })).status).toBe(400);
    expect((await as(staff.token).put('/api/chat/status', { text: 'Away', expiresAt: '2001-01-01T00:00:00Z' })).status).toBe(400);
    expect((await as(staff.token).put('/api/chat/status', { emoji: 'hi', text: 'Away' })).status).toBe(400);
    expect((await as(staff.token).put('/api/chat/status', { emoji: '🌴', text: 'Away' })).status).toBe(200);
  });

  it('refuses a poll that closes in the past or at a nonsense time', async () => {
    for (const closesAt of ['2001-01-01T00:00:00Z', 'never']) {
      const r = await as(staff.token).post(`/api/chat/conversations/${group}/polls`, { question: 'Q?', options: ['a', 'b'], closesAt });
      expect(r.status, closesAt).toBe(400);
    }
  });

  it('refuses replies and thread replies pointing outside the conversation', async () => {
    const send = (extra: object) => as(staff.token).post(`/api/chat/conversations/${group}/messages`, { body: 'x', nonce: nonce(), ...extra });
    expect((await send({ replyToId: otherMsg })).status).toBe(404);
    expect((await send({ threadRootId: otherMsg })).status).toBe(404);
    expect((await send({ threadRootId: 'not-an-id' })).status).toBe(400);
  });

  it('keeps threads one level deep', async () => {
    const reply = await as(staff.token).post(`/api/chat/conversations/${group}/messages`, { body: 'in thread', nonce: nonce(), threadRootId: msg });
    expect(reply.status).toBeLessThan(300);
    const nested = await as(staff.token).post(`/api/chat/conversations/${group}/messages`, {
      body: 'nested', nonce: nonce(), threadRootId: reply.body.data.message.id });
    expect(nested.status).toBe(400);
  });

  it('caps attachments per message and draft size', async () => {
    const r = await as(staff.token).post(`/api/chat/conversations/${group}/messages`, {
      body: 'many', nonce: nonce(), attachments: Array.from({ length: 11 }, (_, i) => ({ fileId: String(i) })) });
    expect(r.status).toBe(400);
    expect((await as(staff.token).put(`/api/chat/conversations/${group}/draft`, { draft: 'x'.repeat(50_000) })).status).toBe(400);
  });
});

describe('feed', () => {
  it('accepts only the fixed reaction set', async () => {
    expect((await as(staff.token).post(`/api/feed/posts/${post}/reactions`, { emoji: 'love' })).status).toBe(200);
    expect((await as(staff.token).post(`/api/feed/posts/${post}/reactions`, { emoji: '<b>x</b>' })).status).toBe(400);
  });

  it('refuses a poll with an unparseable or past closing time, or non-list options', async () => {
    const make = (poll: unknown) => as(admin.token).post(`/api/feed/pages/${page}/posts`, { body: 'p', poll });
    expect((await make({ question: 'Q?', options: ['a', 'b'], closesAt: 'next week' })).status).toBe(400);
    expect((await make({ question: 'Q?', options: ['a', 'b'], closesAt: '2001-01-01T00:00:00Z' })).status).toBe(400);
    expect((await make({ question: 'Q?', options: 'a,b' })).status).toBe(400);
  });
});
