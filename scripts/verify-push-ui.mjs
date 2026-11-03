#!/usr/bin/env node
/**
 * Notifications on the device (N-02, N-03, N-04), in a real browser. The
 * service worker's push path is driven through the hook it exposes for tests
 * (`self.__tupoShowPush`), since a headless browser has no push service:
 *
 *   - two pushes from one conversation are one notification that counts,
 *     with a "Mark as read" action;
 *   - "Mark as read" from the worker reads the conversation on the server,
 *     with the session the page handed it;
 *   - reading the conversation in the app closes its notification;
 *   - signing out takes the worker's copy of the session away.
 *
 *   npm run verify:push-ui      (needs `npm run dev`)
 */
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { purgeUsers } from './lib/purge.mjs';
import { prepareBrowser } from './lib/uiHarness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const API = 'http://localhost:5190', BASE = 'http://localhost:5194';
const results = []; const ids = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const tag = randomBytes(3).toString('hex');

async function makeUser(name) {
  const id = `vpu-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = 'Staff'`);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`, [id, name, `${id}@amashuri.com`, rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' };
  return { id, user, perms, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
const call = async (u, method, path, body) => (await fetch(`${API}${path}`, {
  method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
})).json().catch(() => ({}));
const unreadOf = async (userId, convId) => (await pool.query(
  'SELECT unread_count FROM conversation_members WHERE user_id = $1 AND conversation_id = $2', [userId, convId])).rows[0]?.unread_count;

let browser; const convs = [];
try {
  const me = await makeUser(`Pia Push ${tag}`);
  const other = await makeUser(`Ole Other ${tag}`);
  const mk = async (name) => { const c = (await call(other, 'POST', '/api/chat/conversations', { type: 'group', name, memberIds: [me.id] })).data.conversation.id; convs.push(c); return c; };
  const convA = await mk(`Push A ${tag}`);
  const convB = await mk(`Push B ${tag}`);
  for (const c of [convA, convB]) await call(other, 'POST', `/api/chat/conversations/${c}/messages`, { body: `hello ${tag}`, nonce: randomUUID() });

  // Chrome's full ("new") headless mode: the minimal headless shell refuses
  // notifications whatever the permission says.
  browser = prepareBrowser(await chromium.launch({ channel: 'chromium' }));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.grantPermissions(['notifications'], { origin: BASE });
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, {
    tupo_token: me.token, tupo_user: JSON.stringify(me.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: me.perms, name: 'Staff' }) });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/feed`);
  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 20_000 });
  const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  await page.waitForTimeout(500);

  const push = (data) => worker.evaluate((d) => self.__tupoShowPush(d), data);
  const shown = (conversationId) => worker.evaluate(async (c) => (await self.registration.getNotifications())
    .filter((n) => n.data?.conversationId === c)
    .map((n) => ({ body: n.body, count: n.data.count, actions: (n.actions ?? []).map((a) => a.action) })), conversationId);

  console.log('\nStacking');
  const base = { title: 'Ole', kind: 'chat.dm', tag: `chat.dm:${convA}`, conversationId: convA, link: `/app/chat/${convA}`, badge: 2 };
  await push({ ...base, body: 'first line' });
  await push({ ...base, body: 'second line' });
  const a = await shown(convA);
  check('two pushes from one conversation are one notification', a.length === 1, `${a.length} shown`);
  check('that counts and shows the newest line', a[0]?.body === '2 new messages · second line', a[0]?.body);
  check('with a "Mark as read" action', a[0]?.actions.includes('read'));

  console.log('\nMark as read from the notification');
  check('the conversation starts unread', (await unreadOf(me.id, convB)) > 0);
  const ok = await worker.evaluate((c) => self.__tupoMarkRead(c), convB);
  check('the worker reads it with the session the page gave it', ok === true && (await unreadOf(me.id, convB)) === 0,
    `ok=${ok} unread=${await unreadOf(me.id, convB)}`);

  console.log('\nRead in the app');
  check('a notification for conversation A is showing', (await shown(convA)).length === 1);
  await page.goto(`${BASE}/app/chat?c=${convA}`);
  await page.getByText(`hello ${tag}`).first().waitFor({ timeout: 15_000 });
  let left = 1;
  for (let i = 0; i < 20 && left > 0; i++) { await page.waitForTimeout(300); left = (await shown(convA)).length; }
  check('opening the conversation closes its notification', left === 0, `${left} left`);

  console.log('\nSign-out');
  await page.evaluate(async () => { (await import('/src/lib/api.ts')).clearSession(); await new Promise((r) => setTimeout(r, 500)); });
  const token = await worker.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open('tupo-sw', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('token'); g.onsuccess = () => resolve(g.result ?? null); };
    r.onerror = () => resolve('error');
  }));
  check("signing out takes the worker's session away", token === null, String(token).slice(0, 12));
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  for (const c of convs) await pool.query('DELETE FROM conversations WHERE id = $1', [c]).catch(() => {});
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:push-ui: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
