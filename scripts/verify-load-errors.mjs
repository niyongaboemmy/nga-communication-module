#!/usr/bin/env node
/**
 * Failed loads say so (F-06): with the request made to fail, each screen shows
 * "Couldn't load …" with a retry — never its empty state — and the retry works
 * once the request succeeds again.
 *
 *   npm run verify:errors      (needs `npm run dev`)
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
const BASE = 'http://localhost:5194';
const results = []; const ids = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const wait = (loc, ms = 10000) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false);

async function makeUser(name, roleName) {
  const id = `vle-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = $1`, [roleName]);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`, [id, name, `${id}@amashuri.com`, roleName.toLowerCase(), rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: roleName.toLowerCase() };
  return { user, perms, roleName, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}

/** Make requests matching `pattern` fail until `heal()` is called. */
async function breakRoute(page, pattern) {
  let broken = true;
  await page.route(pattern, (route) => (broken
    ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"message":"boom"}' })
    : route.fallback()));
  return () => { broken = false; };
}

let browser;
try {
  const admin = await makeUser('Errors Admin', 'Admin');
  browser = prepareBrowser(await chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, {
    tupo_token: admin.token, tupo_user: JSON.stringify(admin.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: admin.perms, name: 'Admin' }) });
  const page = await ctx.newPage();

  for (const [name, path, pattern, what, empty] of [
    ['the audit log', '/app/admin/audit', '**/api/audit?**', 'the audit log', 'No audit entries yet'],
    ['the users screen', '/app/admin/users', '**/api/users?**', 'users', 'No users yet'],
    ['a mail folder', '/app/mail', '**/api/mail/threads?**', 'this folder', 'Nothing here'],
    ['the conversation list', '/app/chat', '**/api/chat/conversations', 'your conversations', 'No conversations yet'],
  ]) {
    const heal = await breakRoute(page, pattern);
    await page.goto(`${BASE}${path}`);
    const shown = await wait(page.getByText(`Couldn’t load ${what}`));
    const lying = await page.getByText(empty, { exact: false }).first().isVisible().catch(() => false);
    check(`${name}: a failed load says so, not "${empty}"`, shown && !lying, `error=${shown} empty=${lying}`);
    heal();
    await page.getByRole('button', { name: 'Try again' }).first().click();
    const gone = await page.getByText(`Couldn’t load ${what}`).waitFor({ state: 'hidden', timeout: 8000 }).then(() => true).catch(() => false);
    check(`${name}: and "Try again" recovers`, gone);
    await page.unroute(pattern);
  }

  // Global search: a failed search is an error, not "Nothing matches".
  const healSearch = await breakRoute(page, '**/api/search?**');
  await page.goto(`${BASE}/app/feed`);
  await page.getByRole('button', { name: /Search people, channels and messages/ }).first().click();
  await page.keyboard.type('timetable');
  check('search: a failed search says so, not "Nothing matches"',
    await wait(page.getByText('Couldn’t load results')) && !(await page.getByText(/Nothing matches/).isVisible().catch(() => false)));
  healSearch();
  await page.getByRole('button', { name: 'Try again' }).click();
  check('search: and retry runs it again', await page.getByText('Couldn’t load results').waitFor({ state: 'hidden', timeout: 8000 }).then(() => true).catch(() => false));
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:errors: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
