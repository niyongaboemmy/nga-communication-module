import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { runStorySweep } from '@tupo/feed';
import { app } from '../app.js';
import { config } from '../config.js';

/**
 * Reels & Stories (FR-FEED-13, 14) — personal, page-free publishing on top of
 * the Feed. Against the real PostgreSQL, same style as feed.test.ts, so the
 * migration (0025) and its partial indexes are exercised for real.
 */

async function roleId(name: string): Promise<number | null> {
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [name]);
  return rows[0]?.id ?? null;
}

async function user(roleName: string | null, name = 'T'): Promise<{ id: string; token: string; name: string }> {
  const id = snowflake();
  const rid = roleName ? await roleId(roleName) : null;
  await getPool().query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, (roleName ?? 'unassigned').toLowerCase(), rid],
  );
  const token = jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' },
    config.jwtSecret, { expiresIn: '15m' });
  return { id, token, name };
}

const api = (token: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`),
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${token}`).send(b ?? {}),
  del: (p: string) => request(app).delete(p).set('Authorization', `Bearer ${token}`),
});

/** Insert a `files` row directly — same shortcut feed.test.ts would take,
 *  since exercising the real two-step upload ticket pipeline is apps/files's
 *  own test surface, not this route's. */
async function makeFile(ownerId: string, mime: string): Promise<string> {
  const id = snowflake();
  await getPool().query(
    `INSERT INTO files (id, owner_id, storage_driver, storage_key, original_name, mime_type, size_bytes, status)
     VALUES ($1,$2,'local',$1,'clip','${mime}',12345,'ready')`,
    [id, ownerId],
  );
  return id;
}

let admin: Awaited<ReturnType<typeof user>>;
let staff: Awaited<ReturnType<typeof user>>;
let student: Awaited<ReturnType<typeof user>>;
let parent: Awaited<ReturnType<typeof user>>;
let noPerms: Awaited<ReturnType<typeof user>>;

beforeAll(async () => {
  const pool = getPool();
  for (const t of ['feed_reel_comments', 'feed_reel_likes', 'feed_reel_views', 'feed_reels',
    'feed_story_views', 'feed_stories', 'notifications', 'audit_log', 'files', 'users']) {
    await pool.query(`DELETE FROM ${t}`);
  }
  await pool.query('DELETE FROM roles WHERE is_system = false');
  await seedRbac(pool);
  await pool.query(`INSERT INTO roles (name, level, description, is_system) VALUES ('Nobody','STUDENT','',false)`);

  admin = await user('Admin', 'Ada');
  staff = await user('Staff', 'Sam');
  student = await user('Student', 'Stu');
  parent = await user('Parent', 'Pat');
  noPerms = await user('Nobody', 'Non');
});

beforeEach(async () => {
  const pool = getPool();
  for (const t of ['feed_reel_comments', 'feed_reel_likes', 'feed_reel_views', 'feed_reels',
    'feed_story_views', 'feed_stories', 'files']) {
    await pool.query(`DELETE FROM ${t}`);
  }
});

afterAll(async () => {
  await closeDb();
});

describe('reels', () => {
  it('FEED_REEL_POST is a baseline permission — a student can publish one', async () => {
    const fileId = await makeFile(student.id, 'video/mp4');
    const res = await api(student.token).post('/api/feed/reels', {
      caption: 'My robotics project', media: { fileId },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.reel.author.id).toBe(student.id);
    expect(res.body.data.reel.author.name).toBe('Stu');
    expect(res.body.data.reel.caption).toBe('My robotics project');
    expect(res.body.data.reel.viewCount).toBe(0);
    expect(res.body.data.reel.likeCount).toBe(0);
  });

  it('a role with nothing granted cannot post a reel', async () => {
    const fileId = await makeFile(noPerms.id, 'video/mp4');
    const res = await api(noPerms.token).post('/api/feed/reels', { media: { fileId } });
    expect(res.status).toBe(403);
  });

  it('rejects a non-video attachment', async () => {
    const fileId = await makeFile(student.id, 'image/png');
    const res = await api(student.token).post('/api/feed/reels', { media: { fileId } });
    expect(res.status).toBe(400);
  });

  it("rejects someone else's file", async () => {
    const fileId = await makeFile(staff.id, 'video/mp4');
    const res = await api(student.token).post('/api/feed/reels', { media: { fileId } });
    expect(res.status).toBe(403);
  });

  it('lists newest first and shows the publisher on every item', async () => {
    const f1 = await makeFile(student.id, 'video/mp4');
    const f2 = await makeFile(staff.id, 'video/webm');
    await api(student.token).post('/api/feed/reels', { media: { fileId: f1 } });
    await api(staff.token).post('/api/feed/reels', { media: { fileId: f2 } });

    const res = await api(parent.token).get('/api/feed/reels');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.items[0].author.name).toBe('Sam');
    expect(res.body.data.items[1].author.name).toBe('Stu');
  });

  it('views count total impressions and distinct reach, and appear on the reel', async () => {
    const fileId = await makeFile(student.id, 'video/mp4');
    const create = await api(student.token).post('/api/feed/reels', { media: { fileId } });
    const reelId = create.body.data.reelId as string;

    await api(staff.token).post(`/api/feed/reels/${reelId}/view`);
    await api(staff.token).post(`/api/feed/reels/${reelId}/view`); // same viewer again
    await api(parent.token).post(`/api/feed/reels/${reelId}/view`);

    const { rows } = await getPool().query('SELECT view_count, unique_reach FROM feed_reels WHERE id = $1', [reelId]);
    expect(rows[0].view_count).toBe(3);
    expect(rows[0].unique_reach).toBe(2);

    const view = await api(student.token).get(`/api/feed/reels/${reelId}`);
    expect(view.body.data.reel.viewCount).toBe(3);
    expect(view.body.data.reel.uniqueReach).toBe(2);
  });

  it('liking toggles and updates the count', async () => {
    const fileId = await makeFile(student.id, 'video/mp4');
    const create = await api(student.token).post('/api/feed/reels', { media: { fileId } });
    const reelId = create.body.data.reelId as string;

    const like = await api(parent.token).post(`/api/feed/reels/${reelId}/like`);
    expect(like.body.data).toEqual({ liked: true, likeCount: 1 });

    const unlike = await api(parent.token).post(`/api/feed/reels/${reelId}/like`);
    expect(unlike.body.data).toEqual({ liked: false, likeCount: 0 });
  });

  it('comments are flat, attributed, and deletable by their author or a moderator', async () => {
    const fileId = await makeFile(student.id, 'video/mp4');
    const create = await api(student.token).post('/api/feed/reels', { media: { fileId } });
    const reelId = create.body.data.reelId as string;

    const c1 = await api(parent.token).post(`/api/feed/reels/${reelId}/comments`, { body: 'Great work!' });
    expect(c1.status).toBe(201);
    expect(c1.body.data.comment.author.name).toBe('Pat');

    const list = await api(student.token).get(`/api/feed/reels/${reelId}/comments`);
    expect(list.body.data.comments).toHaveLength(1);

    // Not the author and not a moderator — refused.
    const refused = await api(staff.token).del(`/api/feed/reels/comments/${c1.body.data.comment.id}`);
    expect(refused.status).toBe(403);

    const del = await api(parent.token).del(`/api/feed/reels/comments/${c1.body.data.comment.id}`);
    expect(del.status).toBe(200);

    const after = await api(student.token).get(`/api/feed/reels/${reelId}`);
    expect(after.body.data.reel.commentCount).toBe(0);
  });

  it('only the author or a moderator may delete a reel', async () => {
    const fileId = await makeFile(student.id, 'video/mp4');
    const create = await api(student.token).post('/api/feed/reels', { media: { fileId } });
    const reelId = create.body.data.reelId as string;

    expect((await api(parent.token).del(`/api/feed/reels/${reelId}`)).status).toBe(403);
    expect((await api(student.token).del(`/api/feed/reels/${reelId}`)).status).toBe(200);
    expect((await api(student.token).get(`/api/feed/reels/${reelId}`)).status).toBe(404);
  });
});

describe('stories', () => {
  it('FEED_STORY_POST is baseline — a parent can publish a text-only status', async () => {
    const res = await api(parent.token).post('/api/feed/stories', { caption: 'Proud of my kid today', background: 'sunset' });
    expect(res.status).toBe(201);
    expect(res.body.data.story.author.name).toBe('Pat');
    expect(res.body.data.story.caption).toBe('Proud of my kid today');
    expect(res.body.data.story.viewCount).toBe(0);
    // ~24h out.
    const hours = (Date.parse(res.body.data.story.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
  });

  it('needs some content — an empty status is refused', async () => {
    const res = await api(student.token).post('/api/feed/stories', {});
    expect(res.status).toBe(400);
  });

  it('a role with nothing granted cannot post a story', async () => {
    const res = await api(noPerms.token).post('/api/feed/stories', { caption: 'hi' });
    expect(res.status).toBe(403);
  });

  it('groups active stories by author, own group first', async () => {
    await api(student.token).post('/api/feed/stories', { caption: 'one' });
    await api(student.token).post('/api/feed/stories', { caption: 'two' });
    await api(staff.token).post('/api/feed/stories', { caption: 'staff status' });

    const res = await api(student.token).get('/api/feed/stories');
    expect(res.status).toBe(200);
    const groups = res.body.data.groups as Array<{ author: { id: string }; stories: unknown[] }>;
    expect(groups[0]!.author.id).toBe(student.id);
    expect(groups[0]!.stories).toHaveLength(2);
    expect(groups.some((g) => g.author.id === staff.id)).toBe(true);
  });

  it('tracks views distinctly, excludes the author, and only the author can list viewers', async () => {
    const create = await api(student.token).post('/api/feed/stories', { caption: 'status' });
    const storyId = create.body.data.storyId as string;

    await api(student.token).post(`/api/feed/stories/${storyId}/view`); // own view doesn't count
    await api(parent.token).post(`/api/feed/stories/${storyId}/view`);
    await api(parent.token).post(`/api/feed/stories/${storyId}/view`); // repeat viewer, still 1
    await api(staff.token).post(`/api/feed/stories/${storyId}/view`);

    const { rows } = await getPool().query('SELECT view_count FROM feed_stories WHERE id = $1', [storyId]);
    expect(rows[0].view_count).toBe(2);

    const viewers = await api(student.token).get(`/api/feed/stories/${storyId}/viewers`);
    expect(viewers.status).toBe(200);
    expect(viewers.body.data.viewers.map((v: { name: string }) => v.name).sort()).toEqual(['Pat', 'Sam']);

    const refused = await api(parent.token).get(`/api/feed/stories/${storyId}/viewers`);
    expect(refused.status).toBe(403);
  });

  it('expires 24 hours out via the worker sweep, exactly like the scheduled-post sweep', async () => {
    const create = await api(student.token).post('/api/feed/stories', { caption: 'expiring' });
    const storyId = create.body.data.storyId as string;

    await getPool().query(`UPDATE feed_stories SET expires_at = now() - interval '1 minute' WHERE id = $1`, [storyId]);

    // Still physically present until the sweep runs, but already treated as gone.
    expect((await api(student.token).get(`/api/feed/stories/${storyId}`)).status).toBe(404);

    const swept = await runStorySweep();
    expect(swept.expired).toBeGreaterThanOrEqual(1);

    const groups = await api(student.token).get('/api/feed/stories');
    expect(groups.body.data.groups.some((g: { author: { id: string } }) => g.author.id === student.id)).toBe(false);
  });

  it('only the author or a moderator may delete a story', async () => {
    const create = await api(student.token).post('/api/feed/stories', { caption: 'mine' });
    const storyId = create.body.data.storyId as string;

    expect((await api(parent.token).del(`/api/feed/stories/${storyId}`)).status).toBe(403);
    expect((await api(student.token).del(`/api/feed/stories/${storyId}`)).status).toBe(200);
    expect((await api(student.token).get(`/api/feed/stories/${storyId}`)).status).toBe(404);
  });
});
