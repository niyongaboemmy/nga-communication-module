#!/usr/bin/env node
/**
 * Mail UI — drives the real React app in Chromium.
 *
 * Confirms the module renders, the rich-text composer (TipTap) mounts and
 * formats, a message sends end to end and shows up in the recipient's inbox,
 * and the layout collapses to one pane on a phone viewport.
 *
 *   npm run verify:mail:ui        (needs `npm run dev` running)
 */
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const BASE = 'http://localhost:5194';

const pass = [], fails = [];
const check = (n, ok, d = '') => { (ok ? pass : fails).push(n); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };

async function makeUser(name) {
  const id = `mailui-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = 'Staff'`);
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`,
    [id, name, `${id}@amashuri.com`, rows[0].id]);
  const perms = (await pool.query(
    `SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`,
    [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' };
  return { id, name, perms, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '30m' }), user };
}

const seed = (u) => ({
  tupo_token: u.token,
  tupo_user: JSON.stringify(u.user),
  tupo_permissions: JSON.stringify([]),
  tupo_role_permissions: JSON.stringify({ keys: u.perms, name: 'Staff' }),
});

const cleanup = () => pool.query(`DELETE FROM users WHERE id LIKE 'mailui-%'`);

let browser;
try {
  await cleanup();
  const ada = await makeUser('UI Ada');
  const ben = await makeUser('UI Ben');

  browser = await chromium.launch();

  // ── desktop: compose + send ────────────────────────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, seed(ada));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  page error:', e.message));
  await page.goto(`${BASE}/app/mail`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  check('Compose button renders', await page.getByRole('button', { name: /compose/i }).first().waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));
  await page.getByRole('button', { name: /compose/i }).first().click();

  check('composer opened with a New message header', await page.getByText('New message').isVisible({ timeout: 4000 }).catch(() => false));

  // Recipient
  await page.getByPlaceholder('Name or email address').fill(ben.name);
  const suggestion = page.getByText(ben.user.email, { exact: false }).first();
  check('directory autocomplete returns a match', await suggestion.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false));
  await suggestion.click();

  const subject = `UI verify ${randomBytes(3).toString('hex')}`;
  await page.getByPlaceholder('Subject').fill(subject);

  // TipTap editor
  const editor = page.locator('.tupo-prose[contenteditable="true"]');
  check('rich-text editor mounted', await editor.isVisible({ timeout: 4000 }).catch(() => false));
  await editor.click();
  await page.keyboard.type('Hello from the ');
  await page.getByRole('button', { name: 'Bold' }).click();
  await page.keyboard.type('composer');
  const hasBold = await editor.locator('strong').count();
  check('bold toolbar button applies <strong>', hasBold > 0);

  // ── AI assistant (Staff holds MAIL_AI_USE) ──────────────────────────────
  const aiBtn = page.getByRole('button', { name: 'AI', exact: true });
  const aiVisible = await aiBtn.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  check('AI assistant button is shown in the composer', aiVisible);
  if (aiVisible) {
    await aiBtn.click();
    await page.getByText('Rewrite what I have').waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
    await page.getByRole('button', { name: 'Improve writing' }).click();
    const gotResult = await page.getByRole('button', { name: /Use this/i })
      .waitFor({ state: 'visible', timeout: 25000 }).then(() => true).catch(() => false);
    check('AI "Improve writing" returns a draft to accept', gotResult);
    if (gotResult) {
      await page.getByText(/ via (openai|gemini|groq|glm)/i).first().isVisible().catch(() => {});
      await page.getByRole('button', { name: /Use this/i }).click();
      check('accepting the AI draft closes the panel',
        await page.getByRole('button', { name: /Use this/i }).isHidden({ timeout: 3000 }).catch(() => true));
    }
  }

  await page.getByRole('button', { name: /^Send$/ }).click();
  check('composer closes after send', await page.getByText('New message').waitFor({ state: 'hidden', timeout: 10000 }).then(() => true).catch(() => false));

  // ── recipient sees it ────────────────────────────────────────────────
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctxB.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, seed(ben));
  const pageB = await ctxB.newPage();
  await pageB.goto(`${BASE}/app/mail`, { waitUntil: 'domcontentloaded' });
  await pageB.waitForLoadState('networkidle').catch(() => {});
  check("message is in Ben's inbox list", await pageB.getByText(subject).first().waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));
  await pageB.getByText(subject).first().click();
  check('thread opens and shows a non-empty body',
    await pageB.locator('.tupo-prose').first().waitFor({ state: 'visible', timeout: 8000 })
      .then(() => pageB.locator('.tupo-prose').first().innerText()).then((t) => t.trim().length > 10).catch(() => false));
  check('reply controls present', await pageB.getByRole('button', { name: /^Reply$/ }).first().isVisible({ timeout: 3000 }).catch(() => false));

  // ── responsive: phone viewport ──────────────────────────────────────
  const phone = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true });
  await phone.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, seed(ben));
  const pageP = await phone.newPage();
  await pageP.goto(`${BASE}/app/mail`, { waitUntil: 'domcontentloaded' });
  await pageP.waitForLoadState('networkidle').catch(() => {});
  const folderToggle = pageP.getByRole('button', { name: 'Folders' });
  check('phone layout shows the Folders toggle (sidebar collapses)', await folderToggle.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));
  await pageP.getByText(subject).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await pageP.getByText(subject).first().click();
  await pageP.waitForURL('**/mail/t/**', { timeout: 10000 }).catch(() => {});
  const threadPane = pageP.locator('section', { has: pageP.getByRole('button', { name: 'Back' }) });
  check('phone: opening a thread replaces the list with the thread', await threadPane.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false));
  check('phone: thread body is shown',
    await pageP.locator('.tupo-prose').first()
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => pageP.locator('.tupo-prose').first().innerText())
      .then((t) => t.trim().length > 10).catch(() => false));
  const listStillThere = await pageP.getByPlaceholder('Search mail').isVisible().catch(() => false);
  check('phone: the list is not shown behind the thread', !listStillThere);

} catch (err) {
  check(`unexpected error: ${err.message}`, false);
  console.error(err);
} finally {
  if (browser) await browser.close();
  await cleanup();
  await pool.end();
}

console.log(`\n  ${pass.length} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
