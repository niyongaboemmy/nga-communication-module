import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { runFeedSweep } from '@tupo/feed';
import { app } from '../app.js';
import { config } from '../config.js';

/** D-03: scheduled posts announce themselves; votes, counters and post counts stay right under concurrency. */

async function user(role: string, name: string) {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [role]);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, role.toLowerCase(), rows[0]!.id]);
  users.push(id);
  return { id, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: role.toLowerCase() }, config.jwtSecret) };
}
const as = (t: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${t}`),
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
  del: (p: string) => request(app).delete(p).set('Authorization', `Bearer ${t}`),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
  const end = Date.now() + ms; let v = await fn();
  while (!ok(v) && Date.now() < end) { await sleep(100); v = await fn(); }
  return v;
}

const users: string[] = [];
let admin: Awaited<ReturnType<typeof user>>;
let follower: Awaited<ReturnType<typeof user>>;
let page: string;

beforeAll(async () => {
  await seedRbac(getPool());
  admin = await user('Admin', 'Adm');
  follower = await user('Staff', 'Fol');
  page = (await as(admin.token).post('/api/feed/pages', { name: `Consistency ${snowflake()}`, audience: 'everyone' })).body.data.page.id;
  await as(follower.token).post(`/api/feed/pages/${page}/follow`);
});

afterAll(async () => {
  const pool = getPool();
  for (const t of ['feed_reactions', 'feed_poll_votes', 'feed_timeline', 'feed_comments']) {
    await pool.query(`DELETE FROM ${t} WHERE post_id IN (SELECT id FROM feed_posts WHERE page_id = $1)`, [page]).catch(() => {});
  }
  await pool.query('DELETE FROM feed_posts WHERE page_id = $1', [page]);
  await pool.query('DELETE FROM feed_page_followers WHERE page_id = $1', [page]);
  await pool.query('DELETE FROM feed_page_editors WHERE page_id = $1', [page]);
  await pool.query('DELETE FROM feed_pages WHERE id = $1', [page]);
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [users]);
  await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1::text[])', [users]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
  await closeDb();
});

const notified = async (postId: string) => (await getPool().query(
  `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND subject_id = $2`, [follower.id, postId])).rows[0].n as number;

describe('announcing posts', () => {
  it('a post published from the composer notifies followers', async () => {
    const id = (await as(admin.token).post(`/api/feed/pages/${page}/posts`, { body: 'now' })).body.data.postId;
    expect(await eventually(() => notified(id), (n) => n === 1)).toBe(1);
  });

  it('a scheduled post announces itself when the sweep publishes it (FEED-B3)', async () => {
    const r = await as(admin.token).post(`/api/feed/pages/${page}/posts`, {
      body: 'later', status: 'scheduled', scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    const id = r.body.data.postId;
    expect(r.body.data.status).toBe('scheduled');
    await getPool().query(`UPDATE feed_posts SET scheduled_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    await runFeedSweep();
    const { rows } = await getPool().query('SELECT status FROM feed_posts WHERE id = $1', [id]);
    expect(rows[0].status).toBe('published');
    expect(await notified(id)).toBe(1);
  });

  it('a post taken back to draft before its time is not published', async () => {
    const r = await as(admin.token).post(`/api/feed/pages/${page}/posts`, {
      body: 'changed my mind', status: 'scheduled', scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await getPool().query(`UPDATE feed_posts SET scheduled_at = now() - interval '1 minute', status = 'draft' WHERE id = $1`, [r.body.data.postId]);
    await runFeedSweep();
    const { rows } = await getPool().query('SELECT status FROM feed_posts WHERE id = $1', [r.body.data.postId]);
    expect(rows[0].status).toBe('draft');
  });
});

describe('concurrency', () => {
  it('simultaneous reactions leave an exact count (FEED-B10)', async () => {
    const id = (await as(admin.token).post(`/api/feed/pages/${page}/posts`, { body: 'react to me' })).body.data.postId;
    const crowd = await Promise.all(Array.from({ length: 8 }, (_, i) => user('Staff', `R${i}`)));
    await Promise.all(crowd.map((u) => as(u.token).post(`/api/feed/posts/${id}/reactions`, { emoji: 'like' })));
    const { rows } = await getPool().query<{ reaction_count: number }>('SELECT reaction_count FROM feed_posts WHERE id = $1', [id]);
    expect(rows[0]!.reaction_count).toBe(8);
  });

  it('two quick votes on a single-choice poll leave one answer (FEED-B4)', async () => {
    const id = (await as(admin.token).post(`/api/feed/pages/${page}/posts`, {
      body: 'poll', poll: { question: 'Pick one', options: ['a', 'b', 'c'] } })).body.data.postId;
    await Promise.all([0, 1, 2, 0, 1].map((i) => as(follower.token).post(`/api/feed/posts/${id}/vote`, { choices: [i] })));
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM feed_poll_votes WHERE post_id = $1 AND user_id = $2', [id, follower.id]);
    expect(rows[0].n).toBe(1);
  }, 15_000);
});

describe('page post count (FEED-B12)', () => {
  it('deleting a draft or an unpublished post does not change it', async () => {
    const count = async () => (await getPool().query<{ post_count: number }>('SELECT post_count FROM feed_pages WHERE id = $1', [page])).rows[0]!.post_count;
    const before = await count();
    const draft = (await as(admin.token).post(`/api/feed/pages/${page}/posts`, { body: 'draft', status: 'draft' })).body.data.postId;
    expect((await as(admin.token).del(`/api/feed/posts/${draft}`)).status).toBeLessThan(300);
    expect(await count()).toBe(before);
    const live = (await as(admin.token).post(`/api/feed/pages/${page}/posts`, { body: 'live' })).body.data.postId;
    expect(await count()).toBe(before + 1);
    await as(admin.token).post(`/api/feed/posts/${live}/unpublish`);
    expect(await count()).toBe(before);
    await as(admin.token).del(`/api/feed/posts/${live}`);
    expect(await count()).toBe(before);
  });
});
