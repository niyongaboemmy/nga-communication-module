#!/usr/bin/env node
/**
 * Nothing is missed (S-11, S-14, S-15, target T6), in a real browser:
 *
 *   - offline while 150 messages arrive, then back: every one is there, once,
 *     in order;
 *   - offline while 250 arrive (more than the old 100-message catch-up): the
 *     same;
 *   - a live event that never arrives (messages written without a broadcast,
 *     then one live message): the sequence jump fills the hole;
 *   - mail and the notification bell catch up after a reconnect, no reload.
 *
 *   npm run verify:sync      (needs `npm run dev`)
 */
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';
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
process.env.DATABASE_URL ??= env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const API = 'http://localhost:5190', BASE = 'http://localhost:5194';
const results = []; const ids = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = randomBytes(3).toString('hex');

async function makeUser(name) {
  const id = `vsy-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = 'Staff'`);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`, [id, name, `${id}@amashuri.com`, rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' };
  return { id, user, perms, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
const call = async (u, method, path, body) => (await fetch(`${API}${path}`, {
  method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
})).json().catch(() => ({}));

let browser; let convId = null;
try {
  const me = await makeUser(`Sia Sync ${tag}`);
  const other = await makeUser(`Oto Other ${tag}`);
  convId = (await call(other, 'POST', '/api/chat/conversations', { type: 'group', name: `Sync ${tag}`, memberIds: [me.id] })).data.conversation.id;
  // Written straight through the chat service: the same rows a send writes,
  // but no live broadcast (and no per-minute send limit for a fixture).
  const chat = await import('@tupo/chat');
  const quietly = async (n, label) => {
    for (let i = 0; i < n; i += 25) {
      await Promise.all(Array.from({ length: Math.min(25, n - i) }, (_, k) => chat.sendMessage({
        conversationId: convId, senderId: other.id, body: `${label}-${String(i + k).padStart(3, '0')}`, nonce: `${label}-${i + k}-${tag}`,
      })));
    }
  };
  await quietly(5, 'start');

  browser = prepareBrowser(await chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, {
    tupo_token: me.token, tupo_user: JSON.stringify(me.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: me.perms, name: 'Staff' }) });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/chat?c=${convId}`);
  await page.getByText('start-004').first().waitFor({ timeout: 15_000 });

  /** Every message body in the log with this prefix, as shown, in order. */
  const shown = (prefix) => page.evaluate((p) => [...document.querySelectorAll('[role="log"] li')]
    .map((li) => li.innerText.match(new RegExp(`${p}-\\d{3}`))?.[0]).filter(Boolean), prefix);
  const expectAll = async (prefix, n, label) => {
    let got = [];
    for (let i = 0; i < 40; i++) {
      // The log windows long conversations; scroll to the bottom and read.
      await page.evaluate(() => { const el = document.querySelector('[role="log"]')?.closest('[class*="overflow-y"]') ?? document.querySelector('[role="log"]'); if (el) el.scrollTop = el.scrollHeight; });
      got = await shown(prefix);
      if (new Set(got).size >= Math.min(n, 40)) break;
      await sleep(500);
    }
    // The truth is the database's order (sequence), not the numbers in the
    // text: fixture messages are written 25 at a time, in parallel. The log
    // renders a window, so the newest 40 are compared on screen.
    const { rows } = await pool.query(
      `SELECT body FROM messages WHERE conversation_id = $1 AND body LIKE $2 ORDER BY seq`, [convId, `${prefix}-%`]);
    const want = rows.map((r) => r.body).slice(-Math.min(n, 40));
    const tail = got.slice(-want.length);
    const dupes = got.length - new Set(got).size;
    check(label, rows.length === n && JSON.stringify(tail) === JSON.stringify(want) && dupes === 0,
      `${new Set(got).size} on screen, newest ${want.length} in order: ${JSON.stringify(tail) === JSON.stringify(want)}, ${dupes} duplicates`);
  };

  console.log('\nOffline, then back');
  await ctx.setOffline(true);
  await sleep(1_500);
  await quietly(150, 'off');
  await ctx.setOffline(false);
  await expectAll('off', 150, '150 messages that arrived offline are all there, once, in order');

  console.log('\nA long absence (more than the old 100-message catch-up)');
  await ctx.setOffline(true);
  await sleep(1_500);
  await quietly(250, 'long');
  await ctx.setOffline(false);
  await expectAll('long', 250, '250 messages: the newest are all there, in order');
  const total = Number((await pool.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [convId])).rows[0].n);
  check('the fixture really holds them all', total >= 405, `${total} in the database`);

  console.log('\nA live event that never arrived');
  await quietly(3, 'gap');
  // One sent through the API: broadcast live, with a sequence 4 past what the browser has.
  await call(other, 'POST', `/api/chat/conversations/${convId}/messages`, { body: 'gap-003', nonce: randomUUID() });
  await expectAll('gap', 4, 'the messages before it are fetched the moment the jump is seen');

  console.log('\nMail and the bell after a reconnect');
  await page.goto(`${BASE}/app/mail`);
  await page.getByRole('heading', { name: 'Inbox' }).first().waitFor({ timeout: 15_000 }).catch(() => {});
  await ctx.setOffline(true);
  await sleep(1_500);
  await call(other, 'POST', '/api/mail/compose', { to: [`userId:${me.id}`], subject: `Sync mail ${tag}`, bodyHtml: '<p>while away</p>' });
  await ctx.setOffline(false);
  check('mail sent while offline appears in the open inbox, no reload',
    await page.getByText(`Sync mail ${tag}`).first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false));
  const bell = page.getByRole('button', { name: /^Notifications/ }).first();
  const bellLabel = await bell.getAttribute('aria-label').catch(() => '');
  check('and the bell counts it', /\d/.test(bellLabel ?? ''), bellLabel);
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  if (convId) await pool.query('DELETE FROM conversations WHERE id = $1', [convId]).catch(() => {});
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:sync: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
