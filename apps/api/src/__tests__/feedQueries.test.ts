import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';
import { purgeTestUsers } from './purge.js';

/** D-11: counted and limited in SQL — poll totals, two replies per comment, moderation previews. */

const created: string[] = [];
async function user(role: string, name: string) {
  const id = snowflake();
  created.push(id);
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [role]);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, role.toLowerCase(), rows[0]!.id]);
  return { id, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: role.toLowerCase() }, config.jwtSecret) };
}
const as = (t: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${t}`),
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
});

let admin: Awaited<ReturnType<typeof user>>;
let page: string;
beforeAll(async () => {
  await seedRbac(getPool());
  admin = await user('Admin', 'Adm');
  page = (await as(admin.token).post('/api/feed/pages', { name: `Queries ${snowflake()}`, audience: 'everyone' })).body.data.page.id;
});
afterAll(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM feed_reports WHERE post_id IN (SELECT id FROM feed_posts WHERE page_id = $1)', [page]).catch(() => {});
  await pool.query('DELETE FROM feed_poll_votes WHERE post_id IN (SELECT id FROM feed_posts WHERE page_id = $1)', [page]).catch(() => {});
  await pool.query('DELETE FROM feed_comments WHERE post_id IN (SELECT id FROM feed_posts WHERE page_id = $1)', [page]).catch(() => {});
  await purgeTestUsers(created);
  await closeDb();
});

describe('feed queries', () => {
  it('poll totals, voter count and my votes come out right', async () => {
    const post = (await as(admin.token).post(`/api/feed/pages/${page}/posts`, { body: 'p', poll: { question: 'Q?', options: ['A', 'B', 'C'] } })).body.data.postId;
    const voters = [await user('Staff', 'V1'), await user('Staff', 'V2'), await user('Student', 'V3')];
    await as(voters[0]!.token).post(`/api/feed/posts/${post}/vote`, { choices: [0] });
    await as(voters[1]!.token).post(`/api/feed/posts/${post}/vote`, { choices: [1] });
    await as(voters[2]!.token).post(`/api/feed/posts/${post}/vote`, { choices: [1] });
    const view = (await as(voters[1]!.token).get(`/api/feed/posts/${post}`)).body.data.post;
    expect(view.poll.totalVoters).toBe(3);
    expect(view.poll.options.map((o: { votes: number }) => o.votes)).toEqual([1, 2, 0]);
    expect(view.poll.myVotes).toEqual([1]);
  });

  it('a comment carries at most two replies, the oldest', async () => {
    const post = (await as(admin.token).post(`/api/feed/pages/${page}/posts`, { body: 'c' })).body.data.postId;
    const top = (await as(admin.token).post(`/api/feed/posts/${post}/comments`, { body: 'top' })).body.data;
    const topId = top.comment?.id ?? top.id;
    for (let i = 1; i <= 4; i++) await as(admin.token).post(`/api/feed/posts/${post}/comments`, { body: `reply ${i}`, parentId: topId });
    const list = (await as(admin.token).get(`/api/feed/posts/${post}/comments`)).body.data.items;
    const t = list.find((c: { id: string }) => c.id === topId);
    expect(t.replies.map((r: { body: string }) => r.body)).toEqual(['reply 1', 'reply 2']);
  });

  it('the moderation queue shows a preview for every report', async () => {
    const post = (await as(admin.token).post(`/api/feed/pages/${page}/posts`, { body: 'report this one' })).body.data.postId;
    const r = await user('Staff', 'Reporter');
    await as(r.token).post(`/api/feed/posts/${post}/report`, { reason: 'spam' });
    const queue = (await as(admin.token).get('/api/feed/moderation')).body.data;
    const items = (queue.reports ?? queue.items ?? queue) as Array<{ targetId: string; preview: { body: string } | null }>;
    expect(items.find((i) => i.targetId === post)?.preview?.body).toBe('report this one');
  });
});
