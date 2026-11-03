#!/usr/bin/env node
/**
 * Gap-analysis probe (round 2): chat unread counters end to end, as a user
 * sees them. A acts through the API; B watches in a real browser.
 * Needs `npm run dev`. OUT=<dir> for screenshots + unread-results.json.
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
const OUT = process.env.OUT ?? '/tmp/gap2-unread';
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
  const id = `gapr-${randomBytes(5).toString('hex')}`;
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
  const a = [...document.querySelectorAll('a[href$="/app/chat"], a[href*="/app/chat"]')];
  return a.map((x) => (x.querySelector('[aria-label*="unread"]')?.textContent ?? '').trim()).filter(Boolean).join(',') || '';
});
const dbUnread = async (convId, userId) => (await pool.query('SELECT unread_count, unread_mentions, last_read_seq FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [convId, userId])).rows[0];
const apiUnread = async (u, convId) => (await call(u, 'GET', '/api/chat/conversations')).body?.data?.conversations?.find((c) => c.id === convId)?.unread;

let browser;
try {
  const A = await makeUser('Ada Unread');
  const B = await makeUser('Ben Unread');
  const C = await makeUser('Cy Unread');
  browser = await chromium.launch();

  // Two conversations for B: DM with A, group "Unread Lab" with A + C.
  const dm = (await call(A, 'POST', '/api/chat/conversations/direct', { userId: B.id })).body.data.conversation.id;
  const grp = (await call(A, 'POST', '/api/chat/conversations', { type: 'group', name: 'Unread Lab', memberIds: [B.id, C.id] })).body.data.conversation.id;
  const seedMsg = (await call(A, 'POST', `/api/chat/conversations/${grp}/messages`, { body: 'group seed', nonce: nonce() })).body.data.message;

  const ctx = await ctxFor(browser, B);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/app/chat`, { waitUntil: 'domcontentloaded' });
  await p.waitForLoadState('networkidle').catch(() => {});
  await sleep(1500);
  // B starts by reading the group so both start at zero.
  await p.getByText('Unread Lab').first().click(); await sleep(1500);
  await p.getByText('Ada Unread').first().click(); await sleep(1200);
  // Park B in the DM so the group is a background conversation.
  console.log('\n── 1. Background conversation counts up live');
  for (let i = 1; i <= 3; i++) await call(A, 'POST', `/api/chat/conversations/${grp}/messages`, { body: `bg ${i}`, nonce: nonce() });
  await sleep(1500);
  check('sidebar row shows "3" for 3 new messages in a background conversation', await rowBadge(p, 'Unread Lab') === '3', `badge="${await rowBadge(p, 'Unread Lab')}" db=${JSON.stringify(await dbUnread(grp, B.id))}`);
  check('app rail / nav Chat icon shows a total unread badge', (await railChat(p)) !== '', `rail badge="${await railChat(p)}"`);
  const title = await p.title();
  check('browser tab title carries the unread count', /\(\d+\)/.test(title), `title="${title}"`);
  await p.screenshot({ path: `${OUT}/1-background-unread.png` });

  console.log('\n── 2. Opening clears it');
  await p.getByText('Unread Lab').first().click(); await sleep(2000);
  check('badge clears after opening and seeing the messages', await rowBadge(p, 'Unread Lab') === '', `badge="${await rowBadge(p, 'Unread Lab')}" db=${JSON.stringify(await dbUnread(grp, B.id))}`);

  console.log('\n── 3. Quote-reply (replyToId) in a background conversation');
  await p.getByText('Ada Unread').first().click(); await sleep(1000);
  await call(A, 'POST', `/api/chat/conversations/${grp}/messages`, { body: 'quoting you', replyToId: seedMsg.id, nonce: nonce() });
  await sleep(1500);
  check('quote-reply counts as 1 unread in the sidebar', await rowBadge(p, 'Unread Lab') === '1', `badge="${await rowBadge(p, 'Unread Lab')}"`);
  await p.getByText('Unread Lab').first().click(); await sleep(2000);
  check('quote-reply badge clears on open', await rowBadge(p, 'Unread Lab') === '', `badge="${await rowBadge(p, 'Unread Lab')}"`);

  console.log('\n── 4. Thread reply in a background conversation');
  await p.getByText('Ada Unread').first().click(); await sleep(1000);
  const before = await dbUnread(grp, B.id);
  const tr = await call(A, 'POST', `/api/chat/conversations/${grp}/messages/${seedMsg.id}/replies`, { body: 'thread reply 1', nonce: nonce() });
  await sleep(1800);
  const after = await dbUnread(grp, B.id);
  const liveBadge = await rowBadge(p, 'Unread Lab');
  check('thread reply updates the sidebar badge live', liveBadge !== '', `reply ${tr.status}; live badge="${liveBadge}"; db unread ${before?.unread_count} → ${after?.unread_count}`);
  await p.screenshot({ path: `${OUT}/4-thread-reply-live.png` });
  await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForLoadState('networkidle').catch(() => {}); await sleep(1800);
  const afterReload = await rowBadge(p, 'Unread Lab');
  check('live badge and badge-after-reload agree (no phantom counts)', afterReload === liveBadge, `live="${liveBadge}" after reload="${afterReload}"`);
  await p.getByText('Unread Lab').first().click(); await sleep(2500);
  const openedThreadCase = await rowBadge(p, 'Unread Lab');
  check('opening the conversation clears a thread-reply unread', openedThreadCase === '', `badge="${openedThreadCase}" db=${JSON.stringify(await dbUnread(grp, B.id))}`);
  await p.screenshot({ path: `${OUT}/4-after-open.png` });
  // try opening the thread itself
  const repliesLink = p.getByText(/1 repl/i).first();
  const blocked = await repliesLink.click({ timeout: 3000 }).then(() => false).catch(() => true); check('the "N replies" link is clickable (not covered by the invisible hover toolbar)', !blocked); if (blocked) await repliesLink.dispatchEvent('click'); await sleep(2000); await p.screenshot({ path: `${OUT}/4-thread-open.png` });
  await p.getByText('Ada Unread').first().click(); await sleep(1200);
  const afterThreadOpen = await rowBadge(p, 'Unread Lab');
  check('opening the thread panel clears it', afterThreadOpen === '', `badge="${afterThreadOpen}" db=${JSON.stringify(await dbUnread(grp, B.id))}`);
  await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForLoadState('networkidle').catch(() => {}); await sleep(1800);
  const sticky = await rowBadge(p, 'Unread Lab');
  check('after reading everything and reloading, the conversation is not "new" again', sticky === '', `badge after reload="${sticky}" api unread=${await apiUnread(B, grp)}`);
  await p.screenshot({ path: `${OUT}/4-sticky-after-reload.png` });

  console.log('\n── 5. Thread reply + "also send to channel"');
  const b5 = await dbUnread(grp, B.id);
  await call(A, 'POST', `/api/chat/conversations/${grp}/messages/${seedMsg.id}/replies`, { body: 'reply and channel', alsoSendToChannel: true, nonce: nonce() });
  await sleep(1500);
  const a5 = await dbUnread(grp, B.id);
  check('one reply also sent to channel counts as 1 unread, not 2', (a5.unread_count - b5.unread_count) === 1, `db unread ${b5.unread_count} → ${a5.unread_count}; badge="${await rowBadge(p, 'Unread Lab')}"`);

  console.log('\n── 6. Open conversation, new message arrives while B is scrolled up');
  await p.getByText('Unread Lab').first().click(); await sleep(1500);
  for (let i = 0; i < 25; i++) await call(A, 'POST', `/api/chat/conversations/${grp}/messages`, { body: `filler ${i}\nline two\nline three`, nonce: nonce() });
  await sleep(2500);
  await p.evaluate(() => { const s = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 200 && getComputedStyle(d).overflowY === 'auto' && d.closest('section')); if (s) s.scrollTop = 0; });
  await sleep(1200);
  await call(A, 'POST', `/api/chat/conversations/${grp}/messages`, { body: 'arrived while scrolled up', nonce: nonce() });
  await sleep(1500);
  const jump = await p.getByText(/new message|jump to|latest/i).first().isVisible().catch(() => false);
  check('scrolled-up reader sees a "new messages / jump to latest" cue', jump);
  check('message not marked read while scrolled up', (await dbUnread(grp, B.id)).unread_count >= 1, `db=${JSON.stringify(await dbUnread(grp, B.id))}`);
  await p.screenshot({ path: `${OUT}/6-scrolled-up.png` });

  console.log('\n── 7. Mark all as read');
  await p.getByText('Ada Unread').first().click(); await sleep(800);
  for (let i = 0; i < 2; i++) await call(A, 'POST', `/api/chat/conversations/${dm}/messages`, { body: `dm ${i}`, nonce: nonce() });
  await call(C, 'POST', `/api/chat/conversations/${grp}/messages`, { body: 'from cy', nonce: nonce() });
  await sleep(1200);
  const ra = await call(B, 'POST', '/api/chat/read-all', {});
  await sleep(1500);
  check('mark-all-read clears every sidebar badge live', (await rowBadge(p, 'Unread Lab')) === '' && (await rowBadge(p, 'Ada Unread')) === '', `read-all ${ra.status}; group="${await rowBadge(p, 'Unread Lab')}" dm="${await rowBadge(p, 'Ada Unread')}"`);
  const uiMarkAll = await p.getByRole('button', { name: /mark (all|everything).*read/i }).first().isVisible().catch(() => false);
  check('a visible "Mark all as read" control exists in the chat UI', uiMarkAll);

  console.log('\n── 8. Muted conversation');
  await call(B, 'PATCH', `/api/chat/conversations/${grp}/prefs`, { notification: 'none' });
  await sleep(600);
  await call(A, 'POST', `/api/chat/conversations/${grp}/messages`, { body: 'muted msg', nonce: nonce() });
  await sleep(1200);
  const mutedBadge = await rowBadge(p, 'Unread Lab');
  const boldName = await p.evaluate(() => { const b = [...document.querySelectorAll('li button')].find((x) => x.innerText.includes('Unread Lab')); return b ? getComputedStyle(b.querySelector('.truncate')).fontWeight : ''; });
  check('muted conversation still signals unread quietly (bold/dot, no number)', mutedBadge === '' && Number(boldName) >= 600, `badge="${mutedBadge}" nameWeight=${boldName}`);

  console.log('\n── 9. Second tab / device consistency');
  const p2 = await ctx.newPage();
  await p2.goto(`${BASE}/app/chat`, { waitUntil: 'domcontentloaded' }); await p2.waitForLoadState('networkidle').catch(() => {}); await sleep(1500);
  await call(B, 'PATCH', `/api/chat/conversations/${grp}/prefs`, { notification: 'all' });
  await call(A, 'POST', `/api/chat/conversations/${dm}/messages`, { body: 'two tabs', nonce: nonce() });
  await sleep(1500);
  const t1 = await rowBadge(p, 'Ada Unread'), t2 = await rowBadge(p2, 'Ada Unread');
  await p2.getByText('Ada Unread').first().click(); await sleep(2000);
  check('reading in tab 2 clears the badge in tab 1', (await rowBadge(p, 'Ada Unread')) === '', `before: tab1="${t1}" tab2="${t2}"; after: tab1="${await rowBadge(p, 'Ada Unread')}"`);

  console.log('\n── 10. Mobile tab bar & dock');
  const m = await ctxFor(browser, B, { width: 390, height: 844 });
  const mp = await m.newPage();
  await mp.goto(`${BASE}/app/feed`, { waitUntil: 'domcontentloaded' }); await mp.waitForLoadState('networkidle').catch(() => {}); await sleep(1500);
  await call(A, 'POST', `/api/chat/conversations/${dm}/messages`, { body: 'mobile ping', nonce: nonce() });
  await sleep(1800);
  const tabBadge = await mp.evaluate(() => [...document.querySelectorAll('nav a')].filter((a) => /chat/i.test(a.innerText)).map((a) => a.querySelector('[aria-label*="unread"]')?.textContent ?? '').join(','));
  const dockBadge = await mp.evaluate(() => [...document.querySelectorAll('button')].filter((b) => /chat|messages/i.test(b.getAttribute('aria-label') ?? '')).map((b) => b.innerText.trim()).join('|'));
  check('mobile bottom tab "Chat" shows unread count while on Feed', /\d/.test(tabBadge), `tab badge="${tabBadge}"`);
  check('floating chat launcher (dock) shows unread count', /\d/.test(dockBadge), `dock="${dockBadge}"`);
  await mp.screenshot({ path: `${OUT}/10-mobile-feed.png` });
} catch (e) { console.error('probe crashed:', e); }
finally {
  await browser?.close();
  try { await purgeUsers(pool, ids, { quiet: true }); } catch (e) { console.error('cleanup:', e.message); }
  writeFileSync(`${OUT}/unread-results.json`, JSON.stringify(results, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
  await pool.end(); process.exit(0);
}
