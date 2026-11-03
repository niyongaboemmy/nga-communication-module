#!/usr/bin/env node
/**
 * Monitoring works end to end (R-03, R-04, R-05), against the running stack:
 *
 *   - a crash in a real browser reaches System › Errors, grouped;
 *   - every service writes its per-minute numbers, and the worker writes the
 *     host's (memory, disk, partitions) — waits up to ~2.5 minutes for them;
 *   - the System page shows alerts, the last-hour cards and the errors.
 *
 *   npm run verify:monitoring      (needs `npm run dev`)
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
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = randomBytes(3).toString('hex');

async function makeUser(name, roleName) {
  const id = `vmo-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = $1`, [roleName]);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`, [id, name, `${id}@amashuri.com`, roleName.toLowerCase(), rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: roleName.toLowerCase() };
  return { id, user, perms, roleName, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
const get = async (u, path) => (await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${u.token}` } })).json();

let browser;
try {
  const admin = await makeUser(`Mona Monitor ${tag}`, 'Admin');
  browser = prepareBrowser(await chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, {
    tupo_token: admin.token, tupo_user: JSON.stringify(admin.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: admin.perms, name: admin.roleName }) });
  const page = await ctx.newPage();

  console.log('\nBrowser errors');
  await page.goto(`${BASE}/app/chat`);
  await page.waitForLoadState('networkidle').catch(() => {});
  const crash = `verify-monitoring crash ${tag}`;
  await page.evaluate((m) => { setTimeout(() => { throw new Error(m); }, 0); }, crash);
  await page.evaluate((m) => { void Promise.reject(new Error(`${m} (promise)`)); }, crash);
  let found = [];
  for (let i = 0; i < 20 && found.length < 2; i++) {
    await sleep(500);
    found = (await pool.query(`SELECT message, source, route FROM error_events WHERE message LIKE $1`, [`%${crash}%`])).rows;
  }
  check('an uncaught browser error is recorded', found.some((r) => r.message === crash && r.source === 'web'), found.map((r) => r.route).join(', '));
  check('so is an unhandled promise rejection', found.some((r) => r.message === `${crash} (promise)`));
  const listed = (await get(admin, '/api/system/errors')).data?.errors ?? [];
  check('both are listed for the System page', listed.filter((e) => e.message.includes(crash)).length === 2);

  console.log('\nMetrics (waiting for the per-minute writes)');
  const want = { api: 'http_requests', realtime: 'sockets', files: 'rss_mb', worker: 'queue_waiting', system: 'host_free_mem_mb' };
  let seen = {};
  for (let i = 0; i < 30; i++) {
    const { rows } = await pool.query(
      `SELECT DISTINCT CASE WHEN service LIKE 'api#%' THEN 'api' ELSE service END AS s, metric
         FROM metric_samples WHERE at > now() - interval '3 minutes'`);
    seen = Object.fromEntries(Object.entries(want).map(([s, m]) => [s, rows.some((r) => r.s === s && r.metric === m)]));
    if (Object.values(seen).every(Boolean)) break;
    await sleep(5_000);
  }
  for (const [s, m] of Object.entries(want)) check(`${s} writes ${m}`, seen[s]);
  const parts = (await pool.query(`SELECT value FROM metric_samples WHERE metric = 'partitions_ahead_months' ORDER BY at DESC LIMIT 1`)).rows[0];
  check('the worker reports partitions in hand', parts && Number(parts.value) >= 2, parts ? `${parts.value} months` : 'none');
  const alerts = (await get(admin, '/api/system/alerts')).data?.alerts ?? [];
  check('the alert rules have been evaluated', alerts.length > 0, `${alerts.length} rules, firing: ${alerts.filter((a) => a.firing).map((a) => a.rule).join(', ') || 'none'}`);

  console.log('\nSystem page');
  await page.goto(`${BASE}/app/system`);
  check('shows the alerts section', await page.getByRole('heading', { name: 'Alerts' }).waitFor({ timeout: 10_000 }).then(() => true).catch(() => false));
  const requestsCard = page.locator('[data-metric="api.http_requests"]');
  await requestsCard.waitFor({ timeout: 10_000 }).catch(() => {});
  check('shows the last-hour cards with a value', /\d/.test(await requestsCard.innerText().catch(() => '')), (await requestsCard.innerText().catch(() => '')).replace(/\n/g, ' '));
  check('lists the browser crash', await page.getByText(crash, { exact: true }).first().waitFor({ timeout: 10_000 }).then(() => true).catch(() => false));
  await page.getByText(crash, { exact: true }).first().click();
  await page.getByRole('button', { name: 'Mark resolved' }).first().click();
  await sleep(800);
  const status = (await pool.query(`SELECT status FROM error_events WHERE message = $1`, [crash])).rows[0]?.status;
  check('an error can be marked resolved from the page', status === 'resolved', status);
  await pool.query(`DELETE FROM error_events WHERE message LIKE $1`, [`%${crash}%`]);
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:monitoring: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
