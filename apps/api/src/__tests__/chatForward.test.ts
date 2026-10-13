import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';

/** B-10 / CHAT-H10: forwarding works for others' files, keeps attribution, sends the note, and polls. */

async function user(name: string): Promise<{ id: string; token: string }> {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>(`SELECT id FROM roles WHERE name = 'Admin'`);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'admin',$4)`,
    [id, name, `${id}@amashuri.com`, rows[0]!.id]);
  return { id, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'admin' }, config.jwtSecret, { expiresIn: '15m' }) };
}
const nonce = () => randomBytes(8).toString('hex');
const as = (u: { token: string }) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${u.token}`),
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${u.token}`).send(b ?? {}),
});
const latest = async (u: { token: string }, conv: string) =>
  (await as(u).get(`/api/chat/conversations/${conv}/messages`)).body.data.messages as Array<{
    body: string | null; type: string; attachments: Array<{ fileId: string }>; forwardedFrom: { senderName: string } | null;
  }>;

let ada: { id: string; token: string };
let ben: { id: string; token: string };
let source: string;
let target: string;

beforeAll(async () => {
  await seedRbac(getPool());
  ada = await user('Ada'); ben = await user('Ben');
  source = (await as(ben).post('/api/chat/conversations', { type: 'group', name: `src-${nonce()}`, memberIds: [ada.id] })).body.data.conversation.id;
  target = (await as(ada).post('/api/chat/conversations', { type: 'group', name: `dst-${nonce()}`, memberIds: [] })).body.data.conversation.id;
});
afterAll(async () => {
  // Files hold a foreign key to their owner: leave none behind for the next suite.
  const owners = [ada.id, ben.id];
  await getPool().query(`DELETE FROM message_attachments WHERE file_id IN (SELECT id FROM files WHERE owner_id = ANY($1::text[]))`, [owners]).catch(() => {});
  await getPool().query('DELETE FROM files WHERE owner_id = ANY($1::text[])', [owners]);
  await closeDb();
});

describe('forwarding', () => {
  it("forwards someone else's attachment with attribution and the note", async () => {
    const fileId = snowflake();
    await getPool().query(
      `INSERT INTO files (id, owner_id, original_name, mime_type, size_bytes, status, storage_driver, storage_key)
       VALUES ($1, $2, 'plan.pdf', 'application/pdf', 1234, 'ready', 'local', $1)`, [fileId, ben.id]);
    const msg = (await as(ben).post(`/api/chat/conversations/${source}/messages`, { body: 'the plan', nonce: nonce(), attachments: [fileId] })).body.data.message;
    const res = await as(ada).post(`/api/chat/conversations/${source}/messages/${msg.id}/forward`,
      { conversationIds: [target], comment: 'see this' });
    expect(res.status).toBe(200);
    const msgs = await latest(ada, target);
    const fwd = msgs.find((m) => m.body === 'the plan')!;
    expect(fwd.attachments.map((a) => a.fileId)).toEqual([fileId]);
    expect(fwd.forwardedFrom?.senderName).toBe('Ben');
    expect(msgs.some((m) => m.body === 'see this')).toBe(true);
  });

  it('still refuses attaching a stranger\'s file directly', async () => {
    const fileId = snowflake();
    await getPool().query(
      `INSERT INTO files (id, owner_id, original_name, mime_type, size_bytes, status, storage_driver, storage_key)
       VALUES ($1, $2, 'x.pdf', 'application/pdf', 1, 'ready', 'local', $1)`, [fileId, ben.id]);
    const res = await as(ada).post(`/api/chat/conversations/${target}/messages`, { body: 'mine?', nonce: nonce(), attachments: [fileId] });
    expect(res.status).toBe(403);
  });

  it('a forwarded poll arrives as a readable snapshot', async () => {
    const { poll, message } = (await as(ben).post(`/api/chat/conversations/${source}/polls`, { question: 'Trip day?', options: ['Thu', 'Fri'] })).body.data;
    await as(ada).post(`/api/chat/polls/${poll.id}/vote`, { optionIds: ['o1'] });
    await as(ada).post(`/api/chat/conversations/${source}/messages/${message.id}/forward`, { conversationIds: [target] });
    const snap = (await latest(ada, target)).find((m) => (m.body ?? '').startsWith('📊 Trip day?'));
    expect(snap?.type).toBe('text');
    expect(snap?.body).toContain('Fri — 1 vote');
  });
});
