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

  /*
   * The permission to make pages is not a claim over other people's.
   *
   * This is the case that was missing, and its absence hid the bug: every test
   * here used the admin who had created the page, so "may manage a page"
   * and "may manage this page" never had to be told apart.
   */
  it('FEED_PAGE_MANAGE does not confer power over a page you do not own', async () => {
    // A second admin: holds FEED_PAGE_MANAGE, owns nothing here.
    const other = await user('Admin', 'Otto');

    const patched = await api(other.token).patch(`/api/feed/pages/${pageId}`, { name: 'Hijacked' });
    expect(patched.status).toBe(403);

    const branded = await api(other.token).patch(`/api/feed/pages/${pageId}`, { avatarFileId: null, coverFileId: null });
    expect(branded.status).toBe(403);

    const added = await api(other.token)
      .post(`/api/feed/pages/${pageId}/editors`, { userId: other.id, role: 'owner' });
    expect(added.status).toBe(403);

    // …and the page is untouched.
    const page = await api(admin.token).get(`/api/feed/pages/${pageId}`);
    expect(page.body.data.page.name).toBe('NGA News');
  });

  it('an editor cannot restyle the page or promote themselves', async () => {
    const ed = await user('Staff', 'Edie');
    await api(admin.token).post(`/api/feed/pages/${pageId}/editors`, { userId: ed.id, role: 'editor' });

    expect((await api(ed.token).patch(`/api/feed/pages/${pageId}`, { name: 'Edie News' })).status).toBe(403);
    expect((await api(ed.token).post(`/api/feed/pages/${pageId}/editors`, { userId: ed.id, role: 'owner' })).status).toBe(403);
    // But they can still do the thing being an editor is for.
    expect((await api(ed.token).post(`/api/feed/pages/${pageId}/posts`, { body: 'as the page' })).status).toBe(201);
  });

  it('an owner manages their own page without holding FEED_PAGE_MANAGE', async () => {
    const owner = await user('Staff', 'Olga');
    await api(admin.token).post(`/api/feed/pages/${pageId}/editors`, { userId: owner.id, role: 'owner' });

    const r = await api(owner.token).patch(`/api/feed/pages/${pageId}`, { bio: 'Ours to run.' });
    expect(r.status).toBe(200);
    expect(r.body.data.page.bio).toBe('Ours to run.');

    // Institutional flags stay with the institution, owner or not.
    expect((await api(owner.token).patch(`/api/feed/pages/${pageId}`, { verified: true })).status).toBe(403);
  });

  it('addressing a page by slug updates that page rather than silently nothing', async () => {
    const page = (await api(admin.token).get(`/api/feed/pages/${pageId}`)).body.data.page;
    const r = await api(admin.token).patch(`/api/feed/pages/${page.slug}`, { bio: 'By slug.' });
    expect(r.status).toBe(200);
    expect(r.body.data.page.bio).toBe('By slug.');
  });
});

describe('page profile', () => {
  it('quick links save in order and refuse anything but http(s) and mailto', async () => {
    const links = [
      { label: 'Register', url: 'https://forms.example.com/club' },
      { label: 'Email us', url: 'mailto:club@amashuri.com' },
    ];
    const r = await api(admin.token).patch(`/api/feed/pages/${pageId}`, { links });
    expect(r.status).toBe(200);
    expect(r.body.data.page.links).toEqual(links);

    // A button anyone can press must never carry a script.
    const xss = await api(admin.token).patch(`/api/feed/pages/${pageId}`, {
      links: [{ label: 'Click', url: 'javascript:alert(1)' }],
    });
    expect(xss.status).toBe(400);
    const junk = await api(admin.token).patch(`/api/feed/pages/${pageId}`, { links: [{ label: 'x', url: 'not a url' }] });
    expect(junk.status).toBe(400);
    const tooMany = await api(admin.token).patch(`/api/feed/pages/${pageId}`, {
      links: Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, url: 'https://example.com' })),
    });
    expect(tooMany.status).toBe(400);

    // A rejected patch leaves the previous links alone; the links travel with posts too.
    const page = await api(admin.token).get(`/api/feed/pages/${pageId}`);
    expect(page.body.data.page.links).toEqual(links);
    const id = await publish(admin.token, pageId);
    const view = await api(admin.token).get(`/api/feed/posts/${id}`);
    expect(view.body.data.post.page.links).toEqual(links);

    await api(admin.token).patch(`/api/feed/pages/${pageId}`, { links: [] });
  });

  it('a team member can carry a title; only an owner may set one', async () => {
    const pres = await user('Student', 'Prisca');
    const added = await api(admin.token)
      .post(`/api/feed/pages/${pageId}/editors`, { userId: pres.id, role: 'editor', title: 'President' });
    expect(added.status).toBe(200);
    let me = added.body.data.page.editors.find((e: { id: string }) => e.id === pres.id);
    expect(me.title).toBe('President');
    expect(me.role).toBe('editor');

    // Titles are the owner's to give — an editor cannot rename themselves.
    expect((await api(pres.token).patch(`/api/feed/pages/${pageId}/editors/${pres.id}`, { title: 'Chair' })).status).toBe(403);

    const renamed = await api(admin.token).patch(`/api/feed/pages/${pageId}/editors/${pres.id}`, { title: '  Vice President  ' });
    expect(renamed.status).toBe(200);
    me = renamed.body.data.page.editors.find((e: { id: string }) => e.id === pres.id);
    expect(me.title).toBe('Vice President');

    // Demoting the last owner is refused, same as removing them.
    expect((await api(admin.token).patch(`/api/feed/pages/${pageId}/editors/${admin.id}`, { role: 'editor' })).status).toBe(409);
    expect((await api(admin.token).patch(`/api/feed/pages/${pageId}/editors/${student.id}`, { title: 'x' })).status).toBe(404);

    await api(admin.token).del(`/api/feed/pages/${pageId}/editors/${pres.id}`);
  });

  it('pinned posts lead the page, need a say in the page, and are capped', async () => {
    const older = await publish(admin.token, pageId, { body: 'older' });
    await getPool().query(`UPDATE feed_posts SET published_at = now() - interval '1 hour' WHERE id = $1`, [older]);
    const newer = await publish(admin.token, pageId, { body: 'newer' });

    // A following student may read the page but has no say in it.
    await api(student.token).post(`/api/feed/pages/${pageId}/follow`);
    expect((await api(student.token).post(`/api/feed/posts/${older}/pin`, { pinned: true })).status).toBe(403);
    const asStudent = await api(student.token).get(`/api/feed/posts/${older}`);
    expect(asStudent.body.data.post.canPin).toBe(false);

    const pinned = await api(admin.token).post(`/api/feed/posts/${older}/pin`, { pinned: true });
    expect(pinned.status).toBe(200);
    expect(pinned.body.data.post.pinned).toBe(true);
    // A pin is not an edit: no revision, no "Edited" stamp.
    expect(pinned.body.data.post.editedAt).toBeNull();
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM feed_post_edits WHERE post_id = $1', [older]);
    expect(rows[0].n).toBe(0);

    const list = await api(student.token).get(`/api/feed/pages/${pageId}/posts`);
    const ids = list.body.data.items.map((p: { id: string }) => p.id);
    expect(ids.indexOf(older)).toBe(0);
    expect(ids.indexOf(newer)).toBe(1);
    expect(ids.filter((id: string) => id === older)).toHaveLength(1);

    // Only a published post can lead the page.
    const draft = await publish(admin.token, pageId, { status: 'draft' });
    expect((await api(admin.token).post(`/api/feed/posts/${draft}/pin`, { pinned: true })).status).toBe(409);

    // Three is the spotlight; the fourth must wait for an unpin.
    await api(admin.token).post(`/api/feed/posts/${newer}/pin`, { pinned: true });
    const third = await publish(admin.token, pageId, { body: 'third' });
    await api(admin.token).post(`/api/feed/posts/${third}/pin`, { pinned: true });
    const fourth = await publish(admin.token, pageId, { body: 'fourth' });
    expect((await api(admin.token).post(`/api/feed/posts/${fourth}/pin`, { pinned: true })).status).toBe(409);

    const unpinned = await api(admin.token).post(`/api/feed/posts/${older}/pin`, { pinned: false });
    expect(unpinned.body.data.post.pinned).toBe(false);
    expect((await api(admin.token).post(`/api/feed/posts/${fourth}/pin`, { pinned: true })).status).toBe(200);

    await api(student.token).del(`/api/feed/pages/${pageId}/follow`);
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

describe('page followers list', () => {
  it('is for the page owner only — not editors, followers, or admins who do not own it', async () => {
    const page = await makePage(admin.token, { name: `Followers ${snowflake()}`, audience: 'everyone' });
    await api(student.token).post(`/api/feed/pages/${page}/follow`);
    await api(admin.token).post(`/api/feed/pages/${page}/editors`, { userId: staff.id, role: 'editor' });
    const otherAdmin = await user('Admin', 'Otto');

    const own = await api(admin.token).get(`/api/feed/pages/${page}/followers`);
    expect(own.status).toBe(200);
    expect(own.body.data.followers.map((f: { id: string }) => f.id)).toContain(student.id);
    expect(own.body.data.followers.find((f: { id: string }) => f.id === student.id)).toMatchObject({ name: 'Stu', followedAt: expect.any(String) });

    expect((await api(staff.token).get(`/api/feed/pages/${page}/followers`)).status).toBe(403);
    expect((await api(student.token).get(`/api/feed/pages/${page}/followers`)).status).toBe(403);
    expect((await api(otherAdmin.token).get(`/api/feed/pages/${page}/followers`)).status).toBe(403);
    expect((await api(noPerms.token).get(`/api/feed/pages/${page}/followers`)).status).toBe(403);
  });

  it('searches by name', async () => {
    const page = await makePage(admin.token, { name: `Search ${snowflake()}`, audience: 'everyone' });
    await api(student.token).post(`/api/feed/pages/${page}/follow`);
    await api(staff.token).post(`/api/feed/pages/${page}/follow`);
    const res = await api(admin.token).get(`/api/feed/pages/${page}/followers?q=stu`);
    expect(res.body.data.followers.map((f: { id: string }) => f.id)).toEqual([student.id]);
  });
});

describe('who reacted', () => {
  it('anyone who can see the post sees who reacted, with per-reaction counts and a filter', async () => {
    const id = await publish(admin.token, pageId, { body: `reactors ${snowflake()}` });
    await api(student.token).post(`/api/feed/posts/${id}/reactions`, { emoji: 'like' });
    await api(staff.token).post(`/api/feed/posts/${id}/reactions`, { emoji: 'love' });

    const all = await api(parent.token).get(`/api/feed/posts/${id}/reactions`);
    expect(all.status).toBe(200);
    expect(all.body.data.counts).toEqual({ like: 1, love: 1 });
    expect(all.body.data.reactors.map((r: { id: string }) => r.id).sort()).toEqual([student.id, staff.id].sort());
    expect(all.body.data.reactors.find((r: { id: string }) => r.id === student.id)).toMatchObject({ name: 'Stu', reaction: 'like' });

    const loves = await api(parent.token).get(`/api/feed/posts/${id}/reactions?reaction=love`);
    expect(loves.body.data.reactors.map((r: { id: string }) => r.id)).toEqual([staff.id]);
  });

  it('is hidden from someone who cannot see the post', async () => {
    const studentsPage = await makePage(admin.token, { name: `Students ${snowflake()}`, audience: 'students' });
    const id = await publish(admin.token, studentsPage, { audience: 'students' });
    await api(student.token).post(`/api/feed/posts/${id}/reactions`, { emoji: 'like' });
    expect((await api(student.token).get(`/api/feed/posts/${id}/reactions`)).status).toBe(200);
    expect([403, 404]).toContain((await api(parent.token).get(`/api/feed/posts/${id}/reactions`)).status);
    expect((await api(noPerms.token).get(`/api/feed/posts/${id}/reactions`)).status).toBe(403);
  });
});
