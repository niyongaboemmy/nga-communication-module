#!/usr/bin/env node
/**
 * Access UX (F-07): /app lands on the first module the person can open, a
 * screen they cannot open says so in words (no permission keys), an
 * administrator's change to their role takes effect without a reload, and the
 * launcher lists every admin destination they hold.
 *
 *   npm run verify:access:ui      (needs `npm run dev`)
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
const results = []; const ids = []; const roles = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const wait = (loc, ms = 10000) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false);

async function makeUser(name, roleId, roleName) {
  const id = `vax-${randomBytes(5).toString('hex')}`;
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`, [id, name, `${id}@amashuri.com`, roleId]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [roleId])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' };
  return { id, user, perms, roleName, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
async function makeRole(keys) {
  const { rows } = await pool.query(`INSERT INTO roles (name, description, level, is_system) VALUES ($1, '', 'STAFF', false) RETURNING id`, [`Chat only ${randomBytes(2).toString('hex')}`]);
  await pool.query(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = ANY($2::text[])`, [rows[0].id, keys]);
  roles.push(rows[0].id);
  return rows[0].id;
}
const call = async (u, method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
async function pageFor(browser, u) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, {
    tupo_token: u.token, tupo_user: JSON.stringify(u.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: u.perms, name: u.roleName }) });
  return ctx.newPage();
}

let browser;
try {
  const chatOnly = await makeRole(['MESSAGE_READ', 'MESSAGE_SEND', 'CHANNEL_VIEW', 'DIRECTORY_VIEW', 'SETTINGS_MANAGE', 'NOTIFICATIONS_MANAGE']);
  const { rows: a } = await pool.query(`SELECT id FROM roles WHERE name = 'Admin'`);
  const admin = await makeUser('Access Admin', a[0].id, 'Admin');
  const limited = await makeUser('Chat Only', chatOnly, 'Chat only');
  browser = prepareBrowser(await chromium.launch());

  console.log('\nLanding and refusal');
  const page = await pageFor(browser, limited);
  await page.goto(`${BASE}/app`);
  check('/app lands on a module this person can open (not a refused feed)',
    await page.waitForURL(/\/app\/chat/, { timeout: 10000 }).then(() => true).catch(() => false), page.url().replace(BASE, ''));
  await page.goto(`${BASE}/app/admin/users`);
  check('a screen they cannot open says so in words', await wait(page.getByRole('heading', { name: /isn’t open to you/ })));
  check('without raw permission keys', !(await page.getByText(/USERS_VIEW|USERS_MANAGE/).isVisible().catch(() => false)));
  check('with a way home', await page.getByRole('link', { name: /Tupo home/ }).isVisible());

  console.log('\nLive permission change');
  await page.goto(`${BASE}/app/chat`);
  await page.locator('#composer, [aria-label="Messages"], nav').first().waitFor({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const feedLink = () => page.evaluate(() => [...document.querySelectorAll('a[href="/app/feed"]')].some((x) => x.offsetParent !== null));
  check('the Feed module is hidden to start with', !(await feedLink()));
  const { rows: staff } = await pool.query(`SELECT id FROM roles WHERE name = 'Staff'`);
  const r = await call(admin, 'PUT', `/api/users/${limited.id}/role`, { roleId: staff[0].id });
  check('an administrator gives them the Staff role', r.status === 200, String(r.status));
  const appeared = await page.waitForFunction(() => [...document.querySelectorAll('a[href="/app/feed"]')].some((x) => x.offsetParent !== null), undefined, { timeout: 10000 }).then(() => true).catch(() => false);
  check('Feed appears in their open tab without a reload', appeared);

  console.log('\nLauncher');
  const ap = await pageFor(browser, admin);
  await ap.goto(`${BASE}/app/chat`);
  await ap.getByRole('button', { name: /Search people, channels and messages/ }).first().click();
  const dest = await ap.locator('[aria-label="Destinations"] [role="option"]').allInnerTexts();
  check('the launcher lists Dashboard and Oversight for an administrator',
    dest.some((t) => /Dashboard/.test(t)) && dest.some((t) => /Oversight/.test(t)), `${dest.length} destinations`);
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  for (const id of roles) { await pool.query('DELETE FROM role_permissions WHERE role_id = $1', [id]).catch(() => {}); await pool.query('DELETE FROM roles WHERE id = $1', [id]).catch(() => {}); }
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:access:ui: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
