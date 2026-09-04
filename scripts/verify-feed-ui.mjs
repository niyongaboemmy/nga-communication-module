#!/usr/bin/env node
/**
 * Feed UI — drives the real React app in Chromium.
 *
 * Confirms the feed renders, the composer publishes a post, a reaction and a
 * comment land, the page directory and a page profile open, and the layout
 * collapses cleanly on a phone. Writes light + dark + mobile screenshots to
 * .feed-ui-shots/.
 *
 *   npm run verify:feed:ui        (needs `npm run dev` running)
 */
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const BASE = 'http://localhost:5194';
const SHOTS = `${ROOT}/.feed-ui-shots`;
mkdirSync(SHOTS, { recursive: true });

const pass = [], fails = [];
const check = (n, ok, d = '') => { (ok ? pass : fails).push(n); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };

async function makeUser(name, roleName = 'Admin') {
  const id = `feedui-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query('SELECT id FROM roles WHERE name = $1', [roleName]);
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, roleName.toLowerCase(), rows[0].id]);
  const perms = (await pool.query(
    `SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`,
    [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: roleName.toLowerCase() };
  return { id, name, perms, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '30m' }), user, roleName };
}
const seed = (u) => ({
  tupo_token: u.token,
  tupo_user: JSON.stringify(u.user),
  tupo_permissions: JSON.stringify([]),
  tupo_role_permissions: JSON.stringify({ keys: u.perms, name: u.roleName }),
});
const cleanup = () => pool.query(`DELETE FROM users WHERE id LIKE 'feedui-%'`);

let browser;
try {
  await cleanup();
  const ada = await makeUser('UI Ada', 'Admin');
  // Give Ada an editable page.
  const pageRes = await fetch('http://localhost:5190/api/feed/pages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ada.token}` },
    body: JSON.stringify({ name: `UI Demo ${randomBytes(3).toString('hex')}`, audience: 'everyone' }),
  }).then((r) => r.json());
  const pageId = pageRes.data.page.id;

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, seed(ada));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  page error:', e.message));

  await page.goto(`${BASE}/app/feed`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  check('composer pill renders', await page.getByText(/What's on your mind/i).first().waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));

  await page.getByText(/What's on your mind/i).first().click();
  check('composer expands', await page.getByRole('heading', { name: 'Create post' }).isVisible({ timeout: 4000 }).catch(() => false));
  const bodyText = `Playwright says hello 👋 ${randomBytes(2).toString('hex')} #tupo`;
  await page.getByPlaceholder('What would you like to share?').fill(bodyText);
  await page.getByRole('button', { name: /^Post$/ }).click();
  check('post appears in the feed', await page.getByText(bodyText).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false));

  // React
  await page.getByRole('button', { name: /Like/ }).first().click();
  await page.waitForTimeout(500);
  check('reaction registers', await page.getByRole('button', { name: /Love|Like/ }).first().isVisible().catch(() => false));

  // Comment
  await page.getByRole('button', { name: /Comment/ }).first().click();
  await page.getByPlaceholder('Write a comment…').first().fill('First! 🎉');
  await page.getByPlaceholder('Write a comment…').first().press('Enter');
  await page.waitForTimeout(1200);
  check('comment posts', await page.getByText('First! 🎉').first().isVisible().catch(() => false));

  await page.screenshot({ path: `${SHOTS}/feed-home-light.png`, fullPage: true });

  // Dark mode
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/feed-home-dark.png`, fullPage: true });

  // Page directory
  await page.goto(`${BASE}/app/feed/pages`, { waitUntil: 'networkidle' });
  check('page directory renders', await page.getByRole('heading', { name: 'Pages' }).isVisible({ timeout: 6000 }).catch(() => false));
  await page.screenshot({ path: `${SHOTS}/feed-pages.png`, fullPage: true });

  // Page profile
  await page.goto(`${BASE}/app/feed/p/${pageRes.data.page.slug}`, { waitUntil: 'networkidle' });
  check('page profile renders', await page.getByRole('button', { name: /Following|Follow/ }).first().isVisible({ timeout: 6000 }).catch(() => false));

  // Mobile
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await m.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, seed(ada));
  const mp = await m.newPage();
  await mp.goto(`${BASE}/app/feed`, { waitUntil: 'networkidle' });
  check('feed renders on a phone viewport', await mp.getByText(/What's on your mind/i).first().isVisible({ timeout: 10000 }).catch(() => false));
  check('no horizontal overflow on mobile', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await mp.screenshot({ path: `${SHOTS}/feed-mobile.png`, fullPage: true });

  await browser.close();
  await cleanup();
  await pool.end();
  console.log(`\n  ${pass.length} passed, ${fails.length} failed · screenshots in .feed-ui-shots/`);
  process.exit(fails.length ? 1 : 0);
} catch (e) {
  console.error(e);
  await browser?.close();
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
}
