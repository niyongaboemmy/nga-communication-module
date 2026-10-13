import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { notify } from '@tupo/notify';
import { app } from '../app.js';
import { config } from '../config.js';

/** F-01: the notification centre — paging, module filter, bulk read, and reading the thing clears it. */

async function user(role: string, name: string) {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [role]);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, role.toLowerCase(), rows[0]!.id]);
  users.push(id);
  return { id, email: `${id}@amashuri.com`, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: role.toLowerCase() }, config.jwtSecret) };
}
const as = (t: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${t}`),
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
});
const nonce = () => randomBytes(8).toString('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const users: string[] = [];
const convs: string[] = [];
let ann: Awaited<ReturnType<typeof user>>;
let bob: Awaited<ReturnType<typeof user>>;

beforeAll(async () => {
  await seedRbac(getPool());
  ann = await user('Staff', 'Ann');
  bob = await user('Staff', 'Bob');
});

afterAll(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM messages WHERE conversation_id = ANY($1::text[])', [convs]);
  await pool.query('DELETE FROM conversation_members WHERE conversation_id = ANY($1::text[])', [convs]);
  await pool.query('DELETE FROM conversations WHERE id = ANY($1::text[])', [convs]);
  await pool.query('DELETE FROM mail_recipients WHERE message_id IN (SELECT id FROM mail_messages WHERE from_user_id = ANY($1::text[]))', [users]);
  await pool.query('DELETE FROM mail_messages WHERE from_user_id = ANY($1::text[])', [users]);
  await pool.query('DELETE FROM mail_threads WHERE created_by = ANY($1::text[])', [users]).catch(() => {});
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [users]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
  await closeDb();
});

describe('listing', () => {
  it('pages by time and filters by module', async () => {
    for (let i = 0; i < 5; i++) {
      await notify([bob.id], { kind: i % 2 ? 'mail.received' : 'chat.mention', title: `n${i}`, subjectType: 'test', subjectId: `s${i}` });
      await sleep(5);
    }
    const first = await as(bob.token).get('/api/notifications?limit=2');
    expect(first.body.data.notifications).toHaveLength(2);
    const next = await as(bob.token).get(`/api/notifications?limit=2&before=${encodeURIComponent(first.body.data.nextBefore)}`);
    const ids = new Set([...first.body.data.notifications, ...next.body.data.notifications].map((n: { id: string }) => n.id));
    expect(ids.size).toBe(4);
    const mail = await as(bob.token).get('/api/notifications?module=mail');
    expect(mail.body.data.notifications.every((n: { kind: string }) => n.kind.startsWith('mail.'))).toBe(true);
    expect(mail.body.data.notifications.length).toBeGreaterThanOrEqual(2);
  });

  it('marks a set read at once, and everything read', async () => {
    const list = (await as(bob.token).get('/api/notifications?unread=true')).body.data;
    const two = list.notifications.slice(0, 2).map((n: { id: string }) => n.id);
    const r = await as(bob.token).post('/api/notifications/read', { ids: two });
    expect(r.body.data.read).toBe(2);
    expect(r.body.data.unread).toBe(list.unread - 2);
    expect((await as(bob.token).post('/api/notifications/read-all')).body.data.unread).toBe(0);
  });

  it('cannot touch someone else’s notifications', async () => {
    const [n] = await notify([ann.id], { kind: 'chat.mention', title: 'mine', subjectType: 'test', subjectId: 'x' });
    expect((await as(bob.token).post(`/api/notifications/${n!.id}/read`)).status).toBe(404);
    expect((await as(bob.token).post('/api/notifications/read', { ids: [n!.id] })).body.data.read).toBe(0);
  });
});

describe('reading the thing clears its notifications', () => {
  it('a conversation read to the end clears its notifications', async () => {
    const dm = (await as(ann.token).post('/api/chat/conversations/direct', { userId: bob.id })).body.data.conversation.id;
    convs.push(dm);
    const m = (await as(ann.token).post(`/api/chat/conversations/${dm}/messages`, { body: 'hi bob', nonce: nonce() })).body.data.message;
    await sleep(200);
    const unreadBefore = (await as(bob.token).get('/api/notifications?unread=true&module=chat')).body.data.notifications
      .filter((n: { subjectId: string }) => n.subjectId === dm);
    expect(unreadBefore.length).toBeGreaterThan(0);
    await as(bob.token).post(`/api/chat/conversations/${dm}/read`, { seq: m.seq });
    await sleep(200);
    const after = (await as(bob.token).get('/api/notifications?unread=true&module=chat')).body.data.notifications
      .filter((n: { subjectId: string }) => n.subjectId === dm);
    expect(after).toHaveLength(0);
  });

  it('opening a mail thread clears the mail notification', async () => {
    const sent = await as(ann.token).post('/api/mail/compose', { to: [bob.email], subject: 'Clear me', bodyHtml: '<p>x</p>' });
    await sleep(200);
    const tid = sent.body.data.threadId;
    const before = (await as(bob.token).get('/api/notifications?unread=true&module=mail')).body.data.notifications.length;
    expect(before).toBeGreaterThan(0);
    await as(bob.token).get(`/api/mail/threads/${tid}`);
    await sleep(200);
    expect((await as(bob.token).get('/api/notifications?unread=true&module=mail')).body.data.notifications).toHaveLength(0);
  });
});
