import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { sanitizeMailHtml, sendDueScheduled, threadPlainText } from '@tupo/mail';
import { app } from '../app.js';
import { config } from '../config.js';

/** C-01 / C-02: mailbox listing only accepts known folders; mail HTML is stored clean. */

async function user(role: 'Staff' | 'Student', name: string) {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [role]);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, role.toLowerCase(), rows[0]!.id]);
  return { id, email: `${id}@amashuri.com`, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: role.toLowerCase() }, config.jwtSecret) };
}
const as = (t: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${t}`),
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
});

let ada: Awaited<ReturnType<typeof user>>;
let ben: Awaited<ReturnType<typeof user>>;
let stu: Awaited<ReturnType<typeof user>>;

beforeAll(async () => {
  await seedRbac(getPool());
  ada = await user('Staff', 'Ada');
  ben = await user('Staff', 'Ben');
  stu = await user('Student', 'Stu');
});
afterAll(async () => {
  const ids = [ada.id, ben.id, stu.id];
  const pool = getPool();
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [ids]);
  await pool.query('DELETE FROM mail_delivery_events WHERE recipient_id IN (SELECT id FROM mail_recipients WHERE user_id = ANY($1::text[]))', [ids]).catch(() => {});
  await pool.query('DELETE FROM mail_recipients WHERE message_id IN (SELECT id FROM mail_messages WHERE from_user_id = ANY($1::text[]))', [ids]);
  await pool.query('DELETE FROM mail_messages WHERE from_user_id = ANY($1::text[])', [ids]);
  await pool.query('DELETE FROM mail_threads WHERE created_by = ANY($1::text[])', [ids]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [ids]);
  await closeDb();
});

describe('mailbox folder parameter', () => {
  it('rejects anything that is not a known folder', async () => {
    for (const folder of ['nope', "inbox'", 'inbox OR 1', '']) {
      const r = await as(stu.token).get(`/api/mail/threads?folder=${encodeURIComponent(folder)}`);
      expect(folder === '' ? r.status : r.status).toBe(folder === '' ? 200 : 400);
    }
  });

  it('a student sees none of another person’s threads, whatever is asked', async () => {
    await as(ada.token).post('/api/mail/compose', { to: [ben.email], subject: 'private to ben', bodyHtml: '<p>hi</p>' });
    for (const folder of ['inbox', 'archive', 'starred', 'trash', 'sent']) {
      const r = await as(stu.token).get(`/api/mail/threads?folder=${folder}`);
      expect(JSON.stringify(r.body)).not.toContain('private to ben');
    }
  });
});

describe('mail HTML policy', () => {
  it('keeps the editor’s formatting', () => {
    const html = '<h2>Title</h2><p style="text-align:center">Hi <strong>all</strong> <a href="https://nga.ac.rw">site</a></p><ul><li>one</li></ul>';
    const clean = sanitizeMailHtml(html);
    expect(clean).toContain('<h2>Title</h2>');
    expect(clean).toContain('text-align:center');
    expect(clean).toContain('<strong>all</strong>');
    expect(clean).toContain('href="https://nga.ac.rw"');
  });

  it('drops script, event handlers, unsafe schemes and non-image data URIs', () => {
    const clean = sanitizeMailHtml(
      '<p onclick="x()">a</p><script>x()</script><img src="x" onerror="x()"><a href="javascript:x()">b</a>'
      + '<img src="data:text/html;base64,AAAA"><iframe src="https://e.x"></iframe><p style="background:url(https://e.x)">c</p>');
    expect(clean).not.toMatch(/onclick|onerror|<script|javascript:|data:text|<iframe|url\(/i);
  });

  it('what is stored for a sent message is already clean', async () => {
    const sent = await as(ada.token).post('/api/mail/compose', {
      to: [ben.email], subject: 'stored clean', bodyHtml: '<p>hello</p><img src=x onerror="x()"><script>x()</script>',
    });
    expect(sent.status).toBeLessThan(300);
    const { rows } = await getPool().query('SELECT body_html FROM mail_messages WHERE id = $1', [sent.body.data.messageId]);
    expect(rows[0].body_html).toContain('<p>hello</p>');
    expect(rows[0].body_html).not.toMatch(/onerror|<script/i);
  });
});

describe('unsent mail is invisible to its recipients', () => {
  const inbox = async (t: string) => JSON.stringify((await as(t).get('/api/mail/threads?folder=inbox')).body);
  const unread = async (t: string) => (await as(t).get('/api/mail/counts')).body.data.counts.inbox as number;

  it('a draft never reaches the recipient — not the list, not the count', async () => {
    const before = await unread(ben.token);
    const d = await as(ada.token).post('/api/mail/compose', { to: [ben.email], subject: 'HALF-WRITTEN', bodyHtml: '<p>wip</p>', draft: true });
    expect(d.status).toBeLessThan(300);
    expect(await inbox(ben.token)).not.toContain('HALF-WRITTEN');
    expect(await unread(ben.token)).toBe(before);
    expect((await as(ben.token).get(`/api/mail/threads/${d.body.data.threadId}`)).status).toBe(404);
  });

  it('a student’s draft cannot put anything in a staff inbox', async () => {
    await as(stu.token).post('/api/mail/compose', { to: [ada.email], subject: 'STUDENT DRAFT', bodyHtml: '<p>x</p>', draft: true });
    expect(await inbox(ada.token)).not.toContain('STUDENT DRAFT');
  });

  it('scheduled mail appears only when it is sent, and then normally', async () => {
    const at = new Date(Date.now() + 3 * 864e5).toISOString();
    const r = await as(ada.token).post('/api/mail/compose', { to: [ben.email], subject: 'EMBARGOED', bodyHtml: '<p>later</p>', scheduledAt: at });
    expect(r.body.data.scheduled).toBe(true);
    expect(await inbox(ben.token)).not.toContain('EMBARGOED');

    // Its time comes.
    await getPool().query(`UPDATE mail_messages SET scheduled_at = now() - interval '1 minute' WHERE id = $1`, [r.body.data.messageId]);
    await sendDueScheduled();
    expect(await inbox(ben.token)).toContain('EMBARGOED');
  });

  it('cancelling a scheduled send keeps everyone it was addressed to', async () => {
    const at = new Date(Date.now() + 864e5).toISOString();
    const r = await as(ada.token).post('/api/mail/compose', { to: [ben.email], subject: 'CANCEL ME', bodyHtml: '<p>x</p>', scheduledAt: at });
    expect((await as(ada.token).post(`/api/mail/messages/${r.body.data.messageId}/cancel`)).status).toBe(200);
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM mail_recipients WHERE message_id = $1', [r.body.data.messageId]);
    expect(rows[0].n).toBeGreaterThan(0);
    expect(await inbox(ben.token)).not.toContain('CANCEL ME');
  });

  it('a reply draft in an existing thread does not change what the recipient sees', async () => {
    const first = await as(ada.token).post('/api/mail/compose', { to: [ben.email], subject: 'Visible thread', bodyHtml: '<p>first line</p>' });
    const tid = first.body.data.threadId;
    await as(ada.token).post('/api/mail/compose', {
      to: [ben.email], subject: 'Re: Visible thread', bodyHtml: '<p>SECRET DRAFT LINE</p>', threadId: tid, draft: true,
    });
    expect(await inbox(ben.token)).not.toContain('SECRET DRAFT LINE');
    const view = await as(ben.token).get(`/api/mail/threads/${tid}`);
    expect(JSON.stringify(view.body)).not.toContain('SECRET DRAFT LINE');
  });
});

describe('mail counts', () => {
  it('count conversations, not copies: one mail is one unread even with email copies on', async () => {
    const before = (await as(ben.token).get('/api/mail/counts')).body.data.counts.inbox as number;
    const r = await as(ada.token).post('/api/mail/compose', { to: [ben.email], subject: 'count me once', bodyHtml: '<p>x</p>' });
    expect(r.status).toBeLessThan(300);
    const after = (await as(ben.token).get('/api/mail/counts')).body.data.counts.inbox as number;
    expect(after - before).toBe(1);
    const thread = (await as(ben.token).get(`/api/mail/threads/${r.body.data.threadId}`)).body.data.thread;
    const names = thread.messages[0].to.map((p: { address: string }) => p.address);
    expect(new Set(names).size).toBe(names.length);
  });

  it('a reply in a thread whose first notification was read raises a fresh one', async () => {
    const first = await as(ada.token).post('/api/mail/compose', { to: [ben.email], subject: 'thread notify', bodyHtml: '<p>1</p>' });
    await getPool().query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND kind = 'mail.received'`, [ben.id]);
    await as(ada.token).post('/api/mail/compose', {
      to: [ben.email], subject: 'Re: thread notify', bodyHtml: '<p>2</p>', threadId: first.body.data.threadId,
    });
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'mail.received' AND read_at IS NULL`, [ben.id]);
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });
});

describe('per-message visibility (C-04)', () => {
  it('a private reply inside a shared thread reaches only who it was sent to', async () => {
    const cal = await user('Staff', 'Cal');
    try {
      const first = await as(ada.token).post('/api/mail/compose', {
        to: [ben.email, cal.email], subject: 'Shared plan', bodyHtml: '<p>shared opening line</p>' });
      const tid = first.body.data.threadId;
      // Ben replies to Ada only, in the same thread.
      const reply = await as(ben.token).post('/api/mail/compose', {
        to: [ada.email], subject: 'Re: Shared plan', bodyHtml: '<p>PRIVATE ZEBRA REPLY</p>', threadId: tid });
      expect(reply.status).toBeLessThan(300);

      // Cal: still sees the thread and the opening, never the reply.
      const view = await as(cal.token).get(`/api/mail/threads/${tid}`);
      expect(view.status).toBe(200);
      expect(JSON.stringify(view.body)).toContain('shared opening line');
      expect(JSON.stringify(view.body)).not.toContain('PRIVATE ZEBRA REPLY');
      expect(view.body.data.thread.messages).toHaveLength(1);

      const list = await as(cal.token).get('/api/mail/threads?folder=inbox');
      const row = list.body.data.threads.find((t: { threadId: string }) => t.threadId === tid);
      expect(row.messageCount).toBe(1);
      expect(row.snippet).not.toContain('ZEBRA');
      expect(row.participants.map((p: { userId: string }) => p.userId)).not.toContain(undefined);

      const searched = await as(cal.token).get('/api/search?q=ZEBRA&types=mail');
      expect(JSON.stringify(searched.body)).not.toContain(tid);
      const listSearch = await as(cal.token).get('/api/mail/threads?folder=inbox&q=ZEBRA');
      expect(listSearch.body.data.threads).toHaveLength(0);

      const ai = await threadPlainText(cal.id, tid);
      expect(ai.text).not.toContain('ZEBRA');

      // Ada, who was sent it, sees both — in the view, the list and search.
      const adaView = await as(ada.token).get(`/api/mail/threads/${tid}`);
      expect(adaView.body.data.thread.messages).toHaveLength(2);
      const adaSearch = await as(ada.token).get('/api/search?q=ZEBRA&types=mail');
      expect(JSON.stringify(adaSearch.body)).toContain(tid);
    } finally {
      await getPool().query('DELETE FROM mail_recipients WHERE user_id = $1', [cal.id]);
      await getPool().query('DELETE FROM notifications WHERE user_id = $1', [cal.id]);
      await getPool().query('DELETE FROM users WHERE id = $1', [cal.id]);
    }
  });

  it('a BCC recipient sees only the message they were blind-copied on', async () => {
    const dee = await user('Staff', 'Dee');
    try {
      const first = await as(ada.token).post('/api/mail/compose', {
        to: [ben.email], bcc: [dee.email], subject: 'Quiet copy', bodyHtml: '<p>bcc opening</p>' });
      const tid = first.body.data.threadId;
      await as(ben.token).post('/api/mail/compose', {
        to: [ada.email], subject: 'Re: Quiet copy', bodyHtml: '<p>REPLY ALL WALRUS</p>', threadId: tid });
      const view = await as(dee.token).get(`/api/mail/threads/${tid}`);
      expect(JSON.stringify(view.body)).toContain('bcc opening');
      expect(JSON.stringify(view.body)).not.toContain('WALRUS');
    } finally {
      await getPool().query('DELETE FROM mail_recipients WHERE user_id = $1', [dee.id]);
      await getPool().query('DELETE FROM notifications WHERE user_id = $1', [dee.id]);
      await getPool().query('DELETE FROM users WHERE id = $1', [dee.id]);
    }
  });
});
