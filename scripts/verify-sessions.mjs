#!/usr/bin/env node
/**
 * One session across tabs (F-08): signing out in one tab signs out the
 * others, a different person signing in elsewhere restarts this tab as them,
 * the sign-in code leaves the address bar at once, and replacing someone
 * else's session asks first.
 *
 *   npm run verify:sessions      (needs `npm run dev`)
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

async function makeUser(name) {
  const id = `vss-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = 'Staff'`);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`, [id, name, `${id}@amashuri.com`, rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' };
  return { id, name, user, perms, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
const seed = (u) => ({ tupo_token: u.token, tupo_user: JSON.stringify(u.user), tupo_permissions: '[]',
  tupo_role_permissions: JSON.stringify({ keys: u.perms, name: 'Staff' }) });

let browser;
try {
  const ann = await makeUser('Ann Session');
  const bob = await makeUser('Bob Session');
  browser = prepareBrowser(await chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  // Seed once (not on every navigation), like a real signed-in browser.
  const first = await ctx.newPage();
  await first.goto(`${BASE}/favicon.svg`);   // same origin, no app code that navigates
  await first.evaluate((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, seed(ann));
  await first.goto(`${BASE}/app/chat`);
  const second = await ctx.newPage();
  await second.goto(`${BASE}/app/feed`);
  await first.getByText('Ann Session').first().waitFor({ timeout: 15000 });
  await second.getByText('Ann Session').first().waitFor({ timeout: 15000 });

  console.log('\nA different person signs in elsewhere');
  await first.evaluate((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, seed(bob));
  const switched = await second.getByText('Bob Session').first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
  await second.waitForTimeout(800);
  const stillAnn = await second.getByText('Ann Session').first().isVisible().catch(() => false);
  check('the other tab restarts as them, never mixing two people', switched && !stillAnn, `bob=${switched} ann=${stillAnn}`);

  console.log('\nSigning out in one tab');
  await first.reload();
  await first.getByText('Bob Session').first().click();
  await first.getByRole('menuitem', { name: /Sign out/ }).click();
  const out = await second.waitForURL((u) => new URL(u).pathname === '/', { timeout: 8000 }).then(() => true).catch(() => false);
  check('signs out the other tab too', out, second.url().replace(BASE, ''));

  console.log('\nThe sign-in callback');
  // Its own browser profile: the sign-out above finishes asynchronously.
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const cb = await ctx2.newPage();
  await cb.goto(`${BASE}/favicon.svg`);   // same origin, no app code that navigates
  await cb.evaluate((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, seed(ann));
  await cb.route('**/api/sso/exchange', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ success: true, data: { token: bob.token, user: bob.user, permissions: [], rolePermissions: bob.perms, roleName: 'Staff' } }) }));
  await cb.goto(`${BASE}/sso/callback?code=single-use-code&state=abc`);
  await cb.getByText('Switch account?').waitFor({ timeout: 8000 }).catch(() => {});
  check('the code leaves the address bar at once', !cb.url().includes('code='), cb.url().replace(BASE, ''));
  check('replacing someone else’s session asks first', await cb.getByText('Switch account?').isVisible().catch(() => false));
  await cb.getByRole('button', { name: /Stay as Ann Session/ }).click();
  await cb.waitForURL(/\/app/, { timeout: 8000 }).catch(() => {});
  check('"Stay" keeps the current person', (await cb.evaluate(() => JSON.parse(localStorage.getItem('tupo_user') ?? '{}').name)) === 'Ann Session');
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:sessions: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
