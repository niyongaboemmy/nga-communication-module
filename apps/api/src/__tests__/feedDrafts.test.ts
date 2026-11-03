import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';

/** D-05 / D-06: drafts and scheduled posts for editors; poll and event edits kept. */

async function user(role: string, name: string) {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [role]);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, role.toLowerCase(), rows[0]!.id]);
  return { id, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: role.toLowerCase() }, config.jwtSecret) };
}
const as = (t: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${t}`),
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
  patch: (p: string, b?: unknown) => request(app).patch(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
});

let admin: Awaited<ReturnType<typeof user>>;
let staff: Awaited<ReturnType<typeof user>>;
let page: string;
const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

beforeAll(async () => {
  await seedRbac(getPool());
  admin = await user('Admin', 'Adm');
  staff = await user('Staff', 'Sta');
  page = (await as(admin.token).post('/api/feed/pages', { name: `Drafts ${snowflake()}`, audience: 'everyone' })).body.data.page.id;
});
afterAll(async () => {
  const pool = getPool();
  const ids = [admin.id, staff.id];
  await pool.query('DELETE FROM feed_poll_votes WHERE post_id IN (SELECT id FROM feed_posts WHERE page_id = $1)', [page]).catch(() => {});
  await pool.query('DELETE FROM feed_timeline WHERE page_id = $1', [page]).catch(() => {});
  await pool.query('DELETE FROM feed_post_edits WHERE post_id IN (SELECT id FROM feed_posts WHERE page_id = $1)', [page]).catch(() => {});
  await pool.query('DELETE FROM feed_posts WHERE page_id = $1', [page]);
  await pool.query('DELETE FROM feed_page_editors WHERE page_id = $1', [page]);
  await pool.query('DELETE FROM feed_page_followers WHERE page_id = $1', [page]);
  await pool.query('DELETE FROM feed_pages WHERE id = $1', [page]);
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [ids]);
  await closeDb();
});

describe('drafts and scheduled posts', () => {
  it('lists them for editors, scheduled first, and refuses everyone else', async () => {
    const draft = (await as(admin.token).post(`/api/feed/pages/${page}/posts`, { body: 'draft one', status: 'draft' })).body.data.postId;
    const sched = (await as(admin.token).post(`/api/feed/pages/${page}/posts`, { body: 'later', status: 'scheduled', scheduledAt: inAnHour() })).body.data.postId;
    await as(admin.token).post(`/api/feed/pages/${page}/posts`, { body: 'live now' });
    const list = (await as(admin.token).get(`/api/feed/pages/${page}/drafts`)).body.data.posts.map((p: { id: string }) => p.id);
    expect(list).toEqual([sched, draft]);
    expect((await as(staff.token).get(`/api/feed/pages/${page}/drafts`)).status).toBe(403);
  });

  it('reschedules, turns back into a draft, and refuses the past', async () => {
    const id = (await as(admin.token).post(`/api/feed/pages/${page}/posts`, { body: 'move me', status: 'draft' })).body.data.postId;
    const at = inAnHour();
    const r = await as(admin.token).post(`/api/feed/posts/${id}/schedule`, { scheduledAt: at });
    expect(r.body.data.post).toMatchObject({ status: 'scheduled' });
    expect((await as(admin.token).post(`/api/feed/posts/${id}/schedule`, { scheduledAt: '2001-01-01T00:00:00Z' })).status).toBe(400);
    const back = await as(admin.token).post(`/api/feed/posts/${id}/schedule`, { scheduledAt: null });
    expect(back.body.data.post).toMatchObject({ status: 'draft', scheduledAt: null });
    await as(admin.token).post(`/api/feed/posts/${id}/publish`);
    expect((await as(admin.token).post(`/api/feed/posts/${id}/schedule`, { scheduledAt: at })).status).toBe(409);
  });
});

describe('editing polls and events', () => {
  it('keeps event changes and poll changes until someone votes', async () => {
    const id = (await as(admin.token).post(`/api/feed/pages/${page}/posts`, {
      body: 'vote', poll: { question: 'Day?', options: ['Mon', 'Tue'] },
    })).body.data.postId;
    const edited = await as(admin.token).patch(`/api/feed/posts/${id}`, {
      poll: { question: 'Which day?', options: ['Mon', 'Tue', 'Wed'] },
      event: { title: 'Trip', startsAt: inAnHour(), location: 'Gate' },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.post.poll.question).toBe('Which day?');
    expect(edited.body.data.post.event.title).toBe('Trip');
    expect((await as(staff.token).post(`/api/feed/posts/${id}/vote`, { choices: [0] })).status).toBe(200);
    expect((await as(admin.token).patch(`/api/feed/posts/${id}`, { poll: { question: 'Again?', options: ['A', 'B'] } })).status).toBe(409);
  });
});
