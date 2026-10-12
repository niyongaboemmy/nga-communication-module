#!/usr/bin/env node
/**
 * Chat unread — end to end, as a person sees it (B-02).
 *
 * A acts through the API; B watches in a real browser. Covers the rules:
 *   - a conversation's badge counts main-flow messages only, live and after reload;
 *   - a thread reply shows as "N new" on the thread and on the Threads entry,
 *     and clears when the thread is read;
 *   - "also send to channel" counts once; mark as unread / mark all read work;
 *   - the rail, the phone tab bar and the tab title agree.
 *
 *   npm run verify:chat:unread      (needs `npm run dev`)
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
const OUT = process.env.OUT ?? '/tmp/verify-chat-unread';
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
  const id = `vcu-${randomBytes(5).toString('hex')}`;
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


const threadsBadge = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim().startsWith('Threads'));
  return b ? (b.querySelector('[aria-label*="unread"]')?.textContent ?? '').trim() : 'MISSING';
});
const repliesMarker = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /\d+ repl(y|ies)/.test(x.innerText));
  return b ? b.getAttribute('aria-label') : 'MISSING';
});

let browser;
try {
  const A = await makeUser('Ada Unread');
  const B = await makeUser('Ben Unread');
  const C = await makeUser('Cy Unread');
  browser = await chromium.launch();

  const dm = (await call(A, 'POST', '/api/chat/conversations/direct', { userId: B.id })).body.data.conversation.id;
  const grp = (await call(A, 'POST', '/api/chat/conversations', { type: 'group', name: 'Unread Lab', memberIds: [B.id, C.id] })).body.data.conversation.id;
  const seedB = (await call(B, 'POST', `/api/chat/conversations/${grp}/messages`, { body: 'question from ben', nonce: nonce() })).body.data.message;
  await call(A, 'POST', `/api/chat/conversations/${dm}/messages`, { body: 'hello ben', nonce: nonce() });

  const ctx = await ctxFor(browser, B);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/app/chat`, { waitUntil: 'domcontentloaded' });
  await p.waitForLoadState('networkidle').catch(() => {});
  await sleep(1500);
  await p.getByText('Unread Lab').first().click(); await sleep(1200);
  await p.getByText('Ada Unread').first().click(); await sleep(1200);

  console.log('\n── Main-flow messages');
  for (let i = 1; i <= 3; i++) await call(A, 'POST', `/api/chat/conversations/${grp}/messages`, { body: `bg ${i}`, nonce: nonce() });
  await sleep(1500);
  check('background conversation shows "3"', await rowBadge(p, 'Unread Lab') === '3', `badge="${await rowBadge(p, 'Unread Lab')}"`);
  check('desktop rail Chat icon shows the total', (await railChat(p)) === '3', `rail="${await railChat(p)}"`);
  check('tab title carries the total', /^\(3\)/.test(await p.title()), await p.title());
  await p.screenshot({ path: `${OUT}/1-background.png` });
  await p.getByText('Unread Lab').first().click(); await sleep(2000);
  check('opening clears the row badge', await rowBadge(p, 'Unread Lab') === '', `badge="${await rowBadge(p, 'Unread Lab')}"`);
  check('…and the rail badge', (await railChat(p)) === '', `rail="${await railChat(p)}"`);

  console.log('\n── Thread replies');
  await p.getByText('Ada Unread').first().click(); await sleep(1000);
  const tr = await call(A, 'POST', `/api/chat/conversations/${grp}/messages/${seedB.id}/replies`, { body: 'thread reply 1', nonce: nonce() });
  await sleep(1800);
  check('a thread reply does not badge the conversation', await rowBadge(p, 'Unread Lab') === '', `reply ${tr.status}; badge="${await rowBadge(p, 'Unread Lab')}" db=${JSON.stringify(await dbUnread(grp, B.id))}`);
  check('the Threads entry shows 1 new reply, live', await threadsBadge(p) === '1', `threads="${await threadsBadge(p)}"`);
  check('the rail counts the new reply', (await railChat(p)) === '1', `rail="${await railChat(p)}"`);
  check('the sidebar preview is not the thread reply', !(await p.evaluate(() => document.body.innerText.includes('Ada: thread reply 1'))));
  await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForLoadState('networkidle').catch(() => {}); await sleep(1800);
  check('after reload the same: no conversation badge, Threads "1"', (await rowBadge(p, 'Unread Lab')) === '' && (await threadsBadge(p)) === '1', `row="${await rowBadge(p, 'Unread Lab')}" threads="${await threadsBadge(p)}"`);
  await p.getByText('Unread Lab').first().click(); await sleep(1800);
  const marker = await repliesMarker(p);
  check('the thread root shows "1 new"', /1 new/.test(marker ?? ''), `marker="${marker}"`);
  await p.screenshot({ path: `${OUT}/2-thread-marker.png` });
  const blocked = await p.getByText(/1 repl/i).first().click({ timeout: 4000 }).then(() => false).catch(() => true);
  check('the replies link is clickable (no invisible toolbar over it)', !blocked);
  await sleep(2000);
  check('opening the thread clears the Threads badge', (await threadsBadge(p)) === '', `threads="${await threadsBadge(p)}"`);
  check('…and the marker on the root', !/new/.test((await repliesMarker(p)) ?? ''), `marker="${await repliesMarker(p)}"`);
  await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForLoadState('networkidle').catch(() => {}); await sleep(1800);
  check('after reading and reloading nothing is "new"', (await rowBadge(p, 'Unread Lab')) === '' && (await threadsBadge(p)) === '' && (await railChat(p)) === '', `row="${await rowBadge(p, 'Unread Lab')}" threads="${await threadsBadge(p)}" rail="${await railChat(p)}"`);
  await p.screenshot({ path: `${OUT}/3-all-read.png` });

  console.log('\n── Threads inbox');
  await call(C, 'POST', `/api/chat/conversations/${grp}/messages/${seedB.id}/replies`, { body: 'cy chimes in', nonce: nonce() });
  await p.getByText('Ada Unread').first().click(); await sleep(1500);
  await p.getByRole('button', { name: /^Threads/ }).first().click(); await sleep(1500);
  check('the Threads inbox lists the thread with "1 new"', await p.getByText('1 new').first().isVisible().catch(() => false));
  await p.screenshot({ path: `${OUT}/4-threads-inbox.png` });
  await p.getByText(/question from ben/).first().click(); await sleep(2000);
  check('a Threads inbox row opens the thread', await p.getByText('cy chimes in').first().isVisible().catch(() => false));
  check('…and clears its badge', (await threadsBadge(p)) === '', `threads="${await threadsBadge(p)}"`);

  console.log('\n── Thread reply also sent to the channel');
  await p.getByText('Ada Unread').first().click(); await sleep(1000);
  const b5 = await dbUnread(grp, B.id);
  await call(A, 'POST', `/api/chat/conversations/${grp}/messages/${seedB.id}/replies`, { body: 'reply and channel', alsoSendToChannel: true, nonce: nonce() });
  await sleep(1500);
  const a5 = await dbUnread(grp, B.id);
  check('counts once in the conversation', a5.unread_count - b5.unread_count === 1, `db ${b5.unread_count} → ${a5.unread_count}; badge="${await rowBadge(p, 'Unread Lab')}"`);

  console.log("\n── A thread reply does not mark the replier's channel read");
  await call(A, 'POST', `/api/chat/conversations/${grp}/messages`, { body: 'unread for ben', nonce: nonce() });
  await sleep(500);
  const before6 = await dbUnread(grp, B.id);
  await call(B, 'POST', `/api/chat/conversations/${grp}/messages/${seedB.id}/replies`, { body: 'ben replies in thread', nonce: nonce() });
  await sleep(800);
  const after6 = await dbUnread(grp, B.id);
  check("replying in a thread keeps B's unread channel messages unread", after6.unread_count === before6.unread_count && after6.unread_count > 0, `${before6.unread_count} → ${after6.unread_count}`);

  console.log('\n── Mark as read / unread, mark all read');
  // A pointer user hovers the row to reveal its "…" button.
  await p.locator('li', { hasText: 'Unread Lab' }).first().hover();
  await p.getByRole('button', { name: 'Actions for Unread Lab' }).click(); await sleep(400);
  await p.getByRole('menuitem', { name: 'Mark as read' }).click(); await sleep(1200);
  check('row menu "Mark as read" clears the badge', await rowBadge(p, 'Unread Lab') === '', `badge="${await rowBadge(p, 'Unread Lab')}" db=${JSON.stringify(await dbUnread(grp, B.id))}`);
  // Right-click (long-press on a phone) opens the same menu.
  await p.locator('li', { hasText: 'Unread Lab' }).first().locator('button').first().click({ button: 'right' }); await sleep(400);
  check('right-click / long-press opens the row menu', await p.getByRole('menu', { name: 'Actions for Unread Lab' }).isVisible().catch(() => false));
  await p.getByRole('menuitem', { name: 'Mark as unread' }).click(); await sleep(1200);
  check('row menu "Mark as unread" brings back a badge of 1', await rowBadge(p, 'Unread Lab') === '1', `badge="${await rowBadge(p, 'Unread Lab')}"`);
  await call(A, 'POST', `/api/chat/conversations/${dm}/messages`, { body: 'dm again', nonce: nonce() });
  await sleep(1200);
  const markAll = p.getByRole('button', { name: 'Mark all as read' });
  check('a visible "Mark all as read" button appears when something is unread', await markAll.isVisible().catch(() => false));
  await markAll.click().catch(() => {}); await sleep(1500);
  check('it clears every badge', (await rowBadge(p, 'Unread Lab')) === '' && (await rowBadge(p, 'Ada Unread')) === '' && (await railChat(p)) === '', `group="${await rowBadge(p, 'Unread Lab')}" dm="${await rowBadge(p, 'Ada Unread')}" rail="${await railChat(p)}"`);

  console.log('\n── Muted conversation');
  await call(B, 'PATCH', `/api/chat/conversations/${grp}/prefs`, { notification: 'none' });
  await sleep(600);
  await call(A, 'POST', `/api/chat/conversations/${grp}/messages`, { body: 'muted msg', nonce: nonce() });
  await sleep(1200);
  check('a muted conversation has no number and adds nothing to the rail', (await rowBadge(p, 'Unread Lab')) === '' && (await railChat(p)) === '', `row="${await rowBadge(p, 'Unread Lab')}" rail="${await railChat(p)}"`);
  await call(B, 'PATCH', `/api/chat/conversations/${grp}/prefs`, { notification: 'all' });
  await call(B, 'POST', '/api/chat/read-all', {});

  console.log('\n── Phone');
  // Close the desktop tab first: with the DM open there, it would (correctly)
  // mark the new message read on every device the moment it arrived.
  await ctx.close();
  const m = await ctxFor(browser, B, { width: 390, height: 844 });
  const mp = await m.newPage();
  await mp.goto(`${BASE}/app/feed`, { waitUntil: 'domcontentloaded' }); await mp.waitForLoadState('networkidle').catch(() => {}); await sleep(1500);
  await call(A, 'POST', `/api/chat/conversations/${dm}/messages`, { body: 'mobile ping', nonce: nonce() });
  await sleep(1800);
  const tabBadge = await railChat(mp);
  check('bottom "Chat" tab shows the count while on Feed', tabBadge === '1', `tab="${tabBadge}"`);
  await mp.screenshot({ path: `${OUT}/5-phone.png` });
} catch (e) { console.error('suite crashed:', e); results.push({ n: 'suite crashed', ok: false, d: String(e) }); }
finally {
  await browser?.close();
  try { await purgeUsers(pool, ids, { quiet: true }); } catch (e) { console.error('cleanup:', e.message); }
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  await pool.end(); process.exit(failed ? 1 : 0);
}
