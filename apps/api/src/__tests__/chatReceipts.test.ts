import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import * as chat from '@tupo/chat';
import { app } from '../app.js';
import { config } from '../config.js';
import { purgeTestUsers } from './purge.js';

const created: string[] = [];

/** B-11 / CHAT-H7: honest ticks — weakest state across recipients — and reciprocity. */

async function user(name: string): Promise<{ id: string; token: string }> {
  const id = snowflake();
  created.push(id);
  const { rows } = await getPool().query<{ id: number }>(`SELECT id FROM roles WHERE name = 'Staff'`);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`,
    [id, name, `${id}@amashuri.com`, rows[0]!.id]);
  return { id, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' }, config.jwtSecret, { expiresIn: '15m' }) };
}
const nonce = () => randomBytes(8).toString('hex');
const as = (u: { token: string }) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${u.token}`),
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${u.token}`).send(b ?? {}),
  patch: (p: string, b?: unknown) => request(app).patch(p).set('Authorization', `Bearer ${u.token}`).send(b ?? {}),
});
const tickOf = async (u: { token: string }, conv: string, id: string) =>
  ((await as(u).get(`/api/chat/conversations/${conv}/messages`)).body.data.messages as Array<{ id: string; delivery: string }>)
    .find((m) => m.id === id)?.delivery;

beforeAll(async () => { await seedRbac(getPool()); });
afterAll(async () => { await purgeTestUsers(created); await closeDb(); });

describe('deliveryState', () => {
  it('is the weakest state across recipients', () => {
    expect(chat.deliveryState(3, 1, 0)).toBe('sent');
    expect(chat.deliveryState(3, 2, 0)).toBe('delivered');
    expect(chat.deliveryState(3, 2, 1)).toBe('delivered');
    expect(chat.deliveryState(3, 2, 2)).toBe('read');
    expect(chat.deliveryState(2, 1, 0)).toBe('delivered');
  });
});

describe('ticks over the API', () => {
  it('a group message goes sent → delivered → read as every member gets and reads it', async () => {
    const ada = await user('Ada'); const ben = await user('Ben'); const cy = await user('Cy');
    const conv = (await as(ada).post('/api/chat/conversations', { type: 'group', name: `rc-${nonce()}`, memberIds: [ben.id, cy.id] })).body.data.conversation.id;
    const msg = (await as(ada).post(`/api/chat/conversations/${conv}/messages`, { body: 'hi all', nonce: nonce() })).body.data.message;
    expect(await tickOf(ada, conv, msg.id)).toBe('sent');
    expect(await chat.markDelivered(ben.id, conv, [msg.id])).toEqual([msg.id]);
    expect(await tickOf(ada, conv, msg.id)).toBe('sent');
    await chat.markDelivered(cy.id, conv, [msg.id]);
    expect(await tickOf(ada, conv, msg.id)).toBe('delivered');
    await as(ben).post(`/api/chat/conversations/${conv}/read`, { seq: msg.seq });
    expect(await tickOf(ada, conv, msg.id)).toBe('delivered');
    await as(cy).post(`/api/chat/conversations/${conv}/read`, { seq: msg.seq });
    expect(await tickOf(ada, conv, msg.id)).toBe('read');
    // The update for Ada carries the same answer.
    const [u] = await chat.receiptUpdatesFor(conv, [msg.id]);
    expect(u).toMatchObject({ senderId: ada.id, payload: { delivery: 'read', readCount: 2 } });
  });

  it('reciprocity: private readers send no reads, and a private sender sees none', async () => {
    const ada = await user('Ada'); const ben = await user('Ben');
    const conv = (await as(ada).post('/api/chat/conversations/direct', { userId: ben.id })).body.data.conversation.id;
    const msg = (await as(ada).post(`/api/chat/conversations/${conv}/messages`, { body: 'did you see?', nonce: nonce() })).body.data.message;
    await as(ben).patch('/api/chat/prefs', { readReceipts: false });
    expect(await chat.markRead(ben.id, conv, msg.seq)).toEqual([]);
    await chat.markDelivered(ben.id, conv, [msg.id]);
    expect(await tickOf(ada, conv, msg.id)).toBe('delivered');

    await as(ben).patch('/api/chat/prefs', { readReceipts: true });
    await as(ben).post(`/api/chat/conversations/${conv}/read`, { seq: msg.seq });
    expect(await tickOf(ada, conv, msg.id)).toBe('read');
    await as(ada).patch('/api/chat/prefs', { readReceipts: false });
    expect(await tickOf(ada, conv, msg.id)).toBe('delivered');
    const [u] = await chat.receiptUpdatesFor(conv, [msg.id]);
    expect(u!.payload).toMatchObject({ delivery: 'delivered', readCount: 0 });
  });

  it('a read only touches what was new since the last one (S-12 / CHAT-M8)', async () => {
    const ada = await user('Ada'); const ben = await user('Ben');
    const conv = (await as(ada).post('/api/chat/conversations', { type: 'group', name: `rc-${nonce()}`, memberIds: [ben.id] })).body.data.conversation.id;
    const sent = [];
    for (let i = 0; i < 5; i++) sent.push((await as(ada).post(`/api/chat/conversations/${conv}/messages`, { body: `m${i}`, nonce: nonce() })).body.data.message);
    const first = await chat.advanceRead(ben.id, conv, sent[2].seq);
    expect(first.previousSeq).toBe(0);
    // The first three, plus the group's creation notice (seq 1).
    expect(await chat.markRead(ben.id, conv, sent[2].seq, first.previousSeq)).toEqual(expect.arrayContaining(sent.slice(0, 3).map((m) => m.id)));
    const second = await chat.advanceRead(ben.id, conv, sent[4].seq);
    expect(second.previousSeq).toBe(sent[2].seq);
    // Only the two new ones — not a walk over the whole history again.
    expect((await chat.markRead(ben.id, conv, sent[4].seq, second.previousSeq)).sort())
      .toEqual([sent[3].id, sent[4].id].sort());
    expect(await tickOf(ada, conv, sent[0].id)).toBe('read');
    expect(await tickOf(ada, conv, sent[4].id)).toBe('read');
  });
});
