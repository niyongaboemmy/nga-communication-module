import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { sanitizeMailHtml } from '@tupo/mail';
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
