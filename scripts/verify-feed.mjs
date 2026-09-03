#!/usr/bin/env node
/**
 * Feed (FR-FEED-1…12) — the spine, against the running stack.
 *
 * The invariants worth pinning:
 *   · FEED_VIEW gates the feed; FEED_POST + page-editor gates posting
 *   · a published post fans out to a follower's timeline and streams live
 *   · a reaction and a comment reach a second, subscribed socket
 *   · audience scoping keeps a students-only post out of a parent's feed
 *   · a scheduled post is invisible until the worker sweep publishes it
 *   · report → moderation queue → remove hides the post for everyone
 *   · a mandatory page cannot be unfollowed
 *
 *   npm run verify:feed        (needs `npm run dev` running)
 */
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { io as ioClient } from 'socket.io-client';

const env = Object.fromEntries(readFileSync('apps/api/.env', 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));

const API = 'http://localhost:5190';
const WS = 'http://localhost:5191';
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

const pass = [], fails = [];
const check = (name, ok, detail = '') => {
  const line = `${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`;
  (ok ? pass : fails).push(line);
  process.stderr.write('  ' + line + '\n');
  return ok;
};
const step = (s) => process.stderr.write(`\n  • ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeUser(name, roleName) {
  const id = `feedtest-${randomBytes(6).toString('hex')}`;
  const { rows } = await pool.query('SELECT id FROM roles WHERE name = $1', [roleName]);
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, roleName.toLowerCase(), rows[0]?.id ?? null]);
  const token = jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: roleName.toLowerCase() },
    env.JWT_SECRET, { expiresIn: '30m' });
  return { id, name, token };
}

const api = async (path, token, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(WS, { auth: { token }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket timeout')), 5000);
  });
}
const waitFor = (socket, event, pred = () => true, ms = 4000) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms);
  socket.on(event, (p) => { if (pred(p)) { clearTimeout(t); resolve(p); } });
});

async function main() {
  const admin = await makeUser('Feed Admin', 'Admin');
  const staff = await makeUser('Feed Staff', 'Staff');
  const student = await makeUser('Feed Student', 'Student');
  const parent = await makeUser('Feed Parent', 'Parent');

  step('permissions');
  check('FEED_VIEW lets a student read the feed', (await api('/api/feed', student.token)).status === 200);
  check('a staff without FEED_PAGE_MANAGE cannot create a page',
    (await api('/api/feed/pages', staff.token, { method: 'POST', body: { name: 'x' } })).status === 403);

  step('page + post');
  const pageRes = await api('/api/feed/pages', admin.token, { method: 'POST', body: { name: `Verify ${randomBytes(3).toString('hex')}`, audience: 'everyone' } });
  const pageId = pageRes.body.data.page.id;
  check('admin creates a page', pageRes.status === 201, pageId);

  check('staff cannot post to a page they do not edit',
    (await api(`/api/feed/pages/${pageId}/posts`, staff.token, { method: 'POST', body: { body: 'hi' } })).status === 403);
  await api(`/api/feed/pages/${pageId}/editors`, admin.token, { method: 'POST', body: { userId: staff.id, role: 'editor' } });
  check('added as editor, staff can post',
    (await api(`/api/feed/pages/${pageId}/posts`, staff.token, { method: 'POST', body: { body: 'editor post' } })).status === 201);

  step('live fan-out');
  await api(`/api/feed/pages/${pageId}/follow`, student.token, { method: 'POST' });
  const studentSocket = await connect(student.token);
  const gotNew = waitFor(studentSocket, 'feed:post_new', (p) => p.post?.page?.id === pageId);
  const created = await api(`/api/feed/pages/${pageId}/posts`, admin.token, { method: 'POST', body: { body: 'live hello' } });
  const postId = created.body.data.postId;
  const newEvt = await gotNew;
  check('a follower receives feed:post_new over the socket', Boolean(newEvt));
  check('the post is in the follower timeline',
    (await api('/api/feed', student.token)).body.data.items.some((p) => p.id === postId));

  studentSocket.emit('feed:subscribe', { postIds: [postId] });
  await sleep(200);
  const gotReaction = waitFor(studentSocket, 'feed:reaction', (p) => p.postId === postId);
  await api(`/api/feed/posts/${postId}/reactions`, admin.token, { method: 'POST', body: { emoji: 'love' } });
  check('a reaction streams to a subscribed socket', Boolean(await gotReaction));

  const gotComment = waitFor(studentSocket, 'feed:comment_new', (p) => p.postId === postId);
  await api(`/api/feed/posts/${postId}/comments`, student.token, { method: 'POST', body: { body: 'nice one' } });
  check('a comment streams to a subscribed socket', Boolean(await gotComment));

  step('audience scoping');
  const spRes = await api('/api/feed/pages', admin.token, { method: 'POST', body: { name: `Students ${randomBytes(3).toString('hex')}`, audience: 'students' } });
  const sp = spRes.body.data.page.id;
  await api(`/api/feed/pages/${sp}/follow`, student.token, { method: 'POST' });
  const spPost = (await api(`/api/feed/pages/${sp}/posts`, admin.token, { method: 'POST', body: { body: 'students only', audience: 'students' } })).body.data.postId;
  check('student sees a students-audience post', (await api('/api/feed', student.token)).body.data.items.some((p) => p.id === spPost));
  check('parent does not see it', !(await api('/api/feed', parent.token)).body.data.items.some((p) => p.id === spPost));
  check('parent gets 404 on the permalink', (await api(`/api/feed/posts/${spPost}`, parent.token)).status === 404);

  step('scheduled publish');
  const sched = await api(`/api/feed/pages/${pageId}/posts`, admin.token, {
    method: 'POST', body: { body: 'from the future', status: 'scheduled', scheduledAt: new Date(Date.now() + 60000).toISOString() },
  });
  const schedId = sched.body.data.postId;
  check('a scheduled post is hidden', !(await api('/api/feed', admin.token)).body.data.items.some((p) => p.id === schedId));
  await pool.query(`UPDATE feed_posts SET scheduled_at = now() - interval '1 minute' WHERE id = $1`, [schedId]);
  process.stderr.write('    waiting for the worker sweep (≤30s)…\n');
  let appeared = false;
  for (let i = 0; i < 20 && !appeared; i++) {
    await sleep(2000);
    appeared = (await api('/api/feed', admin.token)).body.data.items.some((p) => p.id === schedId);
  }
  check('the worker sweep publishes it', appeared);

  step('moderation');
  await api(`/api/feed/posts/${postId}/report`, parent.token, { method: 'POST', body: { reason: 'spam' } });
  const queue = await api('/api/feed/moderation', admin.token);
  const report = queue.body.data.reports.find((r) => r.targetId === postId);
  check('the report lands in the queue', Boolean(report));
  if (report) {
    await api(`/api/feed/moderation/${report.id}/act`, admin.token, { method: 'POST', body: { action: 'remove' } });
    check('remove hides the post', (await api(`/api/feed/posts/${postId}`, admin.token)).status === 404);
  }

  step('mandatory follow');
  await pool.query('UPDATE feed_pages SET mandatory = true WHERE id = $1', [pageId]);
  await api('/api/feed', student.token);
  check('a mandatory page cannot be unfollowed',
    (await api(`/api/feed/pages/${pageId}/follow`, student.token, { method: 'DELETE' })).status === 409);

  studentSocket.close();

  // Cleanup
  await pool.query(`DELETE FROM users WHERE id LIKE 'feedtest-%'`);
  await pool.query(`DELETE FROM feed_pages WHERE created_by IS NULL AND name LIKE 'Verify %' OR name LIKE 'Students %'`).catch(() => {});
  await pool.end();

  process.stderr.write(`\n  ${pass.length} passed, ${fails.length} failed\n`);
  process.exit(fails.length ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
