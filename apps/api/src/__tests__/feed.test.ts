import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { runFeedSweep } from '@tupo/feed';
import { app } from '../app.js';
import { config } from '../config.js';

/**
 * Feed's server-side behaviour (FR-FEED-1…12), against the real PostgreSQL so
 * the migration, the partial unique indexes and the jsonb columns are all
 * exercised for real.
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
  patch: (p: string, b?: unknown) => request(app).patch(p).set('Authorization', `Bearer ${token}`).send(b ?? {}),
  del: (p: string) => request(app).delete(p).set('Authorization', `Bearer ${token}`),
});

let admin: Awaited<ReturnType<typeof user>>;
let staff: Awaited<ReturnType<typeof user>>;
let student: Awaited<ReturnType<typeof user>>;
let parent: Awaited<ReturnType<typeof user>>;
let noPerms: Awaited<ReturnType<typeof user>>;
let pageId: string;

async function makePage(token: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await api(token).post('/api/feed/pages', { name: `Page ${snowflake()}`, ...over });
  expect(res.status).toBe(201);
  return res.body.data.page.id as string;
}

async function publish(token: string, page: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await api(token).post(`/api/feed/pages/${page}/posts`, { body: 'hello world', ...over });
  expect(res.status).toBe(201);
  return res.body.data.postId as string;
}

beforeAll(async () => {
  const pool = getPool();
  for (const t of ['feed_reports', 'feed_comment_reactions', 'feed_comments', 'feed_reactions',
    'feed_poll_votes', 'feed_event_rsvps', 'feed_post_views', 'feed_bookmarks', 'feed_timeline',
    'feed_post_edits', 'feed_posts', 'feed_page_editors', 'feed_page_followers', 'feed_pages',
    'notifications', 'audit_log', 'files', 'users']) {
    await pool.query(`DELETE FROM ${t}`);
  }
  await pool.query('DELETE FROM roles WHERE is_system = false');
  await seedRbac(pool);

  // A role that holds nothing at all — for the "FEED_VIEW gates the feed" test.
  await pool.query(`INSERT INTO roles (name, level, description, is_system) VALUES ('Nobody','STUDENT','',false)`);

  admin = await user('Admin', 'Ada');
  staff = await user('Staff', 'Sam');
  student = await user('Student', 'Stu');
  parent = await user('Parent', 'Pat');
  noPerms = await user('Nobody', 'Non');

  pageId = await makePage(admin.token, { name: 'NGA News', audience: 'everyone' });
});

beforeEach(async () => {
  await getPool().query('DELETE FROM feed_posts');
  await getPool().query('DELETE FROM feed_timeline');
  await getPool().query('DELETE FROM feed_reactions');
  await getPool().query('DELETE FROM feed_comments');
  await getPool().query('DELETE FROM feed_reports');
});

afterAll(async () => {
  await getPool().query('DELETE FROM files').catch(() => {});
  await closeDb();
});

describe('permissions', () => {
  it('FEED_VIEW gates the feed', async () => {
    expect((await api(noPerms.token).get('/api/feed')).status).toBe(403);
    expect((await api(student.token).get('/api/feed')).status).toBe(200);
  });

  it('creating a page needs FEED_PAGE_MANAGE — Staff cannot, Admin can', async () => {
    expect((await api(staff.token).post('/api/feed/pages', { name: 'x' })).status).toBe(403);
    expect((await api(admin.token).post('/api/feed/pages', { name: 'ok page' })).status).toBe(201);
  });

  it('posting needs to be a page editor', async () => {
    const r1 = await api(staff.token).post(`/api/feed/pages/${pageId}/posts`, { body: 'hi' });
    expect(r1.status).toBe(403);
    await api(admin.token).post(`/api/feed/pages/${pageId}/editors`, { userId: staff.id, role: 'editor' });
    const r2 = await api(staff.token).post(`/api/feed/pages/${pageId}/posts`, { body: 'hi' });
    expect(r2.status).toBe(201);
  });
});

describe('post lifecycle', () => {
  it('a draft is invisible; publishing shows it; unpublishing hides it', async () => {
    const id = await publish(admin.token, pageId, { status: 'draft' });
    let feed = await api(admin.token).get('/api/feed');
    expect(feed.body.data.items.find((p: { id: string }) => p.id === id)).toBeUndefined();

    await api(admin.token).post(`/api/feed/posts/${id}/publish`);
    feed = await api(admin.token).get('/api/feed');
    expect(feed.body.data.items.find((p: { id: string }) => p.id === id)).toBeDefined();

    await api(admin.token).post(`/api/feed/posts/${id}/unpublish`);
    feed = await api(admin.token).get('/api/feed');
    expect(feed.body.data.items.find((p: { id: string }) => p.id === id)).toBeUndefined();
  });

  it('a scheduled post stays hidden until the sweep runs', async () => {
    const res = await api(admin.token).post(`/api/feed/pages/${pageId}/posts`, {
      body: 'later', status: 'scheduled', scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(res.status).toBe(201);
    const id = res.body.data.postId;
    await getPool().query('UPDATE feed_posts SET scheduled_at = now() - interval \'1 minute\' WHERE id = $1', [id]);
    let feed = await api(admin.token).get('/api/feed');
    expect(feed.body.data.items.find((p: { id: string }) => p.id === id)).toBeUndefined();
    const swept = await runFeedSweep();
    expect(swept.published).toBeGreaterThanOrEqual(1);
    feed = await api(admin.token).get('/api/feed');
    expect(feed.body.data.items.find((p: { id: string }) => p.id === id)).toBeDefined();
  });

  it('editing a published post writes history and stamps editedAt', async () => {
    const id = await publish(admin.token, pageId);
    await api(admin.token).patch(`/api/feed/posts/${id}`, { body: 'edited body' });
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM feed_post_edits WHERE post_id = $1', [id]);
    expect(rows[0].n).toBe(1);
    const view = await api(admin.token).get(`/api/feed/posts/${id}`);
    expect(view.body.data.post.editedAt).not.toBeNull();
    expect(view.body.data.post.body).toBe('edited body');
  });
});

describe('audience scoping', () => {
  it('a students-only post never reaches a parent feed', async () => {
    const studentsPage = await makePage(admin.token, { name: 'Student Life', audience: 'students' });
    await api(admin.token).post(`/api/feed/pages/${studentsPage}/follow`);
    await api(student.token).post(`/api/feed/pages/${studentsPage}/follow`);
    await api(parent.token).post(`/api/feed/pages/${studentsPage}/follow`).catch(() => {});
    const id = await publish(admin.token, studentsPage, { audience: 'students' });

    const studentFeed = await api(student.token).get('/api/feed');
    expect(studentFeed.body.data.items.find((p: { id: string }) => p.id === id)).toBeDefined();

    const parentFeed = await api(parent.token).get('/api/feed');
    expect(parentFeed.body.data.items.find((p: { id: string }) => p.id === id)).toBeUndefined();
    expect((await api(parent.token).get(`/api/feed/posts/${id}`)).status).toBe(404);
  });
});

describe('reactions', () => {
  it('one reaction per user; switching replaces it', async () => {
    const id = await publish(admin.token, pageId);
    await api(student.token).post(`/api/feed/posts/${id}/reactions`, { emoji: 'like' });
    let view = await api(student.token).get(`/api/feed/posts/${id}`);
    expect(view.body.data.post.reactions.total).toBe(1);
    expect(view.body.data.post.reactions.mine).toBe('like');

    await api(student.token).post(`/api/feed/posts/${id}/reactions`, { emoji: 'love' });
    view = await api(student.token).get(`/api/feed/posts/${id}`);
    expect(view.body.data.post.reactions.total).toBe(1);
    expect(view.body.data.post.reactions.mine).toBe('love');

    await api(student.token).post(`/api/feed/posts/${id}/reactions`, { emoji: 'love' });
    view = await api(student.token).get(`/api/feed/posts/${id}`);
    expect(view.body.data.post.reactions.total).toBe(0);
  });
});

describe('comments', () => {
  it('nesting is capped at one level', async () => {
    const id = await publish(admin.token, pageId);
    const top = await api(student.token).post(`/api/feed/posts/${id}/comments`, { body: 'top' });
    const topId = top.body.data.comment.id;
    const reply = await api(parent.token).post(`/api/feed/posts/${id}/comments`, { body: 'reply', parentId: topId });
    const replyId = reply.body.data.comment.id;
    const replyToReply = await api(student.token).post(`/api/feed/posts/${id}/comments`, { body: 'nested', parentId: replyId });
    // re-parented to the top-level comment, not to the reply
    expect(replyToReply.body.data.comment.parentId).toBe(topId);
  });

  it('a closed comment policy blocks commenting', async () => {
    const id = await publish(admin.token, pageId, { commentPolicy: 'closed' });
    expect((await api(student.token).post(`/api/feed/posts/${id}/comments`, { body: 'x' })).status).toBe(403);
  });
});

describe('polls', () => {
  it('single-choice re-vote replaces the previous choice', async () => {
    const id = await publish(admin.token, pageId, {
      body: 'pick', poll: { question: 'Best?', options: ['A', 'B', 'C'] },
    });
    await api(student.token).post(`/api/feed/posts/${id}/vote`, { choices: [0] });
    await api(student.token).post(`/api/feed/posts/${id}/vote`, { choices: [2] });
    const view = await api(student.token).get(`/api/feed/posts/${id}`);
    const poll = view.body.data.post.poll;
    expect(poll.options[0].votes).toBe(0);
    expect(poll.options[2].votes).toBe(1);
    expect(poll.totalVoters).toBe(1);
    expect(poll.myVotes).toEqual([2]);
  });

  it('multi-select keeps every choice', async () => {
    const id = await publish(admin.token, pageId, {
      body: 'pick many', poll: { question: 'Which?', options: ['A', 'B', 'C'], multi: true },
    });
    await api(parent.token).post(`/api/feed/posts/${id}/vote`, { choices: [0, 2] });
    const view = await api(parent.token).get(`/api/feed/posts/${id}`);
    expect(view.body.data.post.poll.myVotes.sort()).toEqual([0, 2]);
  });
});

describe('moderation', () => {
  it('report → queue → remove hides the post and writes an audit row', async () => {
    const id = await publish(admin.token, pageId);
    const rep = await api(student.token).post(`/api/feed/posts/${id}/report`, { reason: 'spam', note: 'looks off' });
    expect(rep.status).toBe(201);
    // second open report from the same person is refused
    expect((await api(student.token).post(`/api/feed/posts/${id}/report`, { reason: 'spam' })).status).toBe(409);

    const queue = await api(admin.token).get('/api/feed/moderation');
    expect(queue.body.data.reports.length).toBeGreaterThanOrEqual(1);
    const reportId = queue.body.data.reports[0].id;

    await api(admin.token).post(`/api/feed/moderation/${reportId}/act`, { action: 'remove' });
    expect((await api(admin.token).get(`/api/feed/posts/${id}`)).status).toBe(404);
    const { rows } = await getPool().query(
      `SELECT 1 FROM audit_log WHERE action = 'feed.moderation.remove' AND target_id = $1`, [id],
    );
    expect(rows.length).toBe(1);
  });
});

describe('following', () => {
  it('a mandatory page cannot be unfollowed', async () => {
    const mp = await makePage(admin.token, { name: 'Required', audience: 'everyone' });
    await getPool().query('UPDATE feed_pages SET mandatory = true WHERE id = $1', [mp]);
    await api(student.token).get('/api/feed'); // triggers ensureMandatoryFollows
    const res = await api(student.token).del(`/api/feed/pages/${mp}/follow`);
    expect(res.status).toBe(409);
  });
});

describe('engagement', () => {
  it('bookmarks round-trip', async () => {
    const id = await publish(admin.token, pageId);
    await api(student.token).post(`/api/feed/posts/${id}/bookmark`);
    const saved = await api(student.token).get('/api/feed/bookmarks');
    expect(saved.body.data.items.find((p: { id: string }) => p.id === id)).toBeDefined();
    await api(student.token).del(`/api/feed/posts/${id}/bookmark`);
    const after = await api(student.token).get('/api/feed/bookmarks');
    expect(after.body.data.items.find((p: { id: string }) => p.id === id)).toBeUndefined();
  });

  it('an impression counts unique reach once per person', async () => {
    const id = await publish(admin.token, pageId);
    await api(student.token).post(`/api/feed/posts/${id}/view`);
    await api(student.token).post(`/api/feed/posts/${id}/view`);
    await api(parent.token).post(`/api/feed/posts/${id}/view`);
    const { rows } = await getPool().query('SELECT view_count, unique_reach FROM feed_posts WHERE id = $1', [id]);
    expect(rows[0].unique_reach).toBe(2);
    expect(rows[0].view_count).toBe(3);
  });
});
