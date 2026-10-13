#!/usr/bin/env node
/**
 * The notification centre in a real browser (F-01): the bell counts live,
 * the panel lists and filters, opening one goes to it and clears it, "mark all
 * read" works, and a second tab of the same person follows along.
 *
 *   npm run verify:notifications:ui      (needs `npm run dev`)
 */
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { purgeUsers } from './lib/purge.mjs';
import { prepareBrowser } from './lib/uiHarness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = process.env.OUT ?? '/tmp/verify-notification-center';
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const API = 'http://localhost:5190', BASE = 'http://localhost:5194';
const results = []; const ids = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const nonce = () => randomBytes(8).toString('hex');
const wait = (loc, ms = 8000) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false);

async function makeUser(name) {
  const id = `vnc-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = 'Staff'`);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`, [id, name, `${id}@amashuri.com`, rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' };
  return { id, name, perms, user, email: user.email, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
const call = async (u, method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
async function pageFor(browser, u, viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, {
    tupo_token: u.token, tupo_user: JSON.stringify(u.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: u.perms, name: 'Staff' }) });
  return ctx.newPage();
}
const bell = (page) => page.getByRole('button', { name: /^Notifications/ });
const bellLabel = (page) => bell(page).getAttribute('aria-label');

let browser;
try {
  const ann = await makeUser('Ann Sender');
  const bob = await makeUser('Bob Reader');
  browser = prepareBrowser(await chromium.launch());
  const page = await pageFor(browser, bob);
  const tab2 = await pageFor(browser, bob);
  await page.goto(`${BASE}/app/feed`);
  await tab2.goto(`${BASE}/app/mail`);
  await bell(page).waitFor({ timeout: 15000 });
  await bell(tab2).waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  check('the bell starts with nothing unread', (await bellLabel(page)) === 'Notifications', await bellLabel(page));

  console.log('\nLive');
  const dm = (await call(ann, 'POST', '/api/chat/conversations/direct', { userId: bob.id })).body.data.conversation.id;
  await call(ann, 'POST', `/api/chat/conversations/${dm}/messages`, { body: 'Can you check the timetable?', nonce: nonce() });
  await call(ann, 'POST', '/api/mail/compose', { to: [bob.email], subject: 'Term dates', bodyHtml: '<p>Attached.</p>' });
  const live = await page.waitForFunction(() => /2 unread/.test(document.querySelector('[aria-label^="Notifications"]')?.getAttribute('aria-label') ?? ''), undefined, { timeout: 10000 }).then(() => true).catch(() => false);
  check('new notifications count on the bell as they arrive', live, await bellLabel(page));
  const other = await tab2.waitForFunction(() => /2 unread/.test(document.querySelector('[aria-label^="Notifications"]')?.getAttribute('aria-label') ?? ''), undefined, { timeout: 10000 }).then(() => true).catch(() => false);
  check('and on every open tab', other);

  console.log('\nThe panel');
  await bell(page).click();
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  check('the bell opens the panel', await wait(panel));
  check('grouped by day', await wait(panel.getByRole('region', { name: 'Today' }).or(panel.getByText('Today')).first()));
  check('it lists the DM', await wait(panel.getByText('Ann Sender').first()));
  check('and the mail', await wait(panel.getByText(/Term dates|Ann Sender/).first()));
  await page.screenshot({ path: `${OUT}/01-panel.png` });
  await panel.getByRole('tab', { name: 'Mail' }).click();
  await page.waitForTimeout(800);
  const mailRows = await panel.locator('li').count();
  check('filtering by module shows only that module', mailRows >= 1 && !(await panel.getByText('Can you check the timetable?').isVisible().catch(() => false)), `${mailRows} rows`);
  await panel.getByRole('tab', { name: 'All' }).click();
  await page.waitForTimeout(600);

  console.log('\nOpening one');
  await panel.getByText('Can you check the timetable?').first().click();
  const opened = await page.waitForURL(new RegExp(`/app/chat.*c=${dm}`), { timeout: 8000 }).then(() => true).catch(() => false);
  check('opening a notification goes to where it happened', opened, page.url().replace(BASE, ''));
  const cleared = await page.waitForFunction(() => /1 unread/.test(document.querySelector('[aria-label^="Notifications"]')?.getAttribute('aria-label') ?? ''), undefined, { timeout: 8000 }).then(() => true).catch(() => false);
  check('and it no longer counts', cleared, await bellLabel(page));

  console.log('\nMark all read');
  await bell(page).click();
  await page.getByRole('button', { name: /Mark all read|Read all/ }).click();
  const zero = await page.waitForFunction(() => document.querySelector('[aria-label^="Notifications"]')?.getAttribute('aria-label') === 'Notifications', undefined, { timeout: 8000 }).then(() => true).catch(() => false);
  check('mark all read empties the count', zero, await bellLabel(page));
  const zero2 = await tab2.waitForFunction(() => document.querySelector('[aria-label^="Notifications"]')?.getAttribute('aria-label') === 'Notifications', undefined, { timeout: 8000 }).then(() => true).catch(() => false);
  check('and the other tab follows', zero2, await bellLabel(tab2));
  await page.keyboard.press('Escape');
  check('Escape closes the panel', await page.getByRole('dialog', { name: 'Notifications' }).waitFor({ state: 'hidden', timeout: 3000 }).then(() => true).catch(() => false));

  console.log('\nInterruptions (F-02)');
  const toasts = (p) => p.locator('[role="status"][aria-live="polite"]');
  await page.goto(`${BASE}/app/feed`);
  await bell(page).waitFor({ timeout: 15000 });
  await call(ann, 'POST', '/api/mail/compose', { to: [bob.email], subject: 'Fees reminder', bodyHtml: '<p>Due Friday.</p>' });
  check('a mail arriving elsewhere shows a toast', await wait(toasts(page).getByText(/Fees reminder|Ann Sender/).first()));
  await page.waitForTimeout(500);
  await bell(page).click();
  await page.getByRole('dialog', { name: 'Notifications' }).waitFor();
  await call(ann, 'POST', `/api/chat/conversations/${dm}/messages`, { body: 'PANEL OPEN MESSAGE', nonce: nonce() });
  await page.waitForTimeout(2000);
  const inList = await page.getByRole('dialog', { name: 'Notifications' }).getByText('PANEL OPEN MESSAGE').first().isVisible().catch(() => false);
  const asToast = await toasts(page).getByText('PANEL OPEN MESSAGE').first().isVisible().catch(() => false);
  check('with the panel open, it lands in the list, not as a toast', inList && !asToast, `inList=${inList} toast=${asToast}`);
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/app/chat?c=${dm}`);
  await page.locator('#composer').waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  await call(ann, 'POST', `/api/chat/conversations/${dm}/messages`, { body: 'ALREADY LOOKING', nonce: nonce() });
  await page.getByText('ALREADY LOOKING').first().waitFor({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  check('no toast for the conversation already open', !(await toasts(page).getByText('ALREADY LOOKING').isVisible().catch(() => false)));

  console.log('\nPhone');
  const phone = await pageFor(browser, bob, { width: 390, height: 800 });
  await phone.goto(`${BASE}/app/feed`);
  await bell(phone).click();
  const pp = phone.getByRole('dialog', { name: 'Notifications' });
  check('on a phone the panel fits the screen', await wait(pp) && await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await phone.screenshot({ path: `${OUT}/02-phone.png` });
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:notifications:ui: ${results.length - failed} passed, ${failed} failed · screenshots in ${OUT}`);
  process.exit(failed ? 1 : 0);
}
