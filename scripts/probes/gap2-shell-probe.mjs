#!/usr/bin/env node
/**
 * Gap-analysis pass 2 (temporary): app shell, global search, route guards,
 * admin pages, PWA. Needs `npm run dev`. OUT=<dir> for screenshots + results.
 */
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { purgeUsers } from '../lib/purge.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const OUT = process.env.OUT ?? '/tmp/gap2-shell';
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const API = 'http://localhost:5190';
const BASE = 'http://localhost:5194';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? 'PASS' : 'FAIL'} ${n}${d ? `  — ${d}` : ''}`); };
const ids = [];
let tempRoleId = null;

async function makeUser(name, roleName, roleIdOverride) {
  const id = `gapu-${randomBytes(5).toString('hex')}`;
  const roleId = roleIdOverride ?? (await pool.query(`SELECT id FROM roles WHERE name = $1`, [roleName])).rows[0].id;
  const role = (roleName || 'staff').toLowerCase();
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, role === 'admin' ? 'admin' : 'staff', roleId]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [roleId])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: role === 'admin' ? 'admin' : 'staff' };
  return { id, name, perms, roleName, user, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
const call = async (u, method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
async function ctxFor(browser, u, viewport = { width: 1280, height: 860 }, { dismissInstall = true } = {}) {
  const ctx = await browser.newContext({ viewport });
  const kv = u ? { tupo_token: u.token, tupo_user: JSON.stringify(u.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: u.perms, name: u.roleName }) } : {};
  if (dismissInstall) kv['nga.appInstalled'] = '1';
  await ctx.addInitScript(({ kv, dismissInstall }) => {
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
    if (dismissInstall) sessionStorage.setItem('nga.installDismissedThisSession', '1');
  }, { kv, dismissInstall });
  await ctx.route('**/api/sso/verify-mis**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":{"valid":true}}' }));
  return ctx;
}
const visible = (page, text, timeout = 6000) => page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
const settle = async (p, ms = 1200) => { await p.waitForLoadState('networkidle').catch(() => {}); await sleep(ms); };
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
async function section(name, fn) {
  if (ONLY && !ONLY.some((o) => name.toLowerCase().includes(o.toLowerCase()))) return;
  console.log(`\n── ${name}`);
  try { await fn(); } catch (e) { check(`${name}: section crashed`, false, String(e).slice(0, 200)); }
}

let browser;
try {
  const A = await makeUser('Aria Gaptwo', 'Staff');
  const B = await makeUser('Bosco Gaptwo', 'Staff');
  const ADM = await makeUser('Admin Gaptwo', 'Admin');
  const STU = await makeUser('Stu Gaptwo', 'Student');
  browser = await chromium.launch();

  await section('Global search → chat deep links', async () => {
    const dm = await call(A, 'POST', '/api/chat/conversations/direct', { userId: B.id });
    const convId = dm.body?.data?.conversation?.id;
    const term = `zebra${randomBytes(3).toString('hex')}`;
    await call(B, 'POST', `/api/chat/conversations/${convId}/messages`, { body: `needle ${term} here`, nonce: randomBytes(8).toString('hex') });
    // A second conversation so the app has something else to show by default.
    const ctx = await ctxFor(browser, A);
    const p = await ctx.newPage();
    await p.goto(`${BASE}/app/feed`, { waitUntil: 'domcontentloaded' }); await settle(p);
    await p.keyboard.press('Control+k');
    await p.locator('input[aria-label="Search Tupo"]').fill(term);
    await sleep(1500);
    await p.screenshot({ path: `${OUT}/search-results.png` });
    const hit = p.locator('[role="option"] button').first();
    const hasHit = await hit.isVisible().catch(() => false);
    check('palette returns the message hit', hasHit);
    if (hasHit) {
      await hit.click(); await settle(p, 2000);
      const url = p.url();
      check('message result navigates to /app/chat?c=&m=', /\/app\/chat\?c=/.test(url), url);
      const threadOpen = await p.getByText(`needle ${term}`).first().isVisible().catch(() => false);
      check('the matching conversation/message is opened after clicking the result', threadOpen);
      await p.screenshot({ path: `${OUT}/search-after-click.png` });
    }
    // People result → ?dm=
    await p.goto(`${BASE}/app/feed`, { waitUntil: 'domcontentloaded' }); await settle(p);
    await p.keyboard.press('Control+k');
    await p.locator('input[aria-label="Search Tupo"]').fill('Bosco Gaptwo');
    await sleep(1500);
    const person = p.locator('[role="listbox"][aria-label="People"] button').first();
    if (await person.isVisible().catch(() => false)) {
      await person.click(); await settle(p, 2000);
      const url = p.url();
      const opened = await p.locator('main').getByText('Bosco Gaptwo').count();
      check('person result opens a DM with that person', /dm=/.test(url) && opened > 0, `${url} matches=${opened}`);
      await p.screenshot({ path: `${OUT}/search-person-click.png` });
    } else check('palette returns the person hit', false);

    // Search failure presented as "no matches"
    await p.route('**/api/search**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"message":"boom"}' }));
    await p.keyboard.press('Control+k');
    await p.locator('input[aria-label="Search Tupo"]').fill('anything');
    await sleep(1200);
    const lies = await p.getByText(/Nothing matches/).first().isVisible().catch(() => false);
    check('a failed search is shown as an error, not "Nothing matches"', !lies, lies ? 'shows "Nothing matches"' : '');
    await p.screenshot({ path: `${OUT}/search-500.png` });
    await p.unroute('**/api/search**');
    // Launcher completeness for an admin is checked below.
    await ctx.close();
  });

  await section('Route guards & landing', async () => {
    const ctx = await ctxFor(browser, STU);
    const p = await ctx.newPage();
    await p.goto(`${BASE}/app/admin/users`, { waitUntil: 'domcontentloaded' }); await settle(p);
    const denied = await visible(p, 'open to you', 3000);
    const leaks = await p.getByText(/USERS_VIEW/).first().isVisible().catch(() => false);
    check('student deep-linking /app/admin/users sees an access-denied page', denied);
    check('access-denied page does not expose raw permission keys', !leaks, leaks ? 'shows "Requires one of: USERS_VIEW, USERS_MANAGE"' : '');
    await p.screenshot({ path: `${OUT}/guard-student-admin.png` });
    await p.goto(`${BASE}/app/does-not-exist`, { waitUntil: 'domcontentloaded' }); await settle(p);
    check('unknown /app/* route shows a 404 rather than silently redirecting', !/\/app\/feed$/.test(p.url()), p.url());
    await ctx.close();

    // A role without FEED_VIEW (e.g. chat-only) still lands on /app/feed.
    const { rows } = await pool.query(`INSERT INTO roles (name, level, description, is_system) VALUES ($1,'STAFF','gap2 temp',false) RETURNING id`, [`gap2-chat-only-${randomBytes(3).toString('hex')}`]);
    tempRoleId = rows[0].id;
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key IN ('MESSAGE_READ','MESSAGE_SEND')`, [tempRoleId]);
    const CH = await makeUser('Chatonly Gaptwo', null, tempRoleId);
    const c2 = await ctxFor(browser, CH);
    const p2 = await c2.newPage();
    await p2.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' }); await settle(p2);
    const deniedHome = await visible(p2, 'You do not have access', 3000);
    check('a user without FEED_VIEW lands on a page they can use after sign-in', !deniedHome, `${p2.url()} ${deniedHome ? '(access denied)' : ''}`);
    await p2.screenshot({ path: `${OUT}/landing-no-feed.png` });
    await c2.close();
  });

  await section('Suspended account UX', async () => {
    const SUS = await makeUser('Suspended Gaptwo', 'Staff');
    await pool.query(`UPDATE users SET status='suspended' WHERE id=$1`, [SUS.id]);
    const ctx = await ctxFor(browser, SUS);
    const p = await ctx.newPage();
    await p.goto(`${BASE}/app/chat`, { waitUntil: 'domcontentloaded' }); await settle(p, 2500);
    const shellShown = await p.getByRole('navigation', { name: 'Modules' }).first().isVisible().catch(() => false);
    const explained = await p.getByText(/suspended/i).first().isVisible().catch(() => false);
    check('suspended user sees a clear "account suspended" screen (not the app shell)', !shellShown && explained, `shell=${shellShown} suspendedText=${explained} url=${p.url()}`);
    await p.screenshot({ path: `${OUT}/suspended.png` });
    await ctx.close();
  });

  await section('Cross-tab sign-out', async () => {
    const ctx = await ctxFor(browser, A);
    const p1 = await ctx.newPage();
    await p1.goto(`${BASE}/app/chat`, { waitUntil: 'domcontentloaded' }); await settle(p1);
    const p2 = await ctx.newPage();
    await p2.goto(`${BASE}/app/meet`, { waitUntil: 'domcontentloaded' }); await settle(p2);
    await p1.getByLabel('Account menu').click();
    await p1.getByRole('menuitem', { name: /Sign out/ }).click();
    await sleep(3000);
    const stillIn = await p2.getByLabel('Account menu').isVisible().catch(() => false);
    check('signing out in one tab signs the other tab out', !stillIn, stillIn ? 'second tab still shows the signed-in shell after 3 s' : '');
    await p2.screenshot({ path: `${OUT}/crosstab-signout.png` });
    await ctx.close();
  });

  await section('Admin users table', async () => {
    // Push the roster past the API's silent 50-row cap.
    const extra = [];
    for (let i = 0; i < 8; i++) extra.push(await makeUser(`Zz Filler ${i} Gaptwo`, 'Student'));
    const total = Number((await pool.query('SELECT count(*) FROM users')).rows[0].count);
    const ctx = await ctxFor(browser, ADM);
    const p = await ctx.newPage();
    await p.goto(`${BASE}/app/admin/users`, { waitUntil: 'domcontentloaded' }); await settle(p, 2000);
    const rowsShown = await p.locator('tbody tr').count();
    const pager = await p.getByText(/next|load more|showing|of \d+/i).first().isVisible().catch(() => false);
    check('Users table shows every user or offers paging', rowsShown >= total || pager, `rows=${rowsShown} usersInDb=${total} pager=${pager}`);
    const zzVisible = await p.getByText('Zz Filler 7 Gaptwo').first().isVisible().catch(() => false);
    check('a user sorted past row 50 is reachable without searching', zzVisible || pager);
    // Role change has no confirmation
    const dialogs = [];
    p.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    const row = p.locator('tr', { hasText: 'Stu Gaptwo' }).first();
    const sel = row.locator('select');
    if (await sel.count()) {
      await sel.selectOption({ label: 'Admin' });
      await sleep(1500);
      // The confirmation is an in-app dialog (F-11), not window.confirm.
      const inApp = await p.getByRole('alertdialog').isVisible().catch(() => false);
      if (inApp) { await p.keyboard.press('Escape'); await sleep(300); }
      const now = (await pool.query('SELECT r.name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1', [STU.id])).rows[0]?.name;
      check('promoting a student to Admin asks for confirmation first', (dialogs.length > 0 || inApp) && now !== 'Admin', `dialogs=${dialogs.length} inApp=${inApp} roleNow=${now}`);
      await pool.query(`UPDATE users SET role_id=(SELECT id FROM roles WHERE name='Student'), role='student', role_assigned_by_admin=false, academic_level=NULL WHERE id=$1`, [STU.id]);
    }
    // Search miss wording
    await p.getByPlaceholder('Search by name or email').fill('qqqnomatchqqq');
    await p.getByRole('button', { name: 'Search', exact: true }).last().click();
    await settle(p, 800);
    const wrong = await p.getByText('No users yet').first().isVisible().catch(() => false);
    check('a search with no match says "no match" rather than "No users yet"', !wrong);
    await p.screenshot({ path: `${OUT}/users-nomatch.png` });
    await ctx.close();
  });

  await section('Roles editor', async () => {
    const ctx = await ctxFor(browser, ADM);
    const p = await ctx.newPage();
    const dialogs = [];
    p.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await p.goto(`${BASE}/app/admin/roles`, { waitUntil: 'domcontentloaded' }); await settle(p);
    await p.getByRole('button', { name: /Parent/ }).first().click(); await sleep(400);
    const first = p.locator('input[type="checkbox"]').first();
    await first.click(); await sleep(200);
    const dirtyLabel = await p.getByRole('button', { name: /Save \(/ }).isVisible().catch(() => false);
    await p.getByRole('button', { name: /Staff/ }).first().click(); await sleep(400);
    await p.getByRole('button', { name: /Parent/ }).first().click(); await sleep(400);
    const stillDirty = await p.getByRole('button', { name: /Save \(/ }).isVisible().catch(() => false);
    check('switching roles with unsaved edits warns (or keeps the draft)', !dirtyLabel || stillDirty || dialogs.length > 0, `dirtyBefore=${dirtyLabel} dirtyAfter=${stillDirty} dialogs=${dialogs.length}`);
    await ctx.close();
  });

  await section('Audit log', async () => {
    const ctx = await ctxFor(browser, ADM);
    const p = await ctx.newPage();
    await p.goto(`${BASE}/app/admin/audit`, { waitUntil: 'domcontentloaded' }); await settle(p);
    const routine = await p.locator('tbody tr', { hasText: /feed\.post\.create|mail\.send/ }).count();
    const roleRow = p.locator('tbody tr', { hasText: 'user.role.assign' }).first();
    const metaShown = (await roleRow.count()) ? /→|from|to:/i.test((await roleRow.innerText()).replace('Admin Gaptwo','')) : null;
    check('audit role-assign row shows what changed (from → to)', metaShown === true, `metaShown=${metaShown}`);
    check('audit log is limited to privileged actions (no routine feed/mail rows)', routine === 0, `routineRows=${routine}`);
    await p.route('**/api/audit**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"message":"db down"}' }));
    await p.reload(); await settle(p);
    const emptyLie = await visible(p, 'No audit entries yet', 2000);
    check('audit load failure shows an error, not "No audit entries yet"', !emptyLie);
    await p.screenshot({ path: `${OUT}/audit-500.png` });
    await ctx.close();
  });

  await section('Mobile More sheet & palette a11y', async () => {
    const ctx = await ctxFor(browser, ADM, { width: 390, height: 844 });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/app/chat`, { waitUntil: 'domcontentloaded' }); await settle(p);
    await p.getByRole('button', { name: 'More' }).click(); await sleep(300);
    await p.keyboard.press('Escape'); await sleep(300);
    const open = await p.getByRole('dialog', { name: 'More' }).isVisible().catch(() => false);
    check('Escape closes the mobile More sheet', !open);
    await p.screenshot({ path: `${OUT}/mobile-more.png` });
    await ctx.close();
    const c2 = await ctxFor(browser, ADM);
    const p2 = await c2.newPage();
    await p2.goto(`${BASE}/app/chat`, { waitUntil: 'domcontentloaded' }); await settle(p2);
    await p2.keyboard.press('Control+k'); await sleep(300);
    for (let i = 0; i < 40; i++) await p2.keyboard.press('Tab');
    const inDialog = await p2.evaluate(() => !!document.activeElement?.closest('[aria-label="Search Tupo"][role="dialog"]'));
    check('Tab keeps focus inside the search dialog (focus trap)', inDialog);
    const dest = await p2.locator('[aria-label="Destinations"] [role="option"]').allInnerTexts();
    const hasDash = dest.some((t) => /Dashboard/.test(t));
    const hasOversight = dest.some((t) => /Oversight/.test(t));
    check('launcher lists every admin destination the user can open (Dashboard, Oversight)', hasDash && hasOversight, `dashboard=${hasDash} oversight=${hasOversight}`);
    await c2.close();
  });

  await section('Install prompt on guest + PWA offline', async () => {
    const ctx = await ctxFor(browser, null, { width: 390, height: 844 }, { dismissInstall: false });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/meet/abc-defg-hij`, { waitUntil: 'domcontentloaded' }); await settle(p, 1500);
    const modal = await p.getByText(/Install Tupo|Add Tupo|install/i).first().isVisible().catch(() => false);
    check('a guest (no NGA account) joining a meeting is not asked to install Tupo', !modal);
    await p.screenshot({ path: `${OUT}/guest-install.png` });
    await ctx.close();

    const c2 = await ctxFor(browser, A);
    const p2 = await c2.newPage();
    await p2.goto(`${BASE}/app/chat`, { waitUntil: 'domcontentloaded' }); await settle(p2);
    const swReady = await p2.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const r = await Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((res) => setTimeout(() => res(false), 8000))]);
      return r;
    });
    await p2.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' }); await settle(p2, 1500); // lets the SW cache "/"
    await c2.setOffline(true);
    await p2.goto(`${BASE}/app/chat`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(3000);
    const text = (await p2.locator('body').innerText().catch(() => '')).trim();
    check('offline launch shows a usable shell or an offline page (not blank)', text.length > 20, `swReady=${swReady} bodyChars=${text.length} sample="${text.slice(0, 80)}"`);
    await p2.screenshot({ path: `${OUT}/pwa-offline.png` });
    await c2.setOffline(false);
    await c2.close();
  });
} finally {
  await browser?.close().catch(() => {});
  if (tempRoleId) {
    await pool.query('UPDATE users SET role_id=NULL WHERE role_id=$1', [tempRoleId]).catch(() => {});
    await pool.query('DELETE FROM role_permissions WHERE role_id=$1', [tempRoleId]).catch(() => {});
  }
  await purgeUsers(pool, ids, { quiet: true }).catch((e) => console.error('purge', e));
  if (tempRoleId) await pool.query('DELETE FROM roles WHERE id=$1', [tempRoleId]).catch((e) => console.error('role cleanup', e.message));
  writeFileSync(`${OUT}/shell-results.json`, JSON.stringify(results, null, 2));
  await pool.end();
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed. Output: ${OUT}`);
}
