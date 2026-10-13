import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import * as chat from '@tupo/chat';
import { app } from '../app.js';
import { config } from '../config.js';

/** B-07 / B-11: retention is visible, and expired messages leave nothing behind. */

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

let ada: { id: string; token: string };
let ben: { id: string; token: string };
let conv: string;

beforeAll(async () => {
  await seedRbac(getPool());
  ada = await user('Ada'); ben = await user('Ben');
  conv = (await as(ada).post('/api/chat/conversations', { type: 'group', name: `ret-${nonce()}`, memberIds: [ben.id] })).body.data.conversation.id;
});
afterAll(async () => { await closeDb(); });

describe('retention', () => {
  it('the conversation says how long messages are kept', async () => {
    const res = await as(ada).post(`/api/chat/conversations/${conv}/retention`, { days: 7 });
    expect(res.status).toBe(200);
    expect(res.body.data.conversation.retentionDays).toBe(7);
    const list = (await as(ben).get('/api/chat/conversations')).body.data.conversations;
    expect(list.find((c: { id: string }) => c.id === conv).retentionDays).toBe(7);
  });

  it('an expired message is removed with its traces, badges recounted and listeners told', async () => {
    const sent = await as(ada).post(`/api/chat/conversations/${conv}/messages`, { body: 'gone soon', nonce: nonce() });
    const id = sent.body.data.message.id;
    await getPool().query(`INSERT INTO message_translations (message_id, language, translated, source_hash) VALUES ($1, 'fr', 'bientôt parti', 'h')`, [id]);
    const before = (await as(ben).get('/api/chat/conversations')).body.data.conversations.find((c: { id: string }) => c.id === conv).unread;
    expect(before).toBeGreaterThan(0);
    await getPool().query(`UPDATE messages SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);

    const told: Array<{ conversationId: string; messageIds: string[] }> = [];
    const removed = await chat.sweepExpiredMessages(500, (conversationId, messageIds) => { told.push({ conversationId, messageIds }); });
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(told.find((t) => t.conversationId === conv)?.messageIds).toContain(id);
    expect((await getPool().query('SELECT 1 FROM messages WHERE id = $1', [id])).rowCount).toBe(0);
    for (const table of ['message_translations', 'message_nonces']) {
      expect((await getPool().query(`SELECT 1 FROM ${table} WHERE message_id = $1`, [id])).rowCount).toBe(0);
    }
    const after = (await as(ben).get('/api/chat/conversations')).body.data.conversations.find((c: { id: string }) => c.id === conv).unread;
    expect(after).toBe(before - 1);
  });
});
