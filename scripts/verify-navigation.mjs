#!/usr/bin/env node
/**
 * URL-driven navigation (F-05): a real 404 inside and outside the shell, a
 * campaign link that lands on its campaign, and chat panels that live in the
 * URL (open from a link, survive a reload, close with Back).
 *
 *   npm run verify:navigation      (needs `npm run dev`)
 */
import { chromium } from 'playwright';
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
const API = 'http://localhost:5190', BASE = 'http://localhost:5194';
const results = []; const ids = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const wait = (loc, ms = 8000) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false);

async function makeUser(name, roleName) {
  const id = `vnv-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = $1`, [roleName]);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`, [id, name, `${id}@amashuri.com`, roleName.toLowerCase(), rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: roleName.toLowerCase() };
  return { id, user, perms, roleName, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
const call = async (u, method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
async function pageFor(browser, u) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  if (u) await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, {
    tupo_token: u.token, tupo_user: JSON.stringify(u.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: u.perms, name: u.roleName }) });
  return ctx.newPage();
}

let browser;
try {
  const admin = await makeUser('Nav Admin', 'Admin');
  browser = prepareBrowser(await chromium.launch());
  const page = await pageFor(browser, admin);

  console.log('\nNot found');
  await page.goto(`${BASE}/app/no-such-screen`);
  check('an unknown address inside the app shows a real 404, in the shell', await wait(page.getByRole('heading', { name: /This page isn’t here/ })) && await page.getByRole('button', { name: /^Notifications/ }).isVisible());
  await page.getByRole('link', { name: /Tupo home/ }).click();
  check('with a way home', await page.waitForURL(/\/app\/feed/, { timeout: 8000 }).then(() => true).catch(() => false), page.url().replace(BASE, ''));
  await page.goto(`${BASE}/totally/unknown`);
  check('an unknown address outside the app shows the 404 to a signed-in person', await wait(page.getByRole('heading', { name: /This page isn’t here/ })));
  const anon = await pageFor(browser, null);
  await anon.goto(`${BASE}/totally/unknown`);
  check('and sends a signed-out visitor to sign in', await anon.waitForURL((u) => new URL(u).pathname === '/', { timeout: 8000 }).then(() => true).catch(() => false), anon.url().replace(BASE, ''));

  console.log('\nCampaign links');
  const camp = (await call(admin, 'POST', '/api/mail/campaigns', { subject: `Nav campaign ${randomBytes(2).toString('hex')}`, bodyHtml: '<p>x</p>', listIds: [], extraRecipients: [{ address: 'someone@outside.example' }] })).body?.data?.campaign;
  await page.goto(`${BASE}/app/mail/campaigns/${camp.id}`);
  check('a campaign link opens campaigns with that one highlighted', await wait(page.locator(`#campaign-${camp.id}[aria-current="true"]`)));

  console.log('\nChat panels in the URL');
  await page.goto(`${BASE}/app/chat?panel=threads`);
  check('a link can open a chat panel', await wait(page.getByRole('complementary', { name: /Threads/ }).or(page.getByRole('heading', { name: 'Threads' })).first(), 12000));
  await page.reload();
  check('which survives a reload', await wait(page.getByRole('complementary', { name: /Threads/ }).or(page.getByRole('heading', { name: 'Threads' })).first(), 12000));
  await page.keyboard.press('ControlOrMeta+f');
  const searchOpen = await page.waitForURL(/panel=search/, { timeout: 6000 }).then(() => true).catch(() => false);
  check('opening a panel writes it into the URL', searchOpen, page.url().replace(BASE, ''));
  await page.keyboard.press('Escape');
  const closed = await page.waitForURL((u) => !new URL(u).searchParams.get('panel'), { timeout: 6000 }).then(() => true).catch(() => false);
  check('closing it takes it out again', closed, page.url().replace(BASE, ''));
  await pool.query('DELETE FROM mail_campaigns WHERE id = $1', [camp.id]).catch(() => {});
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:navigation: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
