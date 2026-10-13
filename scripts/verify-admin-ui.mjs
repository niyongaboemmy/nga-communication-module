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
const results = []; const ids = [];
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
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:admin:ui: ${results.length - failed} passed, ${failed} failed · screenshots in ${OUT}`);
  process.exit(failed ? 1 : 0);
}
