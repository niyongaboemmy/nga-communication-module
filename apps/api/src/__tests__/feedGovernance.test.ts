import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';
import { purgeTestUsers } from './purge.js';

/** D-10: warnings reach the author, a handled report is not handled twice, editors can leave. */

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
  del: (p: string) => request(app).delete(p).set('Authorization', `Bearer ${t}`),
});

let admin: Awaited<ReturnType<typeof user>>;
let editor: Awaited<ReturnType<typeof user>>;
let page: string;
beforeAll(async () => {
  await seedRbac(getPool());
  admin = await user('Admin', 'Adm');
  editor = await user('Staff', 'Edi');
  page = (await as(admin.token).post('/api/feed/pages', { name: `Gov ${snowflake()}`, audience: 'everyone' })).body.data.page.id;
  await as(admin.token).post(`/api/feed/pages/${page}/editors`, { userId: editor.id, role: 'editor' });
});
afterAll(async () => {
  await getPool().query('DELETE FROM feed_reports WHERE post_id IN (SELECT id FROM feed_posts WHERE page_id = $1)', [page]).catch(() => {});
  await purgeTestUsers(created);
  await closeDb();
});

describe('moderation', () => {
  it('a warning notifies the author, under its own kind; a handled report is refused', async () => {
    const post = (await as(editor.token).post(`/api/feed/pages/${page}/posts`, { body: 'borderline' })).body.data.postId;
    const reporter = await user('Staff', 'Rep');
    await as(reporter.token).post(`/api/feed/posts/${post}/report`, { reason: 'spam' });
    const queue = (await as(admin.token).get('/api/feed/moderation')).body.data.reports as Array<{ id: string; targetId: string }>;
    const report = queue.find((r) => r.targetId === post)!;
    expect((await as(admin.token).post(`/api/feed/moderation/${report.id}/act`, { action: 'warn' })).status).toBe(200);
    const { rows } = await getPool().query(`SELECT kind, title FROM notifications WHERE user_id = $1 AND kind = 'feed.moderation'`, [editor.id]);
    expect(rows[0]?.title).toBe('A moderator reviewed your post');
    expect((await as(admin.token).post(`/api/feed/moderation/${report.id}/act`, { action: 'remove' })).status).toBe(409);
  });
});

describe('page team', () => {
  it('an editor can leave a page; the last owner cannot', async () => {
    expect((await as(editor.token).del(`/api/feed/pages/${page}/editors/${editor.id}`)).status).toBe(200);
    const { rows } = await getPool().query('SELECT 1 FROM feed_page_editors WHERE page_id = $1 AND user_id = $2', [page, editor.id]);
    expect(rows).toHaveLength(0);
    expect((await as(admin.token).del(`/api/feed/pages/${page}/editors/${admin.id}`)).status).toBeGreaterThanOrEqual(400);
  });
});
