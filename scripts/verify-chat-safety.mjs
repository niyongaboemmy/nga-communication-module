#!/usr/bin/env node
/**
 * Chat safety journeys (B-05) in a real browser: the profile card behind an
 * avatar, blocking (DM composer banner, folded messages), reporting a message,
 * and a moderator working the chat reports queue.
 *
 *   npm run verify:chat:safety      (needs `npm run dev`)
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
const OUT = process.env.OUT ?? '/tmp/verify-chat-safety';
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const API = 'http://localhost:5190', BASE = 'http://localhost:5194';
const results = []; const ids = []; const convs = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const nonce = () => randomBytes(8).toString('hex');

async function makeUser(name, roleName = 'Staff') {
  const id = `vcs-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = $1`, [roleName]);
  const role = roleName.toLowerCase();
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`, [id, name, `${id}@amashuri.com`, role, rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role };
  return { id, name, perms, roleName, user, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
const call = async (u, method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
async function pageFor(browser, u) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const kv = { tupo_token: u.token, tupo_user: JSON.stringify(u.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: u.perms, name: u.roleName }) };
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, kv);
  return ctx.newPage();
}

let browser;
try {
  const ann = await makeUser('Ann Safety');
  const bob = await makeUser('Bob Sender');
  const mod = await makeUser('Mo Moderator', 'Moderator');
  const dm = (await call(ann, 'POST', '/api/chat/conversations/direct', { userId: bob.id })).body.data.conversation.id;
  const group = (await call(ann, 'POST', '/api/chat/conversations', { type: 'group', name: `Safety ${nonce().slice(0, 4)}`, memberIds: [bob.id] })).body.data.conversation.id;
  convs.push(dm, group);
  await call(bob, 'POST', `/api/chat/conversations/${dm}/messages`, { body: 'hi Ann (dm)', nonce: nonce() });
  await call(bob, 'POST', `/api/chat/conversations/${group}/messages`, { body: 'REPORT ME PLEASE', nonce: nonce() });

  browser = prepareBrowser(await chromium.launch());
  const page = await pageFor(browser, ann);

  console.log('\nThe profile card');
  await page.goto(`${BASE}/app/chat?c=${group}`);
  await page.getByText('REPORT ME PLEASE').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /Bob Sender, profile/ }).first().click();
  const card = page.getByRole('dialog', { name: /Bob Sender, profile/ });
  await card.waitFor({ timeout: 8000 });
  check('clicking an avatar opens the profile card', await card.isVisible());
  check('the card offers Block and Report', await card.getByRole('button', { name: 'Block' }).isVisible() && await card.getByRole('button', { name: 'Report' }).isVisible());
  await page.screenshot({ path: `${OUT}/01-profile-card.png` });

  console.log('\nBlocking');
  await card.getByRole('button', { name: 'Block' }).click();
  await page.getByText(/Bob Sender is blocked/).waitFor({ timeout: 8000 });
  check('blocking confirms, and says the other person is not told', await page.getByText(/They aren’t told/).isVisible());
  await page.keyboard.press('Escape');
  const folded = page.getByText('Message from someone you blocked');
  await folded.first().waitFor({ timeout: 8000 });
  check('their messages fold away in shared conversations', await folded.first().isVisible());
  await page.screenshot({ path: `${OUT}/02-folded.png` });

  await page.goto(`${BASE}/app/chat?c=${dm}`);
  const banner = page.getByText(/You blocked Bob Sender/);
  await banner.waitFor({ timeout: 15000 });
  check('the DM composer is replaced by a blocked banner', await banner.isVisible());
  await page.screenshot({ path: `${OUT}/03-dm-blocked.png` });
  const sendTry = await call(bob, 'POST', `/api/chat/conversations/${dm}/messages`, { body: 'are you there', nonce: nonce() });
  check('the blocked person cannot send', sendTry.status === 403, String(sendTry.status));
  await page.getByRole('button', { name: 'Unblock' }).click();
  await page.locator('textarea').first().waitFor({ timeout: 8000 });
  check('Unblock brings the composer back', await page.locator('textarea').first().isVisible());

  console.log('\nReporting a message');
  await page.goto(`${BASE}/app/chat?c=${group}`);
  const msg = page.getByText('REPORT ME PLEASE');
  await msg.waitFor({ timeout: 15000 });
  const row = page.locator('[data-message-row]', { has: msg });
  await row.hover();
  await row.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Report message' }).click();
  const dlg = page.getByRole('dialog', { name: 'Report message' });
  await dlg.waitFor({ timeout: 8000 });
  check('the report dialog opens from the message menu', await dlg.isVisible());
  await dlg.getByText('Bullying or harassment').click();
  await dlg.locator('textarea').fill('Seen in our group');
  await page.screenshot({ path: `${OUT}/04-report-dialog.png` });
  await dlg.getByRole('button', { name: 'Send report' }).click();
  await page.getByText(/the moderators will look at it/).waitFor({ timeout: 8000 });
  check('sending confirms', true);

  console.log('\nThe moderator');
  const mpage = await pageFor(browser, mod);
  await mpage.goto(`${BASE}/app/feed/moderation`);
  await mpage.getByRole('tab', { name: 'People & messages' }).click();
  const excerpt = mpage.getByText('REPORT ME PLEASE');
  await excerpt.waitFor({ timeout: 15000 });
  check('the report shows in the chat queue with the message as reported', await excerpt.isVisible());
  await mpage.screenshot({ path: `${OUT}/05-queue.png` });
  const item = mpage.locator('li', { has: excerpt });
  await item.getByPlaceholder(/Note for the record/).fill('Spoke to Bob');
  await item.getByRole('button', { name: 'Resolved' }).click();
  await excerpt.waitFor({ state: 'detached', timeout: 8000 });
  check('resolving takes it off the open queue', true);
  const { rows: n } = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'moderation.report'`, [ann.id]);
  check('the reporter is told it was reviewed', n.length === 1);
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  await pool.query('DELETE FROM user_reports WHERE reporter_id = ANY($1::text[])', [ids]).catch(() => {});
  await pool.query('DELETE FROM user_blocks WHERE blocker_id = ANY($1::text[])', [ids]).catch(() => {});
  for (const t of ['message_reactions', 'message_mentions', 'message_receipts']) await pool.query(`DELETE FROM ${t} WHERE conversation_id = ANY($1::text[])`, [convs]).catch(() => {});
  await pool.query('DELETE FROM messages WHERE conversation_id = ANY($1::text[])', [convs]).catch(() => {});
  await pool.query('DELETE FROM conversation_members WHERE conversation_id = ANY($1::text[])', [convs]).catch(() => {});
  await pool.query('DELETE FROM conversations WHERE id = ANY($1::text[])', [convs]).catch(() => {});
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:chat:safety: ${results.length - failed} passed, ${failed} failed · screenshots in ${OUT}`);
  process.exit(failed ? 1 : 0);
}
