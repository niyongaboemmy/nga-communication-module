import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { wakeDueSnoozes } from '@tupo/mail';
import { app } from '../app.js';
import { config } from '../config.js';

/** C-08 / C-09 / C-13: one state per conversation, sender copies, labels, merge fields, sender name. */

async function user(name: string) {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>("SELECT id FROM roles WHERE name = 'Staff'");
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`,
    [id, name, `${id}@amashuri.com`, rows[0]!.id]);
  return { id, name, email: `${id}@amashuri.com`, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' }, config.jwtSecret) };
}
const as = (t: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${t}`),
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
  patch: (p: string, b?: unknown) => request(app).patch(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
  put: (p: string, b?: unknown) => request(app).put(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
});
type U = Awaited<ReturnType<typeof user>>;
const ids = (r: { body: { data: { threads: Array<{ threadId: string }> } } }) => r.body.data.threads.map((t) => t.threadId);
const folder = async (u: U, f: string, extra = '') => ids(await as(u.token).get(`/api/mail/threads?folder=${f}${extra}`));

let ada: U; let ben: U; let cy: U;
beforeAll(async () => {
  await seedRbac(getPool());
  ada = await user('Ada Mukamana'); ben = await user('Ben Habimana'); cy = await user('Cy Uwase');
});
afterAll(async () => {
  const people = [ada.id, ben.id, cy.id];
  const pool = getPool();
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [people]);
  await pool.query('DELETE FROM mail_delivery_events WHERE message_id IN (SELECT id FROM mail_messages WHERE from_user_id = ANY($1::text[]))', [people]).catch(() => {});
  await pool.query('DELETE FROM mail_recipients WHERE message_id IN (SELECT id FROM mail_messages WHERE from_user_id = ANY($1::text[]))', [people]);
  await pool.query('DELETE FROM mail_messages WHERE from_user_id = ANY($1::text[])', [people]);
  await pool.query('DELETE FROM mail_labels WHERE owner_id = ANY($1::text[])', [people]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [people]);
  await closeDb();
});

describe('one state per conversation', () => {
  it('a reply keeps the labels and brings an archived conversation back to the Inbox, once', async () => {
    const sent = (await as(ada.token).post('/api/mail/compose', { to: [ben.email], subject: 'Trip', bodyHtml: '<p>Friday?</p>' })).body.data;
    const label = (await as(ben.token).post('/api/mail/labels', { name: `trips-${sent.threadId}`, color: '#22c55e' })).body.data.label;
    await as(ben.token).post(`/api/mail/threads/${sent.threadId}/labels`, { labels: [label.id] });
    await as(ben.token).post(`/api/mail/threads/${sent.threadId}/move`, { folder: 'archive' });
    expect(await folder(ben, 'archive')).toContain(sent.threadId);

    // The label view still finds it while archived.
    expect(await folder(ben, 'inbox', `&label=${label.id}`)).toContain(sent.threadId);

    await as(ada.token).post('/api/mail/compose', { to: [ben.email], subject: 'Re: Trip', bodyHtml: '<p>Or Monday</p>', threadId: sent.threadId });
    expect(await folder(ben, 'inbox')).toContain(sent.threadId);
    expect(await folder(ben, 'archive')).not.toContain(sent.threadId);
    const thread = (await as(ben.token).get(`/api/mail/threads/${sent.threadId}`)).body.data.thread;
    expect(thread.labels ?? thread.labelIds ?? []).toContain(label.id);
  });

  it('the sender can star, trash and restore a conversation they only wrote in', async () => {
    const sent = (await as(ada.token).post('/api/mail/compose', { to: [cy.email], subject: 'Report', bodyHtml: '<p>Attached</p>' })).body.data;
    await as(ada.token).post(`/api/mail/threads/${sent.threadId}/star`, { starred: true });
    expect(await folder(ada, 'starred')).toContain(sent.threadId);
    expect(await folder(ada, 'sent')).toContain(sent.threadId);

    await as(ada.token).post(`/api/mail/threads/${sent.threadId}/move`, { folder: 'trash' });
    expect(await folder(ada, 'sent')).not.toContain(sent.threadId);
    expect(await folder(ada, 'trash')).toContain(sent.threadId);
    // Cy's copy is untouched.
    expect(await folder(cy, 'inbox')).toContain(sent.threadId);

    expect((await as(ada.token).post(`/api/mail/threads/${sent.threadId}/restore`)).status).toBe(200);
    expect(await folder(ada, 'sent')).toContain(sent.threadId);
    expect(await folder(ada, 'trash')).not.toContain(sent.threadId);
  });

  it('the sender is never listed as a recipient of their own mail', async () => {
    const sent = (await as(ada.token).post('/api/mail/compose', { to: [ben.email], subject: 'Who', bodyHtml: '<p>x</p>' })).body.data;
    const delivery = (await as(ada.token).get(`/api/mail/messages/${sent.messageId}/delivery`)).body.data;
    const list = (delivery.recipients ?? delivery) as Array<{ address: string }>;
    expect([...new Set(list.map((r) => r.address))]).toEqual([ben.email]);
  });

  it('Empty Trash removes everything in it', async () => {
    const one = (await as(ben.token).post('/api/mail/compose', { to: [cy.email], subject: 'Old', bodyHtml: '<p>1</p>' })).body.data;
    await as(cy.token).post(`/api/mail/threads/${one.threadId}/move`, { folder: 'trash' });
    const r = await as(cy.token).post('/api/mail/trash/empty');
    expect(r.body.data.removed).toBeGreaterThanOrEqual(1);
    expect(await folder(cy, 'trash')).toEqual([]);
  });
});

describe('labels', () => {
  it('can be renamed and recoloured', async () => {
    const label = (await as(ada.token).post('/api/mail/labels', { name: 'Old name', color: '#6366f1' })).body.data.label;
    const r = await as(ada.token).patch(`/api/mail/labels/${label.id}`, { name: 'New name', color: '#ef4444' });
    expect(r.body.data.label).toMatchObject({ name: 'New name', color: '#ef4444' });
    expect((await as(ada.token).patch(`/api/mail/labels/${label.id}`, { color: 'red; x' })).status).toBe(400);
    expect((await as(ben.token).patch(`/api/mail/labels/${label.id}`, { name: 'Mine now' })).status).toBe(404);
  });
});

describe('who it is from, and merge fields', () => {
  it('mail is sent under the account name, not a chosen display name', async () => {
    await as(ada.token).put('/api/mail/prefs', { displayName: 'Head Teacher (Official Notice)' });
    const sent = (await as(ada.token).post('/api/mail/compose', { to: [ben.email], subject: 'Hi', bodyHtml: '<p>x</p>' })).body.data;
    const thread = (await as(ben.token).get(`/api/mail/threads/${sent.threadId}`)).body.data.thread;
    expect(JSON.stringify(thread)).toContain('Ada Mukamana');
    expect(JSON.stringify(thread)).not.toContain('Head Teacher (Official Notice)');
  });

  it('fills merge fields for one recipient and refuses them otherwise', async () => {
    const one = await as(ada.token).post('/api/mail/compose', { to: [ben.email], subject: 'Fees for {{first_name}}', bodyHtml: '<p>Dear {{first_name}}, fees due.</p>' });
    expect(one.status).toBe(201);
    const thread = (await as(ben.token).get(`/api/mail/threads/${one.body.data.threadId}`)).body.data.thread;
    expect(JSON.stringify(thread)).toContain('Dear Ben, fees due.');
    const many = await as(ada.token).post('/api/mail/compose', { to: [ben.email, cy.email], subject: 'x', bodyHtml: '<p>Dear {{first_name}}</p>' });
    expect(many.status).toBe(400);
    const unknown = await as(ada.token).post('/api/mail/compose', { to: [ben.email], subject: 'x', bodyHtml: '<p>Balance {{amount}}</p>' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toContain('{{amount}}');
  });
});

describe('snooze (U-10)', () => {
  it('leaves the Inbox until the time, then comes back unread; and can be woken early', async () => {
    const sent = await as(ada.token).post('/api/mail/compose', { to: [`userId:${ben.id}`], subject: `Snooze me ${snowflake()}`, bodyHtml: '<p>later</p>' });
    const thread = sent.body.data.threadId;
    await as(ben.token).post(`/api/mail/threads/${thread}/read`, { read: true });
    expect((await as(ben.token).post(`/api/mail/threads/${thread}/snooze`, { until: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    expect((await as(ben.token).post(`/api/mail/threads/${thread}/snooze`, { until: new Date(Date.now() + 2 * 3_600_000).toISOString() })).status).toBe(200);
    expect(await folder(ben, 'inbox')).not.toContain(thread);
    expect(await folder(ben, 'snoozed')).toContain(thread);
    // Someone not in the conversation cannot snooze it.
    expect((await as(cy.token).post(`/api/mail/threads/${thread}/snooze`, { until: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(404);

    // Its time comes: the sweep puts it back, unread.
    await getPool().query(`UPDATE mail_recipients SET snoozed_until = now() - interval '1 minute' WHERE thread_id = $1 AND folder = 'snoozed'`, [thread]);
    const woken = await wakeDueSnoozes();
    expect(woken.some((w) => w.threadId === thread && w.userId === ben.id)).toBe(true);
    expect(await folder(ben, 'inbox')).toContain(thread);
    const unread = (await getPool().query(`SELECT bool_or(NOT is_read) AS u FROM mail_recipients WHERE thread_id = $1 AND user_id = $2`, [thread, ben.id])).rows[0].u;
    expect(unread).toBe(true);

    // Woken early by hand.
    await as(ben.token).post(`/api/mail/threads/${thread}/snooze`, { until: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await as(ben.token).post(`/api/mail/threads/${thread}/snooze`, { until: null })).status).toBe(200);
    expect(await folder(ben, 'inbox')).toContain(thread);
  });
});

