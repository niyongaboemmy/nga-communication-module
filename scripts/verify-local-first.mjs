#!/usr/bin/env node
/**
 * Local first (P-02/P-03/P-09) and the split bundle (P-01), in a real browser.
 *
 *   - The conversation list, an opened conversation, the inbox and the home
 *     feed all render from the device on a reload with the network to the API
 *     cut: what the person saw is still there.
 *   - An unread conversation that was never opened is prefetched, so it opens
 *     offline too.
 *   - A warm open shows the conversation from the device before the network
 *     answers (the API is held back by 2.5 s and the message must show sooner).
 *   - Sign-out deletes the device copy.
 *   - Each module's code arrives as its own chunk, not with the first page.
 *
 *   npm run verify:local-first      (needs `npm run dev`)
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
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const API = 'http://localhost:5190', BASE = 'http://localhost:5194';
const results = []; const ids = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const wait = (loc, ms = 8000) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false);
const tag = randomBytes(3).toString('hex');

async function makeUser(name, roleName) {
  const id = `vlf-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = $1`, [roleName]);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`, [id, name, `${id}@amashuri.com`, roleName.toLowerCase(), rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: roleName.toLowerCase() };
  return { id, user, perms, roleName, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
const call = async (u, method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const send = (u, convId, body) => call(u, 'POST', `/api/chat/conversations/${convId}/messages`, { body, nonce: randomUUID() });

/** Cut (or delay) every API call except the auth stub; static assets and chunks still load. */
async function apiOffline(ctx, on) {
  await ctx.unroute('**/api/**').catch(() => {});
  if (on) await ctx.route('**/api/**', (route) => (route.request().url().includes('/api/sso/verify-mis')
    ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":{"valid":true}}' })
    : route.abort('internetdisconnected')));
  else await ctx.route('**/api/sso/verify-mis**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '{"success":true,"data":{"valid":true}}' }));
}

let browser;
try {
  const me = await makeUser(`Lena Local ${tag}`, 'Staff');
  const other = await makeUser(`Omar Other ${tag}`, 'Staff');
  const third = await makeUser(`Tess Third ${tag}`, 'Staff');

  const open = (await call(other, 'POST', '/api/chat/conversations', { type: 'group', name: `LF opened ${tag}`, memberIds: [me.id] })).body?.data?.conversation;
  const unopened = (await call(third, 'POST', '/api/chat/conversations', { type: 'group', name: `LF unread ${tag}`, memberIds: [me.id] })).body?.data?.conversation;
  if (!open || !unopened) throw new Error('could not create the test conversations');
  await send(other, open.id, `opened-message-${tag}`);
  await send(third, unopened.id, `prefetched-message-${tag}`);
  await call(other, 'POST', '/api/mail/compose', { to: [`userId:${me.id}`], subject: `LF mail ${tag}`, bodyHtml: '<p>hello</p>' });

  browser = prepareBrowser(await chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript((kv) => { if (!sessionStorage.getItem('vlf-seeded')) { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); sessionStorage.setItem('vlf-seeded', '1'); } }, {
    tupo_token: me.token, tupo_user: JSON.stringify(me.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: me.perms, name: me.roleName }) });
  const page = await ctx.newPage();
  const scripts = new Set();
  page.on('request', (r) => { if (r.resourceType() === 'script') scripts.add(new URL(r.url()).pathname); });

  console.log('\nFirst visit, online');
  await page.goto(`${BASE}/app/chat`);
  check('the conversation list loads', await wait(page.getByText(`LF opened ${tag}`).first(), 15000));
  await page.getByText(`LF opened ${tag}`).first().click();
  check('a conversation opens', await wait(page.getByText(`opened-message-${tag}`).first(), 10000));
  await page.goto(`${BASE}/app/mail`);
  check('the inbox loads', await wait(page.getByText(`LF mail ${tag}`).first(), 15000));
  await page.goto(`${BASE}/app/feed`);
  const feedUp = await wait(page.locator('main').getByRole('article').first(), 15000)
    || await wait(page.getByText(/No posts yet|Nothing here yet|Follow pages/i).first(), 3000);
  check('the feed loads', feedUp);
  // Give the debounced writers and the idle prefetch time to land.
  await page.waitForTimeout(4000);

  const chunks = [...scripts].filter((p) => /\/(src|assets)\//.test(p));
  const sawLazy = chunks.some((p) => /MailLayout|pages\/mail\/MailLayout/.test(p)) && chunks.some((p) => /ChatLayout|pages\/chat\/ChatLayout/.test(p));
  check('modules arrive as their own chunks', sawLazy, `${chunks.length} scripts`);

  console.log('\nReload with the API unreachable');
  await apiOffline(ctx, true);
  await page.goto(`${BASE}/app/chat`);
  check('the conversation list renders from the device', await wait(page.getByText(`LF opened ${tag}`).first(), 10000));
  await page.getByText(`LF opened ${tag}`).first().click();
  check('the opened conversation renders from the device', await wait(page.getByText(`opened-message-${tag}`).first(), 8000));
  await page.getByText(`LF unread ${tag}`).first().click();
  check('an unread conversation never opened was prefetched', await wait(page.getByText(`prefetched-message-${tag}`).first(), 8000));
  await page.goto(`${BASE}/app/mail`);
  check('the inbox renders from the device', await wait(page.getByText(`LF mail ${tag}`).first(), 10000));
  check('with no error in place of the list', !(await page.getByText(/Couldn.t load|could not load/i).first().isVisible().catch(() => false)));
  await page.goto(`${BASE}/app/feed`);
  check('the feed renders from the device (no error page)', !(await wait(page.getByRole('alert').filter({ hasText: /feed/i }).first(), 3000)));

  console.log('\nWarm open with a slow network');
  await ctx.unroute('**/api/**').catch(() => {});
  await ctx.route('**/api/**', async (route) => {
    if (route.request().url().includes('/api/sso/verify-mis')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":{"valid":true}}' });
    }
    await new Promise((r) => setTimeout(r, 2500));
    return route.continue().catch(() => {});
  });
  await page.goto(`${BASE}/app/chat`);
  const t0 = Date.now();
  const listFast = await wait(page.getByText(`LF opened ${tag}`).first(), 2400);
  check('the list shows before a 2.5 s API answers', listFast, `${Date.now() - t0} ms`);
  const t1 = Date.now();
  await page.getByText(`LF opened ${tag}`).first().click().catch(() => {});
  const msgFast = await wait(page.getByText(`opened-message-${tag}`).first(), 2400);
  check('the conversation shows before a 2.5 s API answers', msgFast, `${Date.now() - t1} ms`);
  await apiOffline(ctx, false);

  console.log('\nSign-out');
  const before = await page.evaluate(async () => (await indexedDB.databases?.() ?? []).map((d) => d.name).filter((n) => n?.startsWith('tupo-cache-')));
  check('the device copy is per account', before.includes(`tupo-cache-${me.id}`), before.join(', '));
  await page.evaluate(async () => {
    // What every sign-out path calls (lib/api clearSession), without leaving the page.
    const mod = await import('/src/lib/api.ts');
    mod.clearSession();
    await new Promise((r) => setTimeout(r, 800));
  });
  const after = await page.evaluate(async () => (await indexedDB.databases?.() ?? []).map((d) => d.name).filter((n) => n?.startsWith('tupo-cache-')));
  check('signing out deletes it', after.length === 0, after.join(', ') || 'none left');

  await pool.query('DELETE FROM conversations WHERE id = ANY($1)', [[open.id, unopened.id]]).catch(() => {});
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:local-first: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
