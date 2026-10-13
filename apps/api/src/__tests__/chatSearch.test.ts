import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';
import { purgeTestUsers } from './purge.js';

const created: string[] = [];

/** B-12: message search matches while a word is still being typed, and only where the viewer belongs. */

async function user(name: string): Promise<{ id: string; token: string }> {
  const id = snowflake();
  created.push(id);
  const { rows } = await getPool().query<{ id: number }>(`SELECT id FROM roles WHERE name = 'Staff'`);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`,
    [id, name, `${id}@amashuri.com`, rows[0]!.id]);
  return { id, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' }, config.jwtSecret, { expiresIn: '15m' }) };
}
const nonce = () => randomBytes(8).toString('hex');
const search = async (token: string, q: string) =>
  (await request(app).get(`/api/chat/search?q=${encodeURIComponent(q)}`).set('Authorization', `Bearer ${token}`)).body.data.hits as Array<{ message: { body: string } }>;

let ada: { id: string; token: string };
let outsider: { id: string; token: string };
const tag = randomBytes(3).toString('hex');

beforeAll(async () => {
  await seedRbac(getPool());
  ada = await user('Ada'); const ben = await user('Ben'); outsider = await user('Out');
  const conv = (await request(app).post('/api/chat/conversations').set('Authorization', `Bearer ${ada.token}`)
    .send({ type: 'group', name: `search-${tag}`, memberIds: [ben.id] })).body.data.conversation.id;
  await request(app).post(`/api/chat/conversations/${conv}/messages`).set('Authorization', `Bearer ${ben.token}`)
    .send({ body: `Remember the homework${tag} assignment for Thursday`, nonce: nonce() });
});
afterAll(async () => { await purgeTestUsers(created); await closeDb(); });

describe('GET /api/chat/search', () => {
  it('finds a word from its first letters', async () => {
    expect((await search(ada.token, `homework${tag}`.slice(0, 7 + 3))).length).toBe(1);
    expect((await search(ada.token, `homew`)).some((h) => h.message.body.includes(tag))).toBe(true);
    expect((await search(ada.token, `assign thurs`)).some((h) => h.message.body.includes(tag))).toBe(true);
  });

  it('keeps quoted phrases exact and is safe with query syntax', async () => {
    expect((await search(ada.token, '"assignment thursday"')).some((h) => h.message.body.includes(tag))).toBe(false);
    expect(Array.isArray(await search(ada.token, `homew & | ! :* (`))).toBe(true);
  });

  it('never shows a conversation the viewer is not in', async () => {
    expect((await search(outsider.token, 'homew')).some((h) => h.message.body.includes(tag))).toBe(false);
  });
});
