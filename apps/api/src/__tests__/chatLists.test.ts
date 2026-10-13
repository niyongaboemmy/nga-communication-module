import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'node:crypto';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';

/** B-12 / B-13: the Links tab, directory paging, hidden DMs and timed mute. */

async function user(name: string): Promise<{ id: string; token: string }> {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>(`SELECT id FROM roles WHERE name = 'Staff'`);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`,
    [id, name, `${id}@amashuri.com`, rows[0]!.id]);
  return { id, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' }, config.jwtSecret, { expiresIn: '15m' }) };
}
const nonce = () => randomBytes(8).toString('hex');
const tag = randomBytes(3).toString('hex');
const as = (u: { token: string }) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${u.token}`),
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${u.token}`).send(b ?? {}),
  patch: (p: string, b?: unknown) => request(app).patch(p).set('Authorization', `Bearer ${u.token}`).send(b ?? {}),
});

let ada: { id: string; token: string };
let ben: { id: string; token: string };

beforeAll(async () => {
  await seedRbac(getPool());
  ada = await user(`Ada ${tag}`); ben = await user(`Ben ${tag}`);
});
afterAll(async () => { await closeDb(); });

describe('links', () => {
  it('lists links shared in a conversation, newest first, without deleted messages', async () => {
    const conv = (await as(ada).post('/api/chat/conversations', { type: 'group', name: `links-${tag}`, memberIds: [ben.id] })).body.data.conversation.id;
    const add = async (url: string, title: string) => {
      const m = (await as(ada).post(`/api/chat/conversations/${conv}/messages`, { body: `see ${url}`, nonce: nonce() })).body.data.message;
      const hash = createHash('sha256').update(`${url}${tag}`).digest('hex');
      await getPool().query(`INSERT INTO link_previews (url_hash, url, title, status) VALUES ($1,$2,$3,'ok') ON CONFLICT DO NOTHING`, [hash, url, title]);
      await getPool().query(`INSERT INTO message_links (message_id, conversation_id, url_hash, ordinal) VALUES ($1,$2,$3,0)`, [m.id, conv, hash]);
      return m;
    };
    await add('https://a.example/one', 'One');
    const second = await add('https://b.example/two', 'Two');
    const res = await as(ben).get(`/api/chat/conversations/${conv}/links`);
    expect(res.body.data.links.map((l: { title: string }) => l.title)).toEqual(['Two', 'One']);
    await as(ada).post(`/api/chat/conversations/${conv}/messages/${second.id}`, {}).catch(() => {});
    await request(app).delete(`/api/chat/conversations/${conv}/messages/${second.id}`).set('Authorization', `Bearer ${ada.token}`);
    expect((await as(ben).get(`/api/chat/conversations/${conv}/links`)).body.data.links.map((l: { title: string }) => l.title)).toEqual(['One']);
    const outsider = await user('Out');
    expect([403, 404]).toContain((await as(outsider).get(`/api/chat/conversations/${conv}/links`)).status);
  });
});

describe('directory paging', () => {
  it('pages through more people than one screen', async () => {
    for (let i = 0; i < 23; i++) await user(`Dirpage ${tag} ${String(i).padStart(2, '0')}`);
    const first = (await as(ada).get(`/api/chat/directory?q=Dirpage%20${tag}&limit=20`)).body.data;
    expect(first.people).toHaveLength(20);
    expect(first.nextOffset).toBe(20);
    const rest = (await as(ada).get(`/api/chat/directory?q=Dirpage%20${tag}&limit=20&offset=20`)).body.data;
    expect(rest.people).toHaveLength(3);
    expect(rest.nextOffset).toBeNull();
  });
});

describe('hidden DMs and timed mute', () => {
  it('a hidden DM leaves the list and comes back when the other person writes', async () => {
    const dm = (await as(ada).post('/api/chat/conversations/direct', { userId: ben.id })).body.data.conversation.id;
    await as(ben).post(`/api/chat/conversations/${dm}/messages`, { body: 'hello', nonce: nonce() });
    const hid = await as(ada).patch(`/api/chat/conversations/${dm}/prefs`, { hidden: true });
    expect(hid.status, JSON.stringify(hid.body)).toBe(200);
    const listed = async () => (await as(ada).get('/api/chat/conversations')).body.data.conversations.some((c: { id: string }) => c.id === dm);
    expect(await listed()).toBe(false);
    await as(ben).post(`/api/chat/conversations/${dm}/messages`, { body: 'are you there?', nonce: nonce() });
    expect(await listed()).toBe(true);
  });

  it('only a DM can be hidden', async () => {
    const group = (await as(ada).post('/api/chat/conversations', { type: 'group', name: `hide-${tag}`, memberIds: [ben.id] })).body.data.conversation.id;
    expect((await as(ada).patch(`/api/chat/conversations/${group}/prefs`, { hidden: true })).status).toBe(400);
  });

  it('a timed mute is stored and reported', async () => {
    const group = (await as(ada).post('/api/chat/conversations', { type: 'group', name: `mute-${tag}`, memberIds: [ben.id] })).body.data.conversation.id;
    const until = new Date(Date.now() + 3600_000).toISOString();
    const res = await as(ben).patch(`/api/chat/conversations/${group}/prefs`, { mutedUntil: until });
    expect(new Date(res.body.data.conversation.mutedUntil).getTime()).toBe(new Date(until).getTime());
  });
});

describe('invite management', () => {
  it('lists working invite links and revokes them', async () => {
    const group = (await as(ada).post('/api/chat/conversations', { type: 'group', name: `inv-${tag}`, memberIds: [ben.id] })).body.data.conversation.id;
    const made = (await as(ada).post(`/api/chat/conversations/${group}/invites`, { expiresInHours: 24, maxUses: 10 })).body.data.invite;
    const list = (await as(ada).get(`/api/chat/conversations/${group}/invites`)).body.data.invites;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ code: made.code, maxUses: 10, uses: 0, createdByName: `Ada ${tag}` });
    // A plain member does not manage invites.
    expect((await as(ben).get(`/api/chat/conversations/${group}/invites`)).status).toBe(403);
    expect((await request(app).delete(`/api/chat/invites/${made.code}`).set('Authorization', `Bearer ${ada.token}`)).status).toBe(200);
    expect((await as(ada).get(`/api/chat/conversations/${group}/invites`)).body.data.invites).toHaveLength(0);
  });
});

describe('mark unread from here', () => {
  it('makes everything from a chosen message new again', async () => {
    const group = (await as(ada).post('/api/chat/conversations', { type: 'group', name: `mu-${tag}`, memberIds: [ben.id] })).body.data.conversation.id;
    const sent = [];
    for (const body of ['one', 'two', 'three', 'four']) {
      sent.push((await as(ada).post(`/api/chat/conversations/${group}/messages`, { body, nonce: nonce() })).body.data.message);
    }
    await as(ben).post(`/api/chat/conversations/${group}/read`, { latest: true });
    const res = await as(ben).post(`/api/chat/conversations/${group}/unread`, { seq: sent[1].seq });
    expect(res.status).toBe(200);
    expect(res.body.data.unread).toBe(3);
    expect(res.body.data.lastReadSeq).toBe(sent[1].seq - 1);
  });
});
