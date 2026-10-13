#!/usr/bin/env node
/**
 * Chat sending reliability (B-06, A-08): an over-limit message is refused in
 * place, a refused send can be discarded (and offers nothing else), and media
 * tickets live long enough to play a voice note.
 *
 *   npm run verify:chat:sending      (needs `npm run dev`)
 */
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { purgeUsers } from './lib/purge.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = process.env.OUT ?? '/tmp/verify-chat-sending';
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const API = 'http://localhost:5190', BASE = 'http://localhost:5194';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const ids = [];
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
async function ctxFor(browser, u, viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport });
  const kv = { tupo_token: u.token, tupo_user: JSON.stringify(u.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: u.perms, name: u.roleName }), 'nga.appInstalled': '1' };
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); sessionStorage.setItem('nga.installDismissedThisSession', '1'); }, kv);
  await ctx.route('**/api/sso/verify-mis**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":{"valid":true}}' }));
  return ctx;
}
/** Badge text on B's conversation row named `name`, or '' if none. */
const rowBadge = (page, name) => page.evaluate((name) => {
  const rows = [...document.querySelectorAll('li button')].filter((b) => b.innerText.includes(name));
  if (!rows.length) return 'ROW-MISSING';
  const badge = rows[0].querySelector('[aria-label*="unread"]');
  return badge ? badge.textContent.trim() : '';
}, name);
const railChat = (page) => page.evaluate(() => {
  // The visible Chat link only — desktop rail and phone tab bar both exist in
  // the DOM, one of them hidden by the breakpoint.
  const a = [...document.querySelectorAll('a[href="/app/chat"]')].find((x) => x.offsetParent !== null);
  return (a?.querySelector('[aria-label*="unread"]')?.textContent ?? '').trim();
});
const dbUnread = async (convId, userId) => (await pool.query('SELECT unread_count, unread_mentions, last_read_seq FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [convId, userId])).rows[0];
const apiUnread = async (u, convId) => (await call(u, 'GET', '/api/chat/conversations')).body?.data?.conversations?.find((c) => c.id === convId)?.unread;




let browser;
try {
  const A = await makeUser('Ada Send');
  const B = await makeUser('Ben Send');
  browser = await chromium.launch();
  const grp = (await call(A, 'POST', '/api/chat/conversations', { type: 'group', name: 'Send Lab', memberIds: [B.id] })).body.data.conversation.id;
  await call(A, 'POST', `/api/chat/conversations/${grp}/messages`, { body: 'hello', nonce: nonce() });

  const ctx = await ctxFor(browser, B);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/app/chat?c=${grp}`, { waitUntil: 'domcontentloaded' });
  await p.waitForLoadState('networkidle').catch(() => {});
  await sleep(1500);
  const box = p.locator('#composer');

  console.log('\n── Over the length limit');
  await box.fill('x'.repeat(8100));
  await box.press('Enter');
  await sleep(1200);
  check('Enter on an over-limit message keeps the text in the composer', ((await box.inputValue()).length) === 8100);
  check('…and posts nothing that can never send', !(await p.getByText(/Not sent/).first().isVisible().catch(() => false)));
  await box.fill('');

  console.log('\n── A send the server refuses');
  // Archived behind the open page's back, so the next send is refused.
  await pool.query('UPDATE conversations SET is_archived = true WHERE id = $1', [grp]);
  await sleep(800);
  await box.fill('this will be refused');
  await box.press('Enter');
  await sleep(2500);
  const failedRow = p.locator('li', { hasText: 'this will be refused' }).first();
  check('the refused message shows as not sent', await failedRow.getByText(/Not sent/).isVisible().catch(() => false));
  await failedRow.hover();
  check('a failed message offers no save/pin/react toolbar', !(await failedRow.getByRole('button', { name: /Add reaction/ }).isVisible().catch(() => false)));
  await failedRow.getByRole('button', { name: 'Discard' }).click().catch(() => {});
  await sleep(800);
  check('Discard removes it', !(await p.getByText('this will be refused').first().isVisible().catch(() => false)));
  await p.screenshot({ path: `${OUT}/after-discard.png` });

  console.log('\n── Media tickets');
  const { rows } = await pool.query(`INSERT INTO files (id, owner_id, storage_driver, original_name, mime_type, size_bytes, storage_key, status)
    VALUES ($1, $2, 'local', 'v.webm', 'audio/webm', 10, $3, 'ready') RETURNING id`, [`vcsf-${nonce()}`, B.id, `vcs/${nonce()}`]).catch((e) => { console.log(e.message); return { rows: [] }; });
  if (rows[0]) {
    const t = await fetch(`http://localhost:5194/api/files/${rows[0].id}/ticket`, { method: 'POST', headers: { authorization: `Bearer ${B.token}` } }).then((r) => r.json()).catch(() => null);
    check('a media ticket lasts long enough to play a voice note (≥ 10 min)', (t?.data?.expiresIn ?? 0) >= 600, `expiresIn=${t?.data?.expiresIn}`);
    await pool.query('DELETE FROM files WHERE id = $1', [rows[0].id]);
  } else check('a media ticket lasts long enough to play a voice note (≥ 10 min)', false, 'could not create a test file row');
} catch (e) { console.error('suite crashed:', e); results.push({ n: 'suite crashed', ok: false, d: String(e) }); }
finally {
  await browser?.close();
  try { await purgeUsers(pool, ids, { quiet: true }); } catch (e) { console.error('cleanup:', e.message); }
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  await pool.end(); process.exit(failed ? 1 : 0);
}
