#!/usr/bin/env node
/**
 * Campaign actions ask first, and the do-not-email list (M5), in a real browser:
 *
 *   - Approve says how many people it reaches and does nothing until confirmed;
 *   - Send back asks for the reason and stores it;
 *   - Cancel asks, "Keep it" keeps it, confirming cancels it;
 *   - the do-not-email list adds, refuses a non-address, searches and removes.
 *
 *   npm run verify:mail:campaigns      (needs `npm run dev`)
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
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const tag = randomBytes(3).toString('hex');
const blocked = `blocked-${tag}@outside.example`;

async function makeUser(name, roleName) {
  const id = `vmc-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = $1`, [roleName]);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, roleName.toLowerCase(), rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: roleName.toLowerCase() };
  return { id, name, user, perms, roleName, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
async function campaign(from, subject, status) {
  const id = `${Date.now()}${randomBytes(3).readUIntBE(0, 3)}`;
  await pool.query(`INSERT INTO mail_campaigns (id, name, subject, body_html, from_user_id, from_name, status, total_recipients, created_by, requires_approval)
    VALUES ($1,$2,$2,'<p>hi</p>',$3,$4,$5,42,$3,true)`, [id, subject, from.id, from.name, status]);
  return id;
}
const statusOf = async (id) => (await pool.query('SELECT status, rejected_reason FROM mail_campaigns WHERE id = $1', [id])).rows[0];

let browser;
try {
  const approver = await makeUser(`Ann Approver ${tag}`, 'Admin');
  const author = await makeUser(`Sam Sender ${tag}`, 'Staff');
  const toApprove = await campaign(author, `Approve me ${tag}`, 'pending_approval');
  const toReject = await campaign(author, `Send me back ${tag}`, 'pending_approval');
  const toCancel = await campaign(approver, `Cancel me ${tag}`, 'draft');

  browser = prepareBrowser(await chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, {
    tupo_token: approver.token, tupo_user: JSON.stringify(approver.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: approver.perms, name: approver.roleName }) });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/mail/campaigns`);
  const queue = page.locator('li', { hasText: `Approve me ${tag}` }).first();
  await queue.waitFor({ timeout: 20_000 });
  const dialog = page.getByRole('alertdialog');

  console.log('\nApprove');
  await queue.getByRole('button', { name: 'Approve' }).click();
  check('Approve asks first and says how many people it reaches', await dialog.getByText(/42 people/).isVisible().catch(() => false));
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  check('and nothing happens without confirming', (await statusOf(toApprove)).status === 'pending_approval');

  console.log('\nSend back');
  await page.locator('li', { hasText: `Send me back ${tag}` }).first().getByRole('button', { name: 'Send back' }).click();
  const reason = dialog.getByRole('textbox');
  check('Send back asks what to change, with the cursor in the box', await reason.evaluate((el) => el === document.activeElement).catch(() => false));
  await reason.fill(`Fix the date ${tag}`);
  await dialog.getByRole('button', { name: 'Send back' }).click();
  await page.waitForTimeout(1_500);
  const rejected = await statusOf(toReject);
  check('the reason is stored with the campaign', rejected.rejected_reason === `Fix the date ${tag}`, JSON.stringify(rejected));

  console.log('\nCancel');
  const row = page.locator(`#campaign-${toCancel}`);
  await row.getByRole('button', { name: 'Cancel campaign' }).click();
  await dialog.getByRole('button', { name: 'Keep it' }).click();
  check('"Keep it" keeps it', (await statusOf(toCancel)).status === 'draft');
  await row.getByRole('button', { name: 'Cancel campaign' }).click();
  await dialog.getByRole('button', { name: 'Cancel campaign' }).click();
  await page.waitForTimeout(1_500);
  check('confirming cancels it', (await statusOf(toCancel)).status === 'cancelled', (await statusOf(toCancel)).status);

  console.log('\nDo-not-email list');
  const list = page.getByRole('region', { name: 'Do-not-email list' });
  await list.getByLabel('Address to stop emailing').fill(blocked);
  await list.getByLabel('Why').fill('asked by phone');
  await list.getByRole('button', { name: 'Add' }).click();
  await page.waitForTimeout(1_000);
  check('an address can be added', (await pool.query('SELECT reason FROM mail_suppressions WHERE address = $1', [blocked])).rows[0]?.reason === 'manual');
  await list.getByLabel('Search the do-not-email list').fill(`blocked-${tag}`);
  check('and found by search', await list.getByText(blocked, { exact: true }).waitFor({ timeout: 5_000 }).then(() => true).catch(() => false));
  await list.getByRole('button', { name: `Remove ${blocked}` }).click();
  await dialog.getByRole('button', { name: 'Remove from list' }).click();
  await page.waitForTimeout(1_000);
  check('and removed after confirming', (await pool.query('SELECT 1 FROM mail_suppressions WHERE address = $1', [blocked])).rows.length === 0);
  const bad = await page.evaluate(async () => (await fetch('/api/mail/suppressions', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('tupo_token')}` },
    body: JSON.stringify({ address: 'not an address' }) })).status);
  check('a non-address is refused', bad === 400, String(bad));
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  await pool.query('DELETE FROM mail_suppressions WHERE address = $1', [blocked]).catch(() => {});
  await pool.query('DELETE FROM mail_campaigns WHERE created_by = ANY($1)', [ids]).catch(() => {});
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:mail:campaigns: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
