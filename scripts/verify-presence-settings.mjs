#!/usr/bin/env node
/**
 * Presence, status, theme, toasts and the settings page (F-10).
 *
 * Gateway: one status per person worked out from every tab (an idle tab no
 * longer reports "away" over the one in use), picks that hold across devices
 * (busy, do not disturb, appear offline), "in a meeting" while in a call, and
 * appear-offline still counting as connected for push.
 *
 * Browser: the theme pick sticks across reloads and "System" follows the
 * device; the status picker in the account menu; do not disturb silences
 * pop-ups but still fills the bell; a toast stays while hovered; the settings
 * page fits a phone.
 *
 *   npm run verify:presence:settings      (needs `npm run dev`)
 */
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { io } from 'socket.io-client';
import { Redis } from 'ioredis';
import { purgeUsers } from './lib/purge.mjs';
import { prepareBrowser } from './lib/uiHarness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = process.env.OUT ?? '/tmp/verify-presence-settings';
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const redis = new Redis(env.REDIS_URL || 'redis://localhost:6379');
const API = 'http://localhost:5190', WS = 'http://localhost:5191', BASE = 'http://localhost:5194';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const ids = []; const sockets = []; const meetings = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const nonce = () => randomBytes(8).toString('hex');

async function makeUser(name) {
  const id = `vst-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = 'Staff'`);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`, [id, name, `${id}@amashuri.com`, rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' };
  return { id, name, perms, user, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
const call = async (u, method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};

/** A socket that records the presence updates it sees. */
function connect(u, nsp = '') {
  return new Promise((resolve, reject) => {
    const s = io(`${WS}${nsp}`, { auth: { token: u.token }, transports: ['websocket'], reconnection: false });
    sockets.push(s);
    s.seen = []; s.self = [];
    s.on('presence:update', (p) => s.seen.push(p));
    s.on('presence:self', (p) => s.self.push(p));
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
const emitAck = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, (x) => r(x)));
/** The latest status `watcher` has seen for `userId`, after things settle. */
async function seenAs(watcher, userId, wait = 700) {
  await sleep(wait);
  const mine = watcher.seen.filter((p) => p.userId === userId);
  return mine.length ? mine[mine.length - 1].status : null;
}

async function pageFor(browser, u, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...opts });
  const kv = { tupo_token: u.token, tupo_user: JSON.stringify(u.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: u.perms, name: 'Staff' }) };
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, kv);
  return { ctx, page: await ctx.newPage() };
}

let browser;
try {
  const ann = await makeUser('Ann Status');
  const bob = await makeUser('Bob Watcher');
  const dm = (await call(ann, 'POST', '/api/chat/conversations/direct', { userId: bob.id })).body.data.conversation.id;
  await call(ann, 'POST', `/api/chat/conversations/${dm}/messages`, { body: 'hello', nonce: nonce() });

  console.log('── Gateway: one status from every tab');
  const watch = await connect(bob);
  const tab1 = await connect(ann);
  const tab2 = await connect(ann);
  await sleep(600);
  await emitAck(tab1, 'presence:set', { status: 'away' });
  check('an idle tab beside one in use leaves the person online', (await seenAs(watch, ann.id)) !== 'away',
    `seen=${await seenAs(watch, ann.id, 0)} key=${await redis.get(`presence:${ann.id}`)}`);
  await emitAck(tab2, 'presence:set', { status: 'away' });
  check('every tab idle reads as away', (await seenAs(watch, ann.id)) === 'away');
  await emitAck(tab2, 'presence:set', { status: 'online' });
  check('back at one tab reads as online again', (await seenAs(watch, ann.id)) === 'online');

  const busy = await emitAck(tab1, 'presence:choose', { choice: 'busy' });
  check('picking busy is acknowledged with the resulting status', busy?.ok && busy.status === 'busy', JSON.stringify(busy));
  check('the watcher sees busy', (await seenAs(watch, ann.id)) === 'busy');
  check('the person\'s other tab learns the pick (presence:self)', tab2.self.some((p) => p.choice === 'busy'));
  const tab3 = await connect(ann);
  await sleep(700);
  check('a new device keeps the pick instead of resetting to online',
    (await seenAs(watch, ann.id, 0)) === 'busy' && tab3.self.at(-1)?.choice === 'busy', JSON.stringify(tab3.self.at(-1)));
  await emitAck(tab1, 'presence:set', { status: 'away' }); await emitAck(tab2, 'presence:set', { status: 'away' }); await emitAck(tab3, 'presence:set', { status: 'away' });
  check('busy holds while idle', (await seenAs(watch, ann.id)) === 'busy');
  await emitAck(tab1, 'presence:set', { status: 'online' });

  await emitAck(tab1, 'presence:choose', { choice: 'dnd' });
  check('do not disturb is shown as dnd', (await seenAs(watch, ann.id)) === 'dnd');
  await emitAck(tab1, 'presence:choose', { choice: 'invisible' });
  check('appear offline reads as offline to others', (await seenAs(watch, ann.id)) === 'offline');
  check('…but still counts as connected, so no phone push while at the desk',
    (await redis.get(`connected:${ann.id}`)) === '1');
  const q = await emitAck(watch, 'presence:query', { userIds: [ann.id] });
  check('a presence lookup also says offline', q?.presence?.[ann.id]?.status === 'offline', JSON.stringify(q?.presence?.[ann.id]));
  await emitAck(tab1, 'presence:choose', { choice: 'auto' });
  check('automatic hands back to activity', (await seenAs(watch, ann.id)) === 'online');

  console.log('── Gateway: in a meeting');
  const m = await call(ann, 'POST', '/api/meet/instant', { title: 'Presence probe', settings: { admissionPolicy: 'authenticated', lobbyEnabled: false } });
  const meetingId = (m.body?.data?.meeting ?? m.body?.data)?.id; meetings.push(meetingId);
  const j = await call(ann, 'POST', `/api/meet/${meetingId}/join`, {});
  const meetSock = await connect(ann, '/meet');
  await new Promise((r) => { meetSock.emit('meet:join', { meetingId, participantId: j.body?.data?.participantId }, () => r()); setTimeout(r, 4000); });
  check('joining a call shows "in a meeting"', (await seenAs(watch, ann.id, 1000)) === 'in-a-meeting');
  await emitAck(tab1, 'presence:choose', { choice: 'dnd' });
  check('do not disturb still wins over the meeting', (await seenAs(watch, ann.id)) === 'dnd');
  await emitAck(tab1, 'presence:choose', { choice: 'auto' });
  meetSock.emit('meet:leave');
  check('leaving the call returns to online', (await seenAs(watch, ann.id, 1000)) === 'online');
  meetSock.close();

  tab3.close(); tab2.close();
  await sleep(500);
  await emitAck(tab1, 'presence:set', { status: 'away' });
  check('the last tab idle reads as away', (await seenAs(watch, ann.id)) === 'away');
  tab1.close();
  check('all tabs closed reads as offline', (await seenAs(watch, ann.id, 1200)) === 'offline');
  check('closing every tab clears the connected flag', (await redis.get(`connected:${ann.id}`)) === null);
  watch.close();

  console.log('── Browser: theme');
  browser = prepareBrowser(await chromium.launch());
  {
    const { ctx, page } = await pageFor(browser, ann, { colorScheme: 'light' });
    await page.goto(`${BASE}/app/settings`, { waitUntil: 'networkidle' });
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'));
    check('settings page offers System / Light / Dark', await page.getByRole('radio', { name: 'System' }).isVisible()
      && await page.getByRole('radio', { name: 'Dark' }).isVisible());
    await page.getByRole('radio', { name: 'Dark' }).click();
    await page.reload({ waitUntil: 'networkidle' });
    check('a picked theme sticks across a reload', await isDark());
    await page.getByRole('radio', { name: 'System' }).click();
    check('System on a light device is light', !(await isDark()));
    await page.emulateMedia({ colorScheme: 'dark' });
    await sleep(300);
    check('System follows the device when it switches to dark', await isDark());
    await page.reload({ waitUntil: 'networkidle' });
    check('System is remembered, not frozen into the colour of the moment',
      (await page.evaluate(() => localStorage.getItem('tupo_theme'))) === 'system' && await isDark());
    await page.emulateMedia({ colorScheme: 'light' });
    await sleep(300);
    check('…and back to light when the device does', !(await isDark()));
    await page.screenshot({ path: `${OUT}/settings.png`, fullPage: true });
    await ctx.close();
  }

  console.log('── Browser: status picker, do not disturb, toasts');
  {
    const { ctx, page } = await pageFor(browser, ann);
    const watcher = await connect(bob);
    await page.goto(`${BASE}/app/feed`, { waitUntil: 'networkidle' });
    await sleep(800);
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('radio', { name: /Busy/ }).click();
    check('picking Busy in the account menu reaches others', (await seenAs(watcher, ann.id, 1200)) === 'busy');
    await page.getByRole('button', { name: 'Account menu' }).click();
    check('the account menu shows the pick as selected',
      (await page.getByRole('radio', { name: /Busy/ }).getAttribute('aria-checked')) === 'true');
    check('the account menu links to Settings', await page.getByRole('menuitem', { name: 'Settings' }).isVisible());
    await page.getByRole('radio', { name: /Do not disturb/ }).click();
    await sleep(800);

    const toasts = page.locator('[aria-live="polite"] > div');
    const bellBefore = await page.getByRole('button', { name: /Notifications/ }).first().getAttribute('aria-label');
    await call(bob, 'POST', `/api/chat/conversations/${dm}/messages`, { body: 'DND MESSAGE', nonce: nonce() });
    await sleep(1500);
    const dndToast = await toasts.filter({ hasText: 'DND MESSAGE' }).count();
    const bellAfter = await page.getByRole('button', { name: /Notifications/ }).first().getAttribute('aria-label');
    check('do not disturb: no pop-up for a new message', dndToast === 0, `toasts=${dndToast}`);
    check('…but the bell still collects it', bellAfter !== bellBefore, `${bellBefore} → ${bellAfter}`);

    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('radio', { name: /Automatic/ }).click();
    await sleep(800);
    await call(bob, 'POST', `/api/chat/conversations/${dm}/messages`, { body: 'HOVER ME PLEASE', nonce: nonce() });
    const toast = toasts.filter({ hasText: 'Bob Watcher' }).first();
    await toast.waitFor({ timeout: 5000 }).catch(() => {});
    const shown = await toast.isVisible().catch(() => false);
    check('automatic again: the message pops up', shown);
    if (shown) {
      await toast.hover();
      await sleep(6500);
      check('a hovered toast stays past its time', await toast.isVisible());
      await page.mouse.move(5, 500);
      await sleep(6000);
      check('…and goes once the pointer leaves', !(await toast.isVisible().catch(() => false)));
    }
    watcher.close();
    await ctx.close();
  }

  console.log('── Browser: settings page on a phone');
  {
    const { ctx, page } = await pageFor(browser, ann, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(`${BASE}/app/settings`, { waitUntil: 'networkidle' });
    await sleep(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('settings fits a phone (no sideways scroll)', overflow <= 1, `overflow=${overflow}px`);
    for (const h of ['Profile', 'Status', 'Appearance', 'Notifications', 'Sign out']) {
      check(`settings has a "${h}" section`, await page.getByRole('heading', { name: h, exact: true }).first().isVisible());
    }
    check('profile shows the person\'s name', await page.locator('main').getByText('Ann Status').first().isVisible());
    await page.screenshot({ path: `${OUT}/settings-phone.png`, fullPage: true });
    await ctx.close();
  }
} catch (e) {
  check('suite ran to completion', false, e?.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
  for (const s of sockets) s.close();
  await browser?.close();
  for (const id of meetings) if (id) await pool.query('DELETE FROM meetings WHERE id = $1', [id]).catch(() => {});
  await purgeUsers(pool, ids).catch(() => {});
  for (const id of ids) await redis.del(`presence:choice:${id}`, `presence:${id}`, `connected:${id}`).catch(() => {});
  await pool.end(); redis.disconnect();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:presence:settings: ${results.length - failed} passed, ${failed} failed · screenshots in ${OUT}`);
  process.exit(failed ? 1 : 0);
}
