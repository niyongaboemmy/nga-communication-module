import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';

/** D-02: page images are the owner's own; only authors edit comments; reel limits and colours enforced. */

async function user(role: string, name: string) {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [role]);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, role.toLowerCase(), rows[0]!.id]);
  return { id, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: role.toLowerCase() }, config.jwtSecret) };
}
const as = (t: string) => ({
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
  patch: (p: string, b?: unknown) => request(app).patch(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
  del: (p: string) => request(app).delete(p).set('Authorization', `Bearer ${t}`),
});
async function file(owner: string, mime: string, metadata: object = {}, status = 'ready') {
  const id = snowflake();
  await getPool().query(
    `INSERT INTO files (id, owner_id, storage_driver, storage_key, original_name, mime_type, size_bytes, status, metadata)
     VALUES ($1,$2,'local',$3,'f',$4,1000,$5,$6::jsonb)`, [id, owner, `test/${id}`, mime, status, JSON.stringify(metadata)]);
  files.push(id);
  return id;
}

let admin: Awaited<ReturnType<typeof user>>;
let staff: Awaited<ReturnType<typeof user>>;
let page: string;
const files: string[] = [];
const pages: string[] = [];

beforeAll(async () => {
  await seedRbac(getPool());
  admin = await user('Admin', 'Adm');
  staff = await user('Staff', 'Sta');
  page = (await as(admin.token).post('/api/feed/pages', { name: `Integrity ${snowflake()}`, audience: 'everyone' })).body.data.page.id;
  pages.push(page);
});

afterAll(async () => {
  const pool = getPool();
  const ids = [admin.id, staff.id];
  await pool.query('DELETE FROM feed_comments WHERE post_id IN (SELECT id FROM feed_posts WHERE page_id = ANY($1::text[]))', [pages]);
  await pool.query('DELETE FROM feed_timeline WHERE post_id IN (SELECT id FROM feed_posts WHERE page_id = ANY($1::text[]))', [pages]).catch(() => {});
  await pool.query('DELETE FROM feed_posts WHERE page_id = ANY($1::text[])', [pages]);
  await pool.query('DELETE FROM feed_page_editors WHERE page_id = ANY($1::text[])', [pages]);
  await pool.query('DELETE FROM feed_page_followers WHERE page_id = ANY($1::text[])', [pages]);
  await pool.query('DELETE FROM feed_pages WHERE id = ANY($1::text[])', [pages]);
  await pool.query('DELETE FROM feed_reels WHERE author_id = ANY($1::text[])', [ids]);
  await pool.query('DELETE FROM feed_stories WHERE author_id = ANY($1::text[])', [ids]);
  await pool.query('DELETE FROM files WHERE id = ANY($1::text[])', [files]);
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [ids]);
  await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1::text[])', [ids]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [ids]);
  await closeDb();
});

describe('page images (FEED-S1)', () => {
  it('refuses someone else’s file, a non-image, or an unfinished upload', async () => {
    const theirs = await file(staff.id, 'image/png');
    const pdf = await file(admin.id, 'application/pdf');
    const pending = await file(admin.id, 'image/png', {}, 'pending');
    expect((await as(admin.token).patch(`/api/feed/pages/${page}`, { avatarFileId: theirs })).status).toBe(403);
    expect((await as(admin.token).patch(`/api/feed/pages/${page}`, { coverFileId: pdf })).status).toBe(400);
    expect((await as(admin.token).patch(`/api/feed/pages/${page}`, { avatarFileId: pending })).status).toBe(409);
    const created = await as(admin.token).post('/api/feed/pages', { name: `Bad ${snowflake()}`, audience: 'everyone', coverFileId: theirs });
    expect(created.status).toBe(403);
  });

  it('accepts the owner’s own image, and re-saving it unchanged', async () => {
    const mine = await file(admin.id, 'image/jpeg');
    expect((await as(admin.token).patch(`/api/feed/pages/${page}`, { avatarFileId: mine })).status).toBe(200);
    expect((await as(admin.token).patch(`/api/feed/pages/${page}`, { avatarFileId: mine, bio: 'x' })).status).toBe(200);
  });
});

describe('colours (FEED-V4)', () => {
  it('page accent must be a hex colour', async () => {
    expect((await as(admin.token).patch(`/api/feed/pages/${page}`, { accent: 'red;background:url(//evil)' })).status).toBe(400);
    expect((await as(admin.token).patch(`/api/feed/pages/${page}`, { accent: '#12ab34' })).status).toBe(200);
  });

  it('story background must be a colour or a simple gradient', async () => {
    expect((await as(staff.token).post('/api/feed/stories', { caption: 'hi', background: 'url(https://evil.example/p.gif)' })).status).toBe(400);
    expect((await as(staff.token).post('/api/feed/stories', { caption: 'hi', background: 'linear-gradient(135deg,#2563eb,#7c3aed)' })).status).toBe(201);
  });
});

describe('comment edits (FEED-A2)', () => {
  it('only the author can change a comment’s words; a page admin may still remove it', async () => {
    const post = (await as(admin.token).post(`/api/feed/pages/${page}/posts`, { body: 'post' })).body.data.postId;
    const c = await as(staff.token).post(`/api/feed/posts/${post}/comments`, { body: 'my words' });
    const id = c.body.data.comment.id;
    expect((await as(admin.token).patch(`/api/feed/comments/${id}`, { body: 'words put in my mouth' })).status).toBe(403);
    expect((await as(staff.token).patch(`/api/feed/comments/${id}`, { body: 'my edited words' })).status).toBe(200);
    expect((await as(admin.token).del(`/api/feed/comments/${id}`)).status).toBeLessThan(300);
  });
});

describe('reels (FEED-V3)', () => {
  it('refuses a reel longer than 90 s, whether declared or recorded at upload', async () => {
    const long = await file(staff.id, 'video/mp4', { durationMs: 120_000 });
    expect((await as(staff.token).post('/api/feed/reels', { media: { fileId: long, kind: 'video' } })).status).toBe(400);
    const lying = await file(staff.id, 'video/mp4');
    expect((await as(staff.token).post('/api/feed/reels', { media: { fileId: lying, kind: 'video', durationSeconds: 200 } })).status).toBe(400);
  });

  it('keeps the duration and the author’s own poster', async () => {
    const vid = await file(staff.id, 'video/mp4', { durationMs: 30_000 });
    const poster = await file(staff.id, 'image/jpeg');
    const r = await as(staff.token).post('/api/feed/reels', { media: { fileId: vid, kind: 'video', durationSeconds: 30, posterFileId: poster } });
    expect(r.status).toBe(201);
    const { rows } = await getPool().query<{ media: { durationSeconds: number; posterFileId: string } }>(
      'SELECT media FROM feed_reels WHERE id = $1', [r.body.data.reelId]);
    expect(rows[0]!.media.durationSeconds).toBe(30);
    expect(rows[0]!.media.posterFileId).toBe(poster);
    const someoneElses = await file(admin.id, 'image/jpeg');
    const vid2 = await file(staff.id, 'video/mp4', { durationMs: 10_000 });
    expect((await as(staff.token).post('/api/feed/reels', { media: { fileId: vid2, kind: 'video', posterFileId: someoneElses } })).status).toBe(403);
  });
});
