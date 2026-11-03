import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';
import { purgeTestUsers } from './purge.js';

const created: string[] = [];

/** B-11 / CHAT-M5: polls badge and notify like messages, votes are atomic, archived means read-only. */

async function user(name: string, role = 'Admin'): Promise<{ id: string; token: string }> {
  const id = snowflake();
  created.push(id);
  const { rows } = await getPool().query<{ id: number }>(`SELECT id FROM roles WHERE name = $1`, [role]);
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
  conv = (await as(ada).post('/api/chat/conversations', { type: 'group', name: `poll-${nonce()}`, memberIds: [ben.id] })).body.data.conversation.id;
});
afterAll(async () => { await purgeTestUsers(created); await closeDb(); });

describe('polls', () => {
  it('a new poll badges and notifies like a message', async () => {
    const res = await as(ada).post(`/api/chat/conversations/${conv}/polls`, { question: 'Trip day?', options: ['Thu', 'Fri'] });
    expect(res.status).toBe(201);
    const row = (await as(ben).get('/api/chat/conversations')).body.data.conversations.find((c: { id: string }) => c.id === conv);
    expect(row.unread).toBeGreaterThan(0);
    const { rows } = await getPool().query(`SELECT 1 FROM notifications WHERE user_id = $1 AND subject_id = $2`, [ben.id, conv]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('two votes at once on a single-choice poll leave one', async () => {
    const { poll } = (await as(ada).post(`/api/chat/conversations/${conv}/polls`, { question: 'Colour?', options: ['Red', 'Blue'] })).body.data;
    await Promise.all([
      as(ben).post(`/api/chat/polls/${poll.id}/vote`, { optionIds: ['o0'] }),
      as(ben).post(`/api/chat/polls/${poll.id}/vote`, { optionIds: ['o1'] }),
      as(ben).post(`/api/chat/polls/${poll.id}/vote`, { optionIds: ['o0'] }),
    ]);
    const { rows } = await getPool().query('SELECT option_id FROM poll_votes WHERE poll_id = $1 AND user_id = $2', [poll.id, ben.id]);
    expect(rows).toHaveLength(1);
  });

  it('refuses votes once the conversation is archived', async () => {
    const { poll } = (await as(ada).post(`/api/chat/conversations/${conv}/polls`, { question: 'Last one?', options: ['Yes', 'No'] })).body.data;
    await getPool().query('UPDATE conversations SET is_archived = true WHERE id = $1', [conv]);
    const res = await as(ben).post(`/api/chat/polls/${poll.id}/vote`, { optionIds: ['o0'] });
    expect(res.status).toBe(409);
    await getPool().query('UPDATE conversations SET is_archived = false WHERE id = $1', [conv]);
  });

  it('refuses a closing time in the past or not a date', async () => {
    for (const closesAt of ['2001-01-01T00:00:00Z', 'tomorrow-ish']) {
      const res = await as(ada).post(`/api/chat/conversations/${conv}/polls`, { question: 'Q?', options: ['A', 'B'], closesAt });
      expect(res.status).toBe(400);
    }
  });
});
