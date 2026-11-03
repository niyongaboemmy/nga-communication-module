#!/usr/bin/env node
/**
 * Chat on a phone, and after a jump into the past (U-01, U-04):
 *
 *   - a link to an old message opens a window around it; scrolling down loads
 *     what came after, and "Jump to latest" reaches the newest message;
 *   - swiping a message right starts a reply to it;
 *   - long-pressing a message opens its actions, quick reactions included.
 *
 *   npm run verify:chat:touch      (needs `npm run dev`)
 */
import { chromium, devices } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { purgeUsers } from './lib/purge.mjs';
import { prepareBrowser } from './lib/uiHarness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
process.env.DATABASE_URL ??= env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const API = 'http://localhost:5190', BASE = 'http://localhost:5194';
const results = []; const ids = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = randomBytes(3).toString('hex');

async function makeUser(name) {
  const id = `vct-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = 'Staff'`);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`, [id, name, `${id}@amashuri.com`, rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' };
  return { id, user, perms, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
const contextFor = async (browser, u, phone) => {
  const ctx = await browser.newContext(phone ? { ...devices['Pixel 7'] } : { viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, {
    tupo_token: u.token, tupo_user: JSON.stringify(u.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: u.perms, name: 'Staff' }) });
  return ctx;
};

let browser; let convId = null;
try {
  const me = await makeUser(`Tao Touch ${tag}`);
  const other = await makeUser(`Uma Other ${tag}`);
  convId = (await (await fetch(`${API}/api/chat/conversations`, { method: 'POST', headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'group', name: `Touch ${tag}`, memberIds: [me.id] }) })).json()).data.conversation.id;
  const chat = await import('@tupo/chat');
  const sent = [];
  for (let i = 0; i < 120; i++) {
    sent.push((await chat.sendMessage({ conversationId: convId, senderId: other.id, body: `line ${String(i).padStart(3, '0')}`, nonce: `t-${i}-${tag}` })).message);
  }
  browser = prepareBrowser(await chromium.launch());

  console.log('\nAfter a jump into the past');
  const desk = await (await contextFor(browser, me, false)).newPage();
  const log = desk.locator('[role="log"]');
  const jump = async () => {
    await desk.goto(`${BASE}/app/chat?c=${convId}&m=${sent[10].id}`);
    await log.getByText('line 010').first().waitFor({ timeout: 15_000 });
  };
  await jump();
  check('the link opens around the old message, not at the end', !(await log.getByText('line 119').first().isVisible().catch(() => false)));
  const latestBtn = desk.getByRole('button', { name: /Jump to latest/ });
  check('"Jump to latest" is offered while newer messages are not loaded', await latestBtn.waitFor({ timeout: 5_000 }).then(() => true).catch(() => false));
  await latestBtn.click();
  check('"Jump to latest" reaches the newest message', await log.getByText('line 119').first().waitFor({ timeout: 8_000 }).then(() => true).catch(() => false));

  await jump();
  for (let i = 0; i < 6; i++) {
    await desk.evaluate(() => { let el = document.querySelector('[role="log"]'); while (el && !(/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 4)) el = el.parentElement; if (el) el.scrollTop = el.scrollHeight; });
    await sleep(800);
  }
  check('scrolling down keeps loading what came after, to the end', await log.getByText('line 119').first().isVisible().catch(() => false));
  check('and then "Jump to latest" goes away', !(await latestBtn.isVisible().catch(() => false)));

  console.log('\nOn a phone');
  const phone = await (await contextFor(browser, me, true)).newPage();
  await phone.goto(`${BASE}/app/chat?c=${convId}`);
  const row = phone.locator('li[data-message-row]').filter({ hasText: 'line 118' }).first();
  await row.waitFor({ timeout: 15_000 });
  /** Pointer events as a finger makes them. */
  const touch = (steps) => row.evaluate(async (el, s) => {
    const r = el.getBoundingClientRect();
    const at = (dx, dy) => ({ clientX: r.left + 40 + dx, clientY: r.top + r.height / 2 + dy, pointerId: 7, pointerType: 'touch', bubbles: true, isPrimary: true });
    for (const [type, dx, dy, wait] of s) {
      el.dispatchEvent(new PointerEvent(type, at(dx, dy)));
      if (wait) await new Promise((res) => setTimeout(res, wait));
    }
  }, steps);
  await touch([['pointerdown', 0, 0, 16], ['pointermove', 20, 2, 16], ['pointermove', 50, 3, 16], ['pointermove', 80, 4, 16], ['pointerup', 80, 4, 0]]);
  check('swiping a message right starts a reply to it', await phone.getByText(/Replying to Uma Other/).first().waitFor({ timeout: 3_000 }).then(() => true).catch(() => false));
  await touch([['pointermove', 0, 30, 0], ['pointerdown', 0, 0, 0]]);
  await touch([['pointerdown', 0, 0, 600], ['pointerup', 0, 0, 0]]);
  check('long-pressing a message opens its actions', await phone.getByText('Copy text').first().waitFor({ timeout: 3_000 }).then(() => true).catch(() => false));
  check('with quick reactions, even on a phone', await phone.getByRole('button', { name: /^React with/ }).first().isVisible().catch(() => false));
  const scrolled = await row.evaluate(async (el) => {
    const r = el.getBoundingClientRect();
    const ev = (type, dy) => el.dispatchEvent(new PointerEvent(type, { clientX: r.left + 40, clientY: r.top + 10 + dy, pointerId: 8, pointerType: 'touch', bubbles: true }));
    ev('pointerdown', 0); ev('pointermove', 30); ev('pointermove', 60);
    const t = getComputedStyle(el).transform; ev('pointerup', 60);
    return t;
  });
  check('a vertical drag is left to scrolling (the row does not move)', scrolled === 'none' || scrolled === 'matrix(1, 0, 0, 1, 0, 0)', scrolled);

  console.log('\nPictures on a phone');
  const FILES = 'http://localhost:5192';
  const fileIds = [];
  for (const color of ['#cc3333', '#3366cc']) {
    const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: color } }).png().toBuffer();
    const t = await (await fetch(`${FILES}/api/files/tickets`, { method: 'POST', headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: `pic-${color.slice(1)}.png`, mime: 'image/png', size: png.length }) })).json();
    await fetch(`${FILES}${t.data.uploadUrl}`, { method: 'PUT', headers: { authorization: `Bearer ${other.token}` }, body: png });
    fileIds.push(t.data.fileId);
  }
  await fetch(`${API}/api/chat/conversations/${convId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ body: `two pictures ${tag}`, nonce: `pics-${tag}`, attachments: fileIds }) });
  await phone.getByRole('button', { name: 'Open pic-cc3333.png' }).first().click({ timeout: 15_000 });
  const viewer = phone.locator('[data-lightbox]');
  await viewer.waitFor({ timeout: 5_000 });
  const pos = async () => (await viewer.innerText()).match(/(\d) \/ (\d)/)?.[0];
  check('the viewer opens on the tapped picture', (await pos()) === '1 / 2', await pos());
  await viewer.locator('div.grid').first().evaluate(async (el) => {
    const ev = (type, x) => el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 300, pointerId: 9, pointerType: 'touch', bubbles: true }));
    ev('pointerdown', 300); ev('pointerup', 120);
  });
  await sleep(300);
  check('swiping left shows the next picture', (await pos()) === '2 / 2', await pos());
  const img = viewer.locator('img').first();
  await img.waitFor({ timeout: 5_000 });
  await img.click(); await img.click();
  check('a double tap zooms in', (await img.getAttribute('data-zoomed')) === 'true');
  await sleep(350);
  await img.click(); await img.click();
  check('and another zooms back out', (await img.getAttribute('data-zoomed')) === 'false');
  await pool.query('DELETE FROM files WHERE id = ANY($1)', [fileIds]).catch(() => {});
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  if (convId) await pool.query('DELETE FROM conversations WHERE id = $1', [convId]).catch(() => {});
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:chat:touch: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
