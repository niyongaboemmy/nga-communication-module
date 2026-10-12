#!/usr/bin/env node
/**
 * Chat links — every way into a conversation lands where it says (F-05).
 *
 *   ?c=  ?c=&m=  ?c=&thread=  ?dm=  /app/chat/:id/:msg  /app/chat/invite/:code,
 *   reload keeps the open conversation, phone Back returns to the list, and a
 *   thread reply notifies the thread (not the room) with a working link.
 *
 *   npm run verify:chat:links      (needs `npm run dev`)
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
const OUT = process.env.OUT ?? '/tmp/verify-chat-links';
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
  const id = `vcl-${randomBytes(5).toString('hex')}`;
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



const openName = (page) => page.evaluate(() => document.querySelector('section[aria-label]')?.getAttribute('aria-label') ?? '');

let browser;
try {
  const A = await makeUser('Ada Links');
  const B = await makeUser('Ben Links');
  const C = await makeUser('Cy Links');
  browser = await chromium.launch();

  const first = (await call(A, 'POST', '/api/chat/conversations', { type: 'group', name: 'Alpha Group', memberIds: [B.id] })).body.data.conversation.id;
  const second = (await call(A, 'POST', '/api/chat/conversations', { type: 'group', name: 'Beta Group', memberIds: [B.id, C.id] })).body.data.conversation.id;
  await call(A, 'POST', `/api/chat/conversations/${second}/messages`, { body: 'beta hello', nonce: nonce() });
  let target;
  for (let i = 0; i < 60; i++) {
    const r = await call(A, 'POST', `/api/chat/conversations/${second}/messages`, { body: i === 5 ? 'NEEDLE MESSAGE' : `filler ${i}`, nonce: nonce() });
    if (i === 5) target = r.body.data.message.id;
  }
  // Alpha is newest, so it is what "open the first one" would pick.
  const root = (await call(A, 'POST', `/api/chat/conversations/${first}/messages`, { body: 'alpha root', nonce: nonce() })).body.data.message;

  const ctx = await ctxFor(browser, B);
  const p = await ctx.newPage();

  console.log('\n── Query links');
  await p.goto(`${BASE}/app/chat?c=${second}`, { waitUntil: 'domcontentloaded' });
  await p.waitForLoadState('networkidle').catch(() => {}); await sleep(1500);
  check('?c= opens that conversation, not the first one', await openName(p) === 'Beta Group', `open="${await openName(p)}"`);
  await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForLoadState('networkidle').catch(() => {}); await sleep(1500);
  check('reload keeps the open conversation', await openName(p) === 'Beta Group', `open="${await openName(p)}" url=${p.url()}`);

  await p.goto(`${BASE}/app/chat?c=${second}&m=${target}`, { waitUntil: 'domcontentloaded' });
  await p.waitForLoadState('networkidle').catch(() => {}); await sleep(2500);
  const needle = p.getByText('NEEDLE MESSAGE').first();
  const inView = await needle.isVisible().catch(() => false) && await needle.evaluate((el) => {
    const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight;
  }).catch(() => false);
  check('?c=&m= opens at that message (older than the first page)', inView);
  check('…and tidies the URL afterwards', !p.url().includes('m='), p.url());

  await p.goto(`${BASE}/app/chat?dm=${A.id}`, { waitUntil: 'domcontentloaded' });
  await p.waitForLoadState('networkidle').catch(() => {}); await sleep(2500);
  check('?dm= opens a DM with that person', await openName(p) === 'Ada Links', `open="${await openName(p)}" url=${p.url()}`);

  console.log('\n── Path links');
  await p.goto(`${BASE}/app/chat/${second}/${target}`, { waitUntil: 'domcontentloaded' });
  await p.waitForLoadState('networkidle').catch(() => {}); await sleep(2500);
  check('/app/chat/:id/:msg (copy link) opens the conversation at the message', await openName(p) === 'Beta Group' && await p.getByText('NEEDLE MESSAGE').first().isVisible().catch(() => false), `open="${await openName(p)}"`);

  const lone = (await call(A, 'POST', '/api/chat/conversations', { type: 'channel', name: `invite-${nonce().slice(0, 6)}`, visibility: 'private' })).body.data.conversation.id;
  const inv = await call(A, 'POST', `/api/chat/conversations/${lone}/invites`, {});
  const code = inv.body?.data?.invite?.code;
  await p.goto(`${BASE}/app/chat/invite/${code}`, { waitUntil: 'domcontentloaded' });
  await p.waitForLoadState('networkidle').catch(() => {}); await sleep(2500);
  check('/app/chat/invite/:code joins and opens the channel', (await openName(p)).startsWith('invite-'), `invite ${inv.status}; open="${await openName(p)}" url=${p.url()}`);
  await p.goto(`${BASE}/app/chat/invite/not-a-real-code`, { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  check('a dead invite says so instead of bouncing to the Feed', await p.getByText("This invite can't be used").isVisible().catch(() => false), p.url());

  console.log('\n── Thread links and thread notifications');
  await call(B, 'POST', `/api/chat/conversations/${first}/messages/${root.id}/replies`, { body: 'ben follows', nonce: nonce() });
  const before = (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'chat.thread'", [B.id])).rows[0].n;
  await call(A, 'POST', `/api/chat/conversations/${first}/messages/${root.id}/replies`, { body: 'ada answers ben', nonce: nonce() });
  await sleep(800);
  const n = (await pool.query("SELECT kind, title, link FROM notifications WHERE user_id = $1 AND kind = 'chat.thread' ORDER BY created_at DESC LIMIT 1", [B.id])).rows[0];
  check('a follower is told "replied in a thread", not "mentioned you"', !!n && /replied in a thread/.test(n.title), JSON.stringify(n));
  const noisy = (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND link LIKE $2", [C.id, `%${first}%`])).rows[0].n;
  check('someone who is not in the thread is not notified', noisy === 0, `notifications for C about Alpha: ${noisy}`);
  await p.goto(`${BASE}${n?.link ?? '/app/chat'}`, { waitUntil: 'domcontentloaded' });
  await p.waitForLoadState('networkidle').catch(() => {}); await sleep(2500);
  check('the notification link opens the conversation with the thread', await p.getByRole('complementary', { name: 'Thread' }).isVisible().catch(() => false) && await p.getByText('ada answers ben').first().isVisible().catch(() => false), `url=${p.url()} before=${before}`);

  console.log('\n── Phone history');
  await ctx.close();
  const m = await ctxFor(browser, B, { width: 390, height: 844 });
  const mp = await m.newPage();
  await mp.goto(`${BASE}/app/feed`, { waitUntil: 'domcontentloaded' }); await mp.waitForLoadState('networkidle').catch(() => {}); await sleep(1200);
  await mp.locator('nav a[href="/app/chat"]').filter({ visible: true }).first().click(); await sleep(1500);
  await mp.getByText('Beta Group').first().click(); await sleep(1500);
  check('opening a conversation on a phone shows it', await openName(mp) === 'Beta Group');
  await mp.goBack(); await sleep(1500);
  check('Back returns to the conversation list, not the Feed', mp.url().endsWith('/app/chat') && await mp.getByText('Alpha Group').first().isVisible().catch(() => false), mp.url());
  await mp.getByText('Beta Group').first().click(); await sleep(1500);
  await mp.getByRole('button', { name: /back/i }).first().click(); await sleep(1200);
  check('the in-app back button also returns to the list', mp.url().endsWith('/app/chat'), mp.url());
  await mp.goBack(); await sleep(1500);
  check('one more Back leaves Chat for where the person came from', mp.url().includes('/app/feed'), mp.url());
  await mp.screenshot({ path: `${OUT}/phone-history.png` });
} catch (e) { console.error('suite crashed:', e); results.push({ n: 'suite crashed', ok: false, d: String(e) }); }
finally {
  await browser?.close();
  try { await purgeUsers(pool, ids, { quiet: true }); } catch (e) { console.error('cleanup:', e.message); }
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  await pool.end(); process.exit(failed ? 1 : 0);
}
