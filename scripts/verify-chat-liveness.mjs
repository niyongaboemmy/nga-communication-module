#!/usr/bin/env node
/**
 * Chat liveness (B-04): typing indicators expire per person, the open
 * conversation catches up after a disconnect, and the sidebar stays current.
 *
 *   npm run verify:chat:liveness      (needs `npm run dev`)
 */
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { purgeUsers } from './lib/purge.mjs';
import { io } from 'socket.io-client';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = process.env.OUT ?? '/tmp/verify-chat-liveness';
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
  const id = `vcv-${randomBytes(5).toString('hex')}`;
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




const typingText = (page) => page.evaluate(() => (document.body.innerText.match(/[A-Z][a-z]+ (is|are) typing/g) ?? []).join(' | '));
const sock = (u) => new Promise((res) => {
  const s = io('http://localhost:5191', { auth: { token: u.token }, transports: ['websocket'], reconnection: false });
  s.on('connect', () => res(s));
});

let browser;
const sockets = [];
try {
  const A = await makeUser('Ada Live');
  const B = await makeUser('Ben Live');
  const C = await makeUser('Cy Live');
  browser = await chromium.launch();
  const grp = (await call(A, 'POST', '/api/chat/conversations', { type: 'group', name: 'Live Lab', memberIds: [B.id, C.id] })).body.data.conversation.id;
  const other = (await call(A, 'POST', '/api/chat/conversations', { type: 'group', name: 'Other Lab', memberIds: [B.id] })).body.data.conversation.id;
  await call(A, 'POST', `/api/chat/conversations/${other}/messages`, { body: 'older activity', nonce: nonce() });
  await sleep(300);
  await call(A, 'POST', `/api/chat/conversations/${grp}/messages`, { body: 'newer activity', nonce: nonce() });

  const ctx = await ctxFor(browser, B);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/app/chat?c=${grp}`, { waitUntil: 'domcontentloaded' });
  await p.waitForLoadState('networkidle').catch(() => {});
  await sleep(1500);

  console.log('\n── Typing expires per person');
  const sa = await sock(A); const sc = await sock(C); sockets.push(sa, sc);
  for (const s of [sa, sc]) await new Promise((r) => s.emit('conversation:subscribe', { conversationIds: [grp] }, r));
  sa.emit('typing:start', { conversationId: grp, kind: 'typing' });
  await sleep(1200);
  check('B sees Ada typing', /Ada/.test(await typingText(p)), await typingText(p));
  sa.disconnect();                       // gone without a "stop"
  await sleep(9000);
  check('a typist who vanished without "stop" is cleared within seconds', !/Ada/.test(await typingText(p)), await typingText(p) || 'none');

  const sa2 = await sock(A); sockets.push(sa2);
  await new Promise((r) => sa2.emit('conversation:subscribe', { conversationIds: [grp] }, r));
  sa2.emit('typing:start', { conversationId: grp, kind: 'typing' });
  await sleep(800);
  // Cy keeps typing; Ada stops sending updates but never says "stop".
  for (let i = 0; i < 6; i++) { sc.emit('typing:start', { conversationId: grp, kind: 'typing' }); await sleep(1700); }
  const t = await typingText(p);
  check('one person keeps typing; the other’s stale entry still expires', /Cy/.test(t) && !/Ada/.test(t), t || 'none');
  sc.emit('typing:stop', { conversationId: grp });

  console.log('\n── Catch-up after a disconnect');
  await ctx.setOffline(true);
  await sleep(26000);                    // long enough for the socket to drop
  await call(A, 'POST', `/api/chat/conversations/${grp}/messages`, { body: 'SENT WHILE YOU WERE AWAY', nonce: nonce() });
  await ctx.setOffline(false);
  const caught = await p.getByText('SENT WHILE YOU WERE AWAY').first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  check('a message sent during a real disconnect appears in the open conversation', caught);

  console.log('\n── Sidebar stays current');
  const order = () => p.evaluate(() => [...document.querySelectorAll('li button')].map((b) => b.innerText.split('\n')[0]).filter((t) => /Lab$/.test(t)));
  const before = await order();
  await call(A, 'POST', `/api/chat/conversations/${other}/messages`, { body: 'FRESH IN OTHER', nonce: nonce() });
  await sleep(2000);
  const after = await order();
  check('a conversation with something new moves to the top', after[0] === 'Other Lab', `before=${before.join(' > ')} after=${after.join(' > ')}`);
  check('…and its preview shows the new message, though it is not open', await p.getByText('FRESH IN OTHER').first().isVisible().catch(() => false));
  await p.screenshot({ path: `${OUT}/sidebar.png` });
} catch (e) { console.error('suite crashed:', e); results.push({ n: 'suite crashed', ok: false, d: String(e) }); }
finally {
  sockets.forEach((s) => s.connected && s.disconnect());
  await browser?.close();
  try { await purgeUsers(pool, ids, { quiet: true }); } catch (e) { console.error('cleanup:', e.message); }
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  await pool.end(); process.exit(failed ? 1 : 0);
}
