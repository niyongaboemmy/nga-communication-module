#!/usr/bin/env node
/**
 * Admin screens in a real browser (F-11 … F-14).
 *
 * Users: paging with a real total, filters in the address, search as you
 * type, a role change that asks first (and warns about governance roles), no
 * role dropdown when the roles did not load, CSV export, labelled controls,
 * and a phone layout without sideways scrolling.
 *
 *   npm run verify:admin:ui      (needs `npm run dev`)
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
const OUT = process.env.OUT ?? '/tmp/verify-admin-ui';
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const BASE = 'http://localhost:5194';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const ids = []; const createdRoles = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const tag = randomBytes(3).toString('hex');

async function makeUser(name, roleName = 'Staff') {
  const id = `vad-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = $1`, [roleName]);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, roleName.toLowerCase(), rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: roleName.toLowerCase() };
  return { id, name, perms, roleName, user, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
async function pageFor(browser, u, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, ...opts });
  const kv = { tupo_token: u.token, tupo_user: JSON.stringify(u.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: u.perms, name: u.roleName }) };
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, kv);
  return { ctx, page: await ctx.newPage() };
}
const roleOf = async (id) => (await pool.query('SELECT r.name FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = $1', [id])).rows[0]?.name ?? null;

let browser;
try {
  const admin = await makeUser(`Ada Admin ${tag}`, 'Admin');
  const stu = await makeUser(`Stu Pupil ${tag}`, 'Student');
  const total = Number((await pool.query('SELECT count(*) FROM users')).rows[0].count);
  // Enough people that the roster needs a second page.
  const need = Math.max(0, 55 - total);
  for (let i = 0; i < need; i++) await makeUser(`Vad Filler ${String(i).padStart(2, '0')} ${tag}`, 'Student');
  for (let i = 0; i < 2; i++) await makeUser(`Vad Filler x${i} ${tag}`, 'Student');
  const everyone = Number((await pool.query('SELECT count(*) FROM users')).rows[0].count);

  browser = prepareBrowser(await chromium.launch());

  console.log('── Users: paging, filters, search');
  {
    const { ctx, page } = await pageFor(browser, admin);
    await page.goto(`${BASE}/app/admin/users`, { waitUntil: 'networkidle' });
    const pagerText = await page.locator('nav[aria-label="Pages"]').innerText().catch(() => 'no pager');
    check('the pager states the real total', pagerText.includes(`Showing 1–50 of ${everyone}`), `${pagerText.split('\n')[0]} (db ${everyone})`);
    await page.getByRole('button', { name: 'Next page' }).click();
    await page.getByText(/Showing 51–/).waitFor({ timeout: 5000 }).catch(() => {});
    check('the next page shows the rest and is in the address', /page=2/.test(page.url())
      && (await page.locator('nav[aria-label="Pages"]').innerText()).includes(`Showing 51–${Math.min(100, everyone)} of ${everyone}`));
    await page.reload({ waitUntil: 'networkidle' });
    check('a reload keeps the page', await page.getByText(/Showing 51–/).isVisible());

    await page.getByLabel('Search users by name or email').fill(`Stu Pupil ${tag}`);
    await sleep(900);
    check('search as you type narrows the list', (await page.locator('tbody tr').count()) === 1 && /q=/.test(page.url()));
    await page.getByLabel('Search users by name or email').fill(`zz-nomatch-${tag}`);
    await sleep(900);
    check('a search with no match says so', await page.getByText(/No one matches/).isVisible()
      && !(await page.getByText('No users yet').isVisible().catch(() => false)));
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await sleep(600);

    const adminRoleId = (await pool.query(`SELECT id FROM roles WHERE name = 'Admin'`)).rows[0].id;
    await page.getByLabel('Filter by role').selectOption(String(adminRoleId));
    await page.waitForLoadState('networkidle'); await sleep(400);
    const adminRows = await page.locator('tbody tr').count();
    const adminDb = Number((await pool.query(`SELECT count(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'Admin'`)).rows[0].count);
    check('the role filter shows only that role', adminRows === Math.min(adminDb, 50), `rows=${adminRows} db=${adminDb}`);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await sleep(400);
    const chip = await page.getByRole('button', { name: /^Suspended/ }).innerText();
    check('status chips carry counts', /\d/.test(chip), chip);
    check('controls are labelled', await page.getByLabel('Sort users').isVisible() && await page.getByLabel('Filter by role').isVisible());

    console.log('── Users: role change asks first');
    await page.getByLabel('Search users by name or email').fill(`Stu Pupil ${tag}`);
    await sleep(900);
    await page.getByLabel(`Role for Stu Pupil ${tag}`).selectOption({ label: 'Admin' });
    const dlg = page.getByRole('alertdialog');
    await dlg.waitFor({ timeout: 3000 }).catch(() => {});
    check('choosing Admin opens a confirmation', await dlg.isVisible());
    check('it names the change and warns about governance', /Student.*→.*Admin/s.test(await dlg.innerText())
      && /manage users and roles/.test(await dlg.innerText()));
    check('nothing changes before confirming', (await roleOf(stu.id)) === 'Student');
    await page.keyboard.press('Escape');
    await sleep(300);
    check('Escape cancels and the dropdown shows the real role again',
      (await roleOf(stu.id)) === 'Student'
      && (await page.getByLabel(`Role for Stu Pupil ${tag}`).locator('option:checked').innerText()) === 'Student');
    await page.getByLabel(`Role for Stu Pupil ${tag}`).selectOption({ label: 'Staff' });
    await dlg.getByRole('button', { name: 'Change role' }).click();
    await sleep(1200);
    check('confirming applies it', (await roleOf(stu.id)) === 'Staff');
    check('…with a confirmation toast', await page.getByText(new RegExp(`Stu Pupil ${tag} is now Staff`)).isVisible().catch(() => false));

    console.log('── Users: export');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    let csv = '';
    if (download) csv = readFileSync(await download.path(), 'utf8');
    check('Export CSV downloads the filtered roster', csv.includes('Name,Email') && csv.includes(`Stu Pupil ${tag}`)
      && csv.trim().split(/\r?\n/).length === 2, `${download?.suggestedFilename()} lines=${csv.trim().split(/\r?\n/).length}`);
    await page.screenshot({ path: `${OUT}/users.png`, fullPage: true });
    await ctx.close();
  }

  console.log('── Users: roles that fail to load');
  {
    const { ctx, page } = await pageFor(browser, admin);
    await page.route('**/api/users/assignable-roles', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false}' }));
    await page.goto(`${BASE}/app/admin/users?q=${encodeURIComponent(`Stu Pupil ${tag}`)}`, { waitUntil: 'networkidle' });
    check('no role dropdown when the roles did not load', (await page.locator('tbody select').count()) === 0);
    check('…and it says why, with a retry', await page.getByText(/roles did not load/).isVisible()
      && await page.getByRole('button', { name: /Try again/ }).isVisible());
    await ctx.close();
  }

  console.log('── Roles: drafts, leaving, search, rename, conflicts');
  {
    const API = 'http://localhost:5190';
    const put = (id, body) => fetch(`${API}/api/roles-permissions/roles/${id}`, {
      method: 'PUT', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.json());
    const { rows: made } = await pool.query(
      `INSERT INTO roles (name, description, level, is_system) VALUES ($1, 'Probe role', 'STAFF', false) RETURNING id`, [`Vad Role ${tag}`]);
    const rid = made[0].id;
    createdRoles.push(rid);
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = 'MESSAGE_READ'`, [rid]);
    const keysOf = async () => (await pool.query(`SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1 ORDER BY 1`, [rid])).rows.map((r) => r.key);

    const { ctx, page } = await pageFor(browser, admin);
    await page.goto(`${BASE}/app/admin/roles?role=${rid}`, { waitUntil: 'networkidle' });
    const box = (key) => page.locator('label', { hasText: key }).locator('input[type="checkbox"]').first();
    await box('MESSAGE_SEND').check();
    check('an edit marks the role Unsaved and lists the change',
      await page.getByText('Unsaved', { exact: true }).first().isVisible() && await page.getByText('+MESSAGE_SEND').isVisible());
    await page.getByRole('button', { name: /^Staff/ }).first().click();
    await sleep(300);
    await page.getByRole('button', { name: new RegExp(`^Vad Role ${tag}`) }).click();
    await sleep(300);
    check('moving to another role and back keeps the draft', await box('MESSAGE_SEND').isChecked()
      && await page.getByRole('button', { name: /Save \(/ }).isVisible());

    await page.getByLabel('Search permissions').fill('mail');
    await sleep(200);
    const sections = await page.locator('section[aria-label]').count();
    const sendVisible = await page.getByText('MESSAGE_SEND', { exact: true }).isVisible().catch(() => false);
    check('searching permissions narrows the list', sections >= 1 && !sendVisible, `sections=${sections}`);
    await page.getByLabel('Search permissions').fill('');
    await page.getByLabel('Only granted').check();
    await sleep(200);
    const shownBoxes = await page.locator('section[aria-label] input[type="checkbox"]').count();
    check('"Only granted" shows just the granted ones', shownBoxes === 2, `shown=${shownBoxes}`);
    await page.getByLabel('Only granted').uncheck();

    await page.locator('a[href="/app/admin/users"]').first().click();
    const leave = page.getByRole('alertdialog');
    await leave.waitFor({ timeout: 3000 }).catch(() => {});
    check('leaving with unsaved changes asks first', await leave.isVisible() && /Leave without saving/.test(await leave.innerText()));
    await leave.getByRole('button', { name: 'Keep editing' }).click();
    await sleep(300);
    check('"Keep editing" stays on the roles screen with the draft', /\/admin\/roles/.test(page.url()) && await box('MESSAGE_SEND').isChecked());

    await page.getByLabel('Role name').fill(`Vad Renamed ${tag}`);
    await page.getByLabel('Role description').fill('Edited by the probe');
    await page.getByRole('button', { name: /Save \(/ }).click();
    await sleep(1200);
    const row = (await pool.query('SELECT name, description FROM roles WHERE id = $1', [rid])).rows[0];
    check('saving applies the name, description and permissions together',
      row.name === `Vad Renamed ${tag}` && row.description === 'Edited by the probe'
      && JSON.stringify(await keysOf()) === JSON.stringify(['MESSAGE_READ', 'MESSAGE_SEND']), JSON.stringify(row));
    check('…and the Unsaved marker clears', !(await page.getByText('Unsaved', { exact: true }).first().isVisible().catch(() => false)));

    // Somebody else saves in between.
    await box('MAIL_READ').check();
    const now = (await (await fetch(`${API}/api/roles-permissions/roles/${rid}`, { headers: { authorization: `Bearer ${admin.token}` } })).json()).data;
    await put(rid, { permissionKeys: ['MESSAGE_READ'], expectedVersion: now.version });
    await page.getByRole('button', { name: /Save \(/ }).click();
    await sleep(1000);
    const banner = page.getByText(/Someone else saved changes/);
    check('a save over a colleague\'s newer save is caught', await banner.isVisible()
      && JSON.stringify(await keysOf()) === JSON.stringify(['MESSAGE_READ']));
    await page.getByRole('button', { name: 'Save mine over it' }).click();
    await sleep(1200);
    check('"Save mine over it" saves deliberately', (await keysOf()).includes('MAIL_READ') && !(await banner.isVisible().catch(() => false)),
      JSON.stringify(await keysOf()));
    await box('MAIL_READ').uncheck();
    const now2 = (await (await fetch(`${API}/api/roles-permissions/roles/${rid}`, { headers: { authorization: `Bearer ${admin.token}` } })).json()).data;
    await put(rid, { permissionKeys: ['MESSAGE_READ', 'MESSAGE_SEND', 'MAIL_READ', 'FEED_VIEW'], expectedVersion: now2.version });
    await page.getByRole('button', { name: /Save \(/ }).click();
    await sleep(1000);
    await page.getByRole('button', { name: 'Load their version' }).click();
    await sleep(500);
    check('"Load their version" drops the draft and shows theirs',
      await box('FEED_VIEW').isChecked() && await box('MAIL_READ').isChecked()
      && !(await page.getByText('Unsaved', { exact: true }).first().isVisible().catch(() => false)));

    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete role' }).click();
    await sleep(1000);
    check('deleting asks first, then removes the role', (await pool.query('SELECT 1 FROM roles WHERE id = $1', [rid])).rowCount === 0);
    await page.screenshot({ path: `${OUT}/roles.png`, fullPage: false });
    await ctx.close();
  }

  console.log('── Audit log: privileged first, readable, filterable');
  {
    const { ctx, page } = await pageFor(browser, admin);
    await page.goto(`${BASE}/app/admin/audit`, { waitUntil: 'networkidle' });
    const rows = page.locator('tbody tr');
    const assign = rows.filter({ hasText: `Stu Pupil ${tag}` }).filter({ hasText: 'Changed a role' }).first();
    check('the role change reads in words: who, what, from → to',
      await assign.isVisible().catch(() => false) && /Student\s*→\s*Staff/.test(await assign.innerText().catch(() => '')),
      (await assign.innerText().catch(() => 'row not found')).replace(/\s+/g, ' ').slice(0, 120));
    const routine = await rows.filter({ hasText: /Feed post create|Mail send|Signed in/ }).count();
    check('the default view holds no routine activity or sign-ins', routine === 0, `routine=${routine}`);
    const link = assign.getByRole('link', { name: `Stu Pupil ${tag}` });
    check('the target is a name with a link, not an id', await link.isVisible().catch(() => false));
    await assign.getByRole('button', { name: 'Show details' }).click();
    check('details open with the raw entry', await page.getByText('"roleNameTo": "Staff"').isVisible().catch(() => false));

    await page.getByRole('tab', { name: 'Sign-ins' }).click();
    await page.waitForLoadState('networkidle'); await sleep(300);
    const nonSignin = await rows.filter({ hasNotText: 'Signed in' }).filter({ has: page.locator('td[data-label="Action"]') }).count();
    check('the Sign-ins tab shows only sign-ins', nonSignin === 0 && /view=signins/.test(page.url()), `others=${nonSignin}`);
    await page.getByRole('tab', { name: 'Everything' }).click();
    await page.waitForLoadState('networkidle'); await sleep(300);
    check('Everything includes routine entries, marked as such', (await page.getByText('routine', { exact: true }).count()) > 0);

    await page.getByRole('tab', { name: 'Privileged' }).click();
    await page.waitForLoadState('networkidle'); await sleep(300);
    await page.getByLabel('Filter by action').selectOption('user.role.assign');
    await page.waitForLoadState('networkidle'); await sleep(400);
    const actionsShown = await page.locator('td[data-label="Action"]').allInnerTexts();
    check('filtering by action shows only that action', actionsShown.length > 0 && actionsShown.every((t) => t.includes('Changed a role')), `${actionsShown.length} rows`);
    await page.getByLabel('Filter by action').selectOption('');
    await page.waitForLoadState('networkidle'); await sleep(400);
    const before = await rows.filter({ has: page.locator('td[data-label="Action"]') }).count();
    const older = page.getByRole('button', { name: 'Load older entries' });
    if (await older.isVisible().catch(() => false)) {
      await older.click();
      await sleep(1200);
      const after = await rows.filter({ has: page.locator('td[data-label="Action"]') }).count();
      check('"Load older entries" appends the next page', after > before, `${before} → ${after}`);
    } else {
      check('short history says it is complete', await page.getByText(/That is everything/).isVisible());
    }
    await link.click().catch(() => {});
    await page.waitForLoadState('networkidle');
    check('the target link opens that person in Users', /\/app\/admin\/users\?q=/.test(page.url()), page.url());
    await page.goto(`${BASE}/app/admin/audit`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: `${OUT}/audit.png`, fullPage: false });
    await ctx.close();
  }

  console.log('── Users: phone');
  {
    const { ctx, page } = await pageFor(browser, admin, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(`${BASE}/app/admin/users`, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('users fits a phone', overflow <= 1, `overflow=${overflow}px`);
    await page.screenshot({ path: `${OUT}/users-phone.png`, fullPage: false });
    await ctx.close();
  }
} catch (e) {
  check('suite ran to completion', false, e?.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
  await browser?.close();
  await purgeUsers(pool, ids).catch(() => {});
  for (const id of createdRoles) await pool.query('DELETE FROM roles WHERE id = $1 AND is_system = false', [id]).catch(() => {});
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:admin:ui: ${results.length - failed} passed, ${failed} failed · screenshots in ${OUT}`);
  process.exit(failed ? 1 : 0);
}
