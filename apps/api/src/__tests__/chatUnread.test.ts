import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';

/**
 * Chat unread rules (B-02).
 *
 *   - a conversation's badge counts main-flow messages only;
 *   - thread replies are new for the thread's followers, per thread, and
 *     clear when the thread is read;
 *   - a reply also sent to the channel counts once;
 *   - replying in a thread does not mark the replier's channel read;
 *   - "mark as unread" and "mark read to the latest" behave.
 */

async function user(name: string): Promise<{ id: string; token: string }> {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>(`SELECT id FROM roles WHERE name = 'Staff'`);
  await getPool().query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`,
    [id, name, `${id}@amashuri.com`, rows[0]!.id],
  );
  const token = jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' },
    config.jwtSecret, { expiresIn: '15m' });
  return { id, token };
}

const api = (token: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`),
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${token}`).send(b ?? {}),
});
const nonce = () => randomBytes(8).toString('hex');

let ada: Awaited<ReturnType<typeof user>>;
let ben: Awaited<ReturnType<typeof user>>;
let cy: Awaited<ReturnType<typeof user>>;
let conv: string;
let rootId: string;

const unreadOf = async (u: { token: string }) =>
  (await api(u.token).get('/api/chat/conversations')).body.data.conversations
    .find((c: { id: string }) => c.id === conv) as { unread: number; unreadMentions: number; lastMessage: { preview: string } | null };

const say = (u: { token: string }, body: string) =>
  api(u.token).post(`/api/chat/conversations/${conv}/messages`, { body, nonce: nonce() });

const reply = (u: { token: string }, body: string, alsoSendToChannel = false) =>
  api(u.token).post(`/api/chat/conversations/${conv}/messages/${rootId}/replies`, { body, nonce: nonce(), alsoSendToChannel });

beforeAll(async () => {
  await seedRbac(getPool());
  ada = await user('Ada');
  ben = await user('Ben');
  cy = await user('Cy');
  const created = await api(ada.token).post('/api/chat/conversations', {
    type: 'group', name: `unread-${nonce()}`, memberIds: [ben.id, cy.id],
  });
  expect(created.status).toBe(201);
  conv = created.body.data.conversation.id;
  const root = await say(ben, 'a question from ben');
  rootId = root.body.data.message.id;
});

afterAll(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM thread_reads WHERE conversation_id = $1', [conv]);
  await pool.query('DELETE FROM message_mentions WHERE conversation_id = $1', [conv]);
  await pool.query('DELETE FROM message_receipts WHERE conversation_id = $1', [conv]);
  await pool.query('DELETE FROM message_nonces WHERE conversation_id = $1', [conv]).catch(() => {});
  await pool.query('DELETE FROM messages WHERE conversation_id = $1', [conv]);
  await pool.query('DELETE FROM conversation_members WHERE conversation_id = $1', [conv]);
  await pool.query('DELETE FROM conversations WHERE id = $1', [conv]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[ada.id, ben.id, cy.id]]);
  await closeDb();
});

describe('conversation unread counts main-flow messages only', () => {
  it('a thread reply badges no one, and is not the sidebar preview', async () => {
    const before = await unreadOf(cy);
    expect((await reply(ada, 'side remark')).status).toBe(201);
    const after = await unreadOf(cy);
    expect(after.unread).toBe(before.unread);
    expect(after.lastMessage?.preview).not.toContain('side remark');
  });

  it('a reply also sent to the channel counts exactly once', async () => {
    const before = await unreadOf(cy);
    expect((await reply(ada, 'conclusion for everyone', true)).status).toBe(201);
    expect((await unreadOf(cy)).unread).toBe(before.unread + 1);
  });

  it('reading to the newest main-flow message clears the badge for good', async () => {
    await api(cy.token).post(`/api/chat/conversations/${conv}/read`, { latest: true });
    expect((await unreadOf(cy)).unread).toBe(0);
    await reply(ada, 'another side remark');
    expect((await unreadOf(cy)).unread).toBe(0);
  });

  it('replying in a thread leaves the replier’s unread channel messages unread', async () => {
    await say(ada, 'ben has not read this yet');
    const before = (await unreadOf(ben)).unread;
    expect(before).toBeGreaterThan(0);
    await reply(ben, 'ben answers in the thread');
    expect((await unreadOf(ben)).unread).toBe(before);
  });
});

describe('thread read state', () => {
  it('the root author follows the thread and sees new replies, cleared by reading it', async () => {
    // Ben wrote the root; Ada has since replied more than once.
    await reply(ada, 'one more for ben');
    const threads = (await api(ben.token).get('/api/chat/threads')).body.data.threads as Array<{ rootId: string; unread: number }>;
    const t = threads.find((x) => x.rootId === rootId);
    expect(t?.unread).toBeGreaterThan(0);

    const per = (await api(ben.token).get(`/api/chat/conversations/${conv}/threads/unread`)).body.data.threads;
    expect(per[rootId]).toBe(t!.unread);

    const lastSeq = Number((await getPool().query(
      'SELECT max(seq) AS s FROM messages WHERE conversation_id = $1 AND thread_root_id = $2', [conv, rootId],
    )).rows[0].s);
    expect((await api(ben.token).post(`/api/chat/conversations/${conv}/threads/${rootId}/read`, { seq: lastSeq })).status).toBe(200);
    const again = (await api(ben.token).get(`/api/chat/conversations/${conv}/threads/unread`)).body.data.threads;
    expect(again[rootId]).toBeUndefined();
  });

  it('someone who never touched the thread is not told about it', async () => {
    const threads = (await api(cy.token).get('/api/chat/threads')).body.data.threads as Array<{ rootId: string }>;
    expect(threads.find((x) => x.rootId === rootId)).toBeUndefined();
  });
});

describe('mark as unread', () => {
  it('brings back a badge of one, and refuses where there is nothing to mark', async () => {
    await api(cy.token).post(`/api/chat/conversations/${conv}/read`, { latest: true });
    const r = await api(cy.token).post(`/api/chat/conversations/${conv}/unread`);
    expect(r.status).toBe(200);
    expect((await unreadOf(cy)).unread).toBe(1);

    const lonely = await api(ada.token).post('/api/chat/conversations', { type: 'group', name: `empty-${nonce()}`, memberIds: [ben.id] });
    const empty = lonely.body.data.conversation.id;
    expect((await api(ada.token).post(`/api/chat/conversations/${empty}/unread`)).status).toBe(409);
    await getPool().query('DELETE FROM messages WHERE conversation_id = $1', [empty]);
    await getPool().query('DELETE FROM conversation_members WHERE conversation_id = $1', [empty]);
    await getPool().query('DELETE FROM conversations WHERE id = $1', [empty]);
  });
});
