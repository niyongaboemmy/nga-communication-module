#!/usr/bin/env node
/**
 * Everyday taps answer at once (P-04), in a real browser, with every write to
 * the API held back 2.5 s: the screen must change within half a second, long
 * before the server answers. And a refused action must put itself back and
 * say so.
 *
 *   Mail: star from the list, archive from the list (the row leaves), a label
 *         ticked in a thread, a star the server refuses (it unfills + a toast).
 *   Chat: a poll vote.
 *   Feed: follow a page from the directory.
 *
 *   npm run verify:optimistic      (needs `npm run dev`)
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
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const tag = randomBytes(3).toString('hex');
const FAST = 500;
const SLOW = 2_500;

async function makeUser(name, roleName) {
  const id = `vop-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = $1`, [roleName]);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`, [id, name, `${id}@amashuri.com`, roleName.toLowerCase(), rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: roleName.toLowerCase() };
  return { id, user, perms, roleName, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
const call = async (u, method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({}));
};
/** How long until `locator` matches, or -1 if not within `ms`. */
const within = async (locator, ms = FAST) => {
  const t = Date.now();
  return locator.waitFor({ state: 'visible', timeout: ms }).then(() => Date.now() - t).catch(() => -1);
};

let browser; const cleanup = [];
try {
  const me = await makeUser(`Olu Optimist ${tag}`, 'Admin');
  const other = await makeUser(`Sena Sender ${tag}`, 'Staff');
  for (const n of [1, 2]) await call(other, 'POST', '/api/mail/compose', { to: [`userId:${me.id}`], subject: `Opt mail ${n} ${tag}`, bodyHtml: '<p>hi</p>' });
  const label = (await call(me, 'POST', '/api/mail/labels', { name: `Opt ${tag}`, color: '#2563eb' }))?.data?.label;
  const conv = (await call(other, 'POST', '/api/chat/conversations', { type: 'group', name: `Opt chat ${tag}`, memberIds: [me.id] })).data.conversation;
  await call(other, 'POST', `/api/chat/conversations/${conv.id}/polls`, { question: `Lunch ${tag}?`, options: ['Rice', 'Beans'] });
  // Pages need FEED_PAGE_MANAGE; someone other than the follower creates it.
  const creator = await makeUser(`Cleo Creator ${tag}`, 'Admin');
  const page = (await call(creator, 'POST', '/api/feed/pages', { name: `Opt page ${tag}`, kind: 'club' })).data?.page;
  if (!page) throw new Error('could not create the test page');
  cleanup.push(() => pool.query('DELETE FROM conversations WHERE id = $1', [conv.id]));
  if (page) cleanup.push(() => pool.query('DELETE FROM feed_pages WHERE id = $1', [page.id]));

  browser = prepareBrowser(await chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, {
    tupo_token: me.token, tupo_user: JSON.stringify(me.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: me.perms, name: me.roleName }) });
  let refuse = null; // a URL fragment the "server" refuses
  await ctx.route('**/api/**', async (route) => {
    const req = route.request();
    if (req.url().includes('/api/sso/verify-mis')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":{"valid":true}}' });
    }
    if (req.method() === 'GET') return route.continue();
    await new Promise((r) => setTimeout(r, SLOW));
    if (refuse && req.url().includes(refuse)) {
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"message":"Refused for the test."}' });
    }
    return route.continue().catch(() => {});
  });
  const page1 = await ctx.newPage();

  console.log('\nMail (writes held back 2.5 s)');
  await page1.goto(`${BASE}/app/mail`);
  const row = (n) => page1.locator('li').filter({ hasText: `Opt mail ${n} ${tag}` }).first();
  await row(1).waitFor({ timeout: 15_000 });
  await row(1).getByRole('button', { name: 'Star', exact: true }).click();
  check('a star fills before the server answers', await within(row(1).getByRole('button', { name: 'Unstar', exact: true })) >= 0);
  await row(2).hover();
  await row(2).getByRole('button', { name: 'Archive', exact: true }).first().click();
  const gone = await row(2).waitFor({ state: 'detached', timeout: FAST }).then(() => true).catch(() => false);
  check('an archived conversation leaves the list at once', gone);
  await page1.waitForTimeout(SLOW + 1_000);
  check('and stays gone once the server has answered', !(await row(2).isVisible().catch(() => false)));

  refuse = '/star';
  await row(1).getByRole('button', { name: 'Unstar', exact: true }).click();
  check('unstar shows at once', await within(row(1).getByRole('button', { name: 'Star', exact: true })) >= 0);
  const toast = await page1.getByText(/That did not work|Refused for the test/).first().waitFor({ timeout: SLOW + 3_000 }).then(() => true).catch(() => false);
  const restored = await row(1).getByRole('button', { name: 'Unstar', exact: true }).waitFor({ timeout: 4_000 }).then(() => true).catch(() => false);
  check('a refused unstar says so and fills again', toast && restored);
  refuse = null;

  if (label) {
    await row(1).click();
    const labelsBtn = page1.getByRole('button', { name: 'Labels', exact: true }).first();
    if (await labelsBtn.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false)) {
      await labelsBtn.click();
      // The menu item (it holds a checkbox), not the label link in the mail sidebar.
      const item = page1.locator('button:has(input[type=checkbox])', { hasText: `Opt ${tag}` }).first();
      await item.click();
      const t = Date.now();
      const ticked = await page1.waitForFunction((el) => el.querySelector('input[type=checkbox]')?.checked === true,
        await item.elementHandle(), { timeout: FAST }).then(() => true).catch(() => false);
      check('a label ticks at once, with no spinner over the thread', ticked && Date.now() - t < FAST + 100
        && !(await page1.getByText(`Opt mail 1 ${tag}`).first().isHidden().catch(() => true)));
    } else {
      check('the thread has a labels control', false, 'not found');
    }
  }

  console.log('\nChat');
  await page1.goto(`${BASE}/app/chat?c=${conv.id}`);
  const rice = page1.getByRole('button', { name: /Rice/ }).first();
  await rice.waitFor({ timeout: 15_000 });
  await rice.click();
  const voted = await within(page1.locator('button[aria-pressed="true"]').filter({ hasText: 'Rice' }).first(), FAST);
  const counted = await page1.getByText('1 person has voted').first().isVisible().catch(() => false);
  check('a poll vote shows and counts before the server answers', voted >= 0 && counted, voted >= 0 ? `${voted} ms` : 'not shown');

  console.log('\nFeed');
  await page1.goto(`${BASE}/app/feed/pages`);
  const card = page1.locator(`[data-page-id="${page.id}"]`);
  await card.waitFor({ timeout: 15_000 });
  await card.getByRole('button', { name: 'Follow', exact: true }).click();
  check('following a page shows at once', await within(card.getByRole('button', { name: 'Following', exact: true })) >= 0);
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  for (const c of cleanup) await c().catch(() => {});
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:optimistic: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
