import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';

/**
 * D-01: who a post is for is decided once (post audience ∩ page audience,
 * published, page not deleted) and every path honours it.
 */

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
  del: (p: string) => request(app).delete(p).set('Authorization', `Bearer ${t}`),
});

let admin: Awaited<ReturnType<typeof user>>;
let staff: Awaited<ReturnType<typeof user>>;
let student: Awaited<ReturnType<typeof user>>;
let staffPage: string;
let openPage: string;
let staffPost: string;
let pollPost: string;

beforeAll(async () => {
  await seedRbac(getPool());
  admin = await user('Admin', 'Adm');
  staff = await user('Staff', 'Sta');
  student = await user('Student', 'Stu');
  staffPage = (await as(admin.token).post('/api/feed/pages', { name: `Staff Room ${snowflake()}`, audience: 'staff' })).body.data.page.id;
  openPage = (await as(admin.token).post('/api/feed/pages', { name: `Open ${snowflake()}`, audience: 'everyone' })).body.data.page.id;
  await as(student.token).post(`/api/feed/pages/${staffPage}/follow`);
  // The composer's default is "everyone" — the page must cap it.
  staffPost = (await as(admin.token).post(`/api/feed/pages/${staffPage}/posts`, { body: 'STAFF ROOM NOTICE', audience: 'everyone' })).body.data.postId;
  pollPost = (await as(admin.token).post(`/api/feed/pages/${staffPage}/posts`, {
    body: 'staff poll', poll: { question: 'Q?', options: ['a', 'b'] },
  })).body.data.postId;
});

afterAll(async () => {
  const pool = getPool();
  const ids = [admin.id, staff.id, student.id];
  for (const t of ['feed_reports', 'feed_comment_reactions', 'feed_comments', 'feed_reactions', 'feed_poll_votes',
    'feed_event_rsvps', 'feed_post_views', 'feed_bookmarks', 'feed_timeline', 'feed_post_edits']) {
    await pool.query(`DELETE FROM ${t} WHERE post_id IN (SELECT id FROM feed_posts WHERE page_id = ANY($1::text[]))`, [[staffPage, openPage]]).catch(() => {});
  }
  await pool.query('DELETE FROM feed_posts WHERE page_id = ANY($1::text[])', [[staffPage, openPage]]);
  await pool.query('DELETE FROM feed_page_followers WHERE page_id = ANY($1::text[])', [[staffPage, openPage]]);
  await pool.query('DELETE FROM feed_page_editors WHERE page_id = ANY($1::text[])', [[staffPage, openPage]]);
  await pool.query('DELETE FROM feed_pages WHERE id = ANY($1::text[])', [[staffPage, openPage]]);
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [ids]);
  await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1::text[])', [ids]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [ids]);
  await closeDb();
});

describe('a post on a staff-only page', () => {
  it('is stored as staff-only even when the composer said everyone', async () => {
    const { rows } = await getPool().query('SELECT audience FROM feed_posts WHERE id = $1', [staffPost]);
    expect(rows[0].audience).toBe('staff');
  });

  it('never reaches a student follower as a notification', async () => {
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND link LIKE '%' || $2 || '%'", [student.id, staffPost]);
    expect(rows[0].n).toBe(0);
  });

  it('is not in the student’s feed, and its permalink is a 404', async () => {
    const feed = await as(student.token).get('/api/feed');
    expect(JSON.stringify(feed.body)).not.toContain('STAFF ROOM NOTICE');
    expect((await as(student.token).get(`/api/feed/posts/${staffPost}`)).status).toBe(404);
  });

  it('refuses every engagement from a student', async () => {
    const S = as(student.token);
    expect((await S.post(`/api/feed/posts/${staffPost}/comments`, { body: 'hi' })).status).toBe(404);
    expect((await S.get(`/api/feed/posts/${staffPost}/comments`)).status).toBe(404);
    expect((await S.post(`/api/feed/posts/${staffPost}/reactions`, { emoji: 'like' })).status).toBe(404);
    expect((await S.post(`/api/feed/posts/${staffPost}/bookmark`)).status).toBe(404);
    expect((await S.post(`/api/feed/posts/${pollPost}/vote`, { choices: [0] })).status).toBe(404);
  });

  it('is fully available to staff', async () => {
    const T = as(staff.token);
    expect((await T.get(`/api/feed/posts/${staffPost}`)).status).toBe(200);
    expect((await T.post(`/api/feed/posts/${staffPost}/comments`, { body: 'seen' })).status).toBe(201);
    expect(JSON.stringify((await T.get('/api/feed')).body)).toContain('STAFF ROOM NOTICE');
  });
});

describe('page lifecycle and impressions', () => {
  it('posts of a deleted page leave the feed and their permalinks', async () => {
    const tmp = (await as(admin.token).post('/api/feed/pages', { name: `Temp ${snowflake()}`, audience: 'everyone' })).body.data.page.id;
    const pid = (await as(admin.token).post(`/api/feed/pages/${tmp}/posts`, { body: 'SOON GONE' })).body.data.postId;
    expect(JSON.stringify((await as(staff.token).get('/api/feed')).body)).toContain('SOON GONE');
    expect((await as(admin.token).del(`/api/feed/pages/${tmp}`)).status).toBeLessThan(300);
    expect(JSON.stringify((await as(staff.token).get('/api/feed')).body)).not.toContain('SOON GONE');
    expect((await as(staff.token).get(`/api/feed/posts/${pid}`)).status).toBe(404);
    await getPool().query('DELETE FROM feed_post_views WHERE post_id = $1', [pid]);
    await getPool().query('DELETE FROM feed_posts WHERE id = $1', [pid]);
    await getPool().query('DELETE FROM feed_page_editors WHERE page_id = $1', [tmp]);
    await getPool().query('DELETE FROM feed_page_followers WHERE page_id = $1', [tmp]);
    await getPool().query('DELETE FROM feed_pages WHERE id = $1', [tmp]);
  });

  it('one person counts as one impression however often a card is seen', async () => {
    const pid = (await as(admin.token).post(`/api/feed/pages/${openPage}/posts`, { body: 'count me once' })).body.data.postId;
    for (let i = 0; i < 4; i++) await as(student.token).post(`/api/feed/posts/${pid}/view`);
    const { rows } = await getPool().query('SELECT view_count FROM feed_posts WHERE id = $1', [pid]);
    expect(rows[0].view_count).toBe(1);
  });
});
