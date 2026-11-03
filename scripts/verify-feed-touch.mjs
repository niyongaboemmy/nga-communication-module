#!/usr/bin/env node
/**
 * The feed by keyboard and on a phone (U-20, U-21, U-23):
 *
 *   - Up on a focused Like opens the reactions with focus inside; arrows move,
 *     Enter picks one;
 *   - a video in a post plays (muted) while on screen and stops when scrolled
 *     away;
 *   - pulling down at the top of the feed on a phone loads a post published
 *     since it was opened.
 *
 *   npm run verify:feed:touch      (needs `npm run dev`)
 */
import { chromium, devices } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
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
const API = 'http://localhost:5190', FILES = 'http://localhost:5192', BASE = 'http://localhost:5194';
const results = []; const ids = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = randomBytes(3).toString('hex');

async function makeUser(name, role) {
  const id = `vft-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = $1`, [role]);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`, [id, name, `${id}@amashuri.com`, role.toLowerCase(), rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: role.toLowerCase() };
  return { id, user, perms, role, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
const call = async (u, method, path, body, base = API) => (await fetch(`${base}${path}`, {
  method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
})).json().catch(() => ({}));
const contextFor = async (browser, u, phone) => {
  const ctx = await browser.newContext(phone ? { ...devices['Pixel 7'] } : { viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, {
    tupo_token: u.token, tupo_user: JSON.stringify(u.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: u.perms, name: u.role }) });
  return ctx;
};

let browser; let pageId = null;
try {
  const editor = await makeUser(`Eda Editor ${tag}`, 'Admin');
  const me = await makeUser(`Rio Reader ${tag}`, 'Staff');
  pageId = (await call(editor, 'POST', '/api/feed/pages', { name: `Touch page ${tag}`, kind: 'club' })).data.page.id;
  await call(me, 'POST', `/api/feed/pages/${pageId}/follow`, { notify: false });
  browser = prepareBrowser(await chromium.launch());

  // A real one-second WebM, recorded from a canvas in the browser.
  const maker = await (await browser.newContext()).newPage();
  const webm = Buffer.from(await maker.evaluate(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 160, height: 90 });
    const g = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(25), { mimeType: 'video/webm' });
    const parts = []; rec.ondataavailable = (e) => parts.push(e.data);
    rec.start(); let t = 0;
    await new Promise((res) => { const tick = () => { g.fillStyle = `hsl(${t * 12},70%,50%)`; g.fillRect(0, 0, 160, 90); if (++t < 30) requestAnimationFrame(tick); else res(); }; tick(); });
    rec.stop(); await new Promise((r) => { rec.onstop = r; });
    return [...new Uint8Array(await new Blob(parts).arrayBuffer())];
  }));
  const ticket = await call(editor, 'POST', '/api/files/tickets', { name: 'clip.webm', mime: 'video/webm', size: webm.length }, FILES);
  await fetch(`${FILES}${ticket.data.uploadUrl}`, { method: 'PUT', headers: { authorization: `Bearer ${editor.token}` }, body: webm });
  for (let i = 0; i < 6; i++) await call(editor, 'POST', `/api/feed/pages/${pageId}/posts`, { body: `filler ${i} ${tag}`, status: 'published' });
  await call(editor, 'POST', `/api/feed/pages/${pageId}/posts`, { body: `video post ${tag}`, status: 'published', media: [{ fileId: ticket.data.fileId, kind: 'video', mime: 'video/webm', name: 'clip.webm', size: webm.length }] });
  await call(editor, 'POST', `/api/feed/pages/${pageId}/posts`, { body: `keyboard post ${tag}`, status: 'published' });

  console.log('\nReactions by keyboard');
  const desk = await (await contextFor(browser, me, false)).newPage();
  await desk.goto(`${BASE}/app/feed`);
  const post = desk.locator('article').filter({ hasText: `keyboard post ${tag}` }).first();
  await post.waitFor({ timeout: 20_000 });
  const like = post.getByRole('button', { name: /^Like/ }).first();
  await like.focus();
  await desk.keyboard.press('ArrowUp');
  const menu = post.getByRole('menu', { name: 'Pick a reaction' });
  check('Up on Like opens the reactions', await menu.waitFor({ timeout: 3_000 }).then(() => true).catch(() => false));
  const focused1 = await desk.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  await desk.keyboard.press('ArrowRight');
  const focused2 = await desk.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  check('with focus inside, and arrows move it', Boolean(focused1) && focused2 !== focused1, `${focused1} → ${focused2}`);
  await desk.keyboard.press('Enter');
  check('Enter picks that reaction', await post.getByRole('button', { name: new RegExp(`^${focused2}`) }).first().waitFor({ timeout: 4_000 }).then(() => true).catch(() => false));

  console.log('\nVideo in a post');
  const vpost = desk.locator('article').filter({ hasText: `video post ${tag}` }).first();
  await vpost.scrollIntoViewIfNeeded();
  const video = vpost.locator('video').first();
  await video.waitFor({ timeout: 10_000 });
  const playing = await desk.waitForFunction((v) => v?.dataset.autoplaying === 'true', await video.elementHandle(), { timeout: 10_000 })
    .then(() => true).catch(() => false);
  check('plays, muted, while on screen', playing && await video.evaluate((v) => v.muted && !v.paused));
  await desk.evaluate(() => document.querySelector('[data-app-scroll]')?.scrollBy(0, -100000));
  await desk.locator('article').first().scrollIntoViewIfNeeded();
  await desk.evaluate(() => document.querySelector('[data-app-scroll]')?.scrollBy(0, 100000));
  const paused = await desk.waitForFunction((v) => v?.paused === true, await video.elementHandle(), { timeout: 6_000 }).then(() => true).catch(() => false);
  check('and stops when scrolled away', paused);

  console.log('\nPull to refresh on a phone');
  const phone = await (await contextFor(browser, me, true)).newPage();
  await phone.goto(`${BASE}/app/feed`);
  await phone.locator('article').filter({ hasText: `keyboard post ${tag}` }).first().waitFor({ timeout: 20_000 });
  await call(editor, 'POST', `/api/feed/pages/${pageId}/posts`, { body: `fresh post ${tag}`, status: 'published' });
  await sleep(800);
  // The pill may announce it live; dismissing nothing, pull straight away.
  const cdp = await phone.context().newCDPSession(phone);
  const point = (y) => [{ x: 200, y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(200) });
  for (let y = 220; y <= 420; y += 20) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(y) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  check('pulling down loads a post published since the feed was opened',
    await phone.locator('article').filter({ hasText: `fresh post ${tag}` }).first().waitFor({ timeout: 8_000 }).then(() => true).catch(() => false));
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  if (pageId) await pool.query('DELETE FROM feed_pages WHERE id = $1', [pageId]).catch(() => {});
  await pool.query(`DELETE FROM files WHERE owner_id = ANY($1)`, [ids]).catch(() => {});
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:feed:touch: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
