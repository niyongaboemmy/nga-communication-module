/**
 * Shared harness for the chat experience suites (verify:composer:slow,
 * verify:composer:perf, verify:chat:replies).
 *
 * Mints users straight into the database with a JWT the API accepts, opens
 * signed-in browser contexts through `prepareBrowser` (MIS check stubbed,
 * install prompt dismissed) and records pass/fail lines. Needs `npm run dev`.
 */
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { purgeUsers } from './purge.mjs';
import { prepareBrowser } from './uiHarness.mjs';

export const API = 'http://localhost:5190';
export const BASE = process.env.CHAT_BASE ?? 'http://localhost:5194';

export const env = Object.fromEntries(readFileSync('apps/api/.env', 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nonce = () => randomBytes(8).toString('hex');

export function createSuite(title, prefix = 'vcx-') {
  // Multi-tenancy (0046): column defaults read app.tenant_id, so a raw
  // connection must name its school. The suites run as NGA, tenant 1.
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, options: '-c app.tenant_id=1' });
  const pass = [];
  const fails = [];
  const users = [];
  const contexts = [];
  let browser = null;

  const check = (name, ok, detail = '') => {
    const line = `${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`;
    (ok ? pass : fails).push(line);
    console.log(`  ${line}`);
    return ok;
  };
  const step = (s) => console.log(`\n  • ${s}`);

  async function makeUser(name, roleName = 'Staff') {
    const id = `${prefix}${randomBytes(5).toString('hex')}`;
    const { rows } = await pool.query('SELECT id FROM roles WHERE name = $1 AND tenant_id = 1', [roleName]);
    const roleId = rows[0]?.id ?? null;
    await pool.query(
      `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
      [id, name, `${id}@amashuri.com`, roleName.toLowerCase(), roleId]);
    const perms = roleId ? (await pool.query(
      `SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`,
      [roleId])).rows.map((r) => r.key) : [];
    const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: roleName.toLowerCase() };
    const u = { id, name, perms, roleName, user, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
    users.push(u);
    return u;
  }

  async function api(path, u, { method, body } = {}) {
    const res = await fetch(`${API}${path}`, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
    return j.data;
  }

  async function channel(owner, members, name = 'room') {
    const d = await api('/api/chat/conversations', owner, {
      body: { type: 'channel', name: `${name}-${randomBytes(2).toString('hex')}`, memberIds: members.map((m) => m.id) },
    });
    return d.conversation;
  }
  const post = (u, conv, body, extra = {}) =>
    api(`/api/chat/conversations/${conv.id}/messages`, u, { body: { body, nonce: nonce(), ...extra } }).then((d) => d.message);
  const reply = (u, conv, rootId, body, alsoSendToChannel = false) =>
    api(`/api/chat/conversations/${conv.id}/messages/${rootId}/replies`, u, { body: { body, nonce: nonce(), alsoSendToChannel } });

  /**
   * Bulk messages through the chat service's own write path (sequence numbers,
   * previews, counters exactly as a real send), going around the API's
   * 60-a-minute send limit, which a fixture is not. Runs as tenant 1.
   */
  async function bulk(u, conv, bodies) {
    process.env.DATABASE_URL ??= env.DATABASE_URL;
    const [chatSvc, tenancy] = await Promise.all([import('@tupo/chat'), import('@tupo/tenancy')]);
    for (let i = 0; i < bodies.length; i += 1) {
      const sender = Array.isArray(u) ? u[i % u.length] : u;
      await tenancy.runWithTid(1, () => chatSvc.sendMessage({
        conversationId: conv.id, senderId: sender.id, body: bodies[i], nonce: `bulk-${conv.id}-${i}`,
      }));
    }
  }

  async function launch() {
    browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
    prepareBrowser(browser);
    return browser;
  }

  /** A signed-in page. `opts`: width, height, touch, query (appended to the chat URL), storage overrides. */
  async function openAs(u, conv, opts = {}) {
    const { width = 1440, height = 900, touch = false, query = '', storage = {} } = opts;
    const ctx = await browser.newContext({
      viewport: { width, height },
      ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
    });
    await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, {
      tupo_token: u.token,
      tupo_user: JSON.stringify(u.user),
      tupo_permissions: '[]',
      tupo_role_permissions: JSON.stringify({ keys: u.perms, name: u.roleName }),
      ...storage,
    });
    contexts.push(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const q = conv ? `?c=${conv.id}${query ? `&${query}` : ''}` : (query ? `?${query}` : '');
    await page.goto(`${BASE}/app/chat${q}`, { waitUntil: 'domcontentloaded' });
    if (conv) await page.locator('#composer').waitFor({ timeout: 25_000 });
    return { page, ctx, errors };
  }

  async function finish() {
    for (const c of contexts) await c.close().catch(() => {});
    await browser?.close().catch(() => {});
    await purgeUsers(pool, users.map((u) => u.id), { quiet: true }).catch((e) => console.error('purge failed', e));
    await pool.end();
    console.log(`\n  ${title}: ${pass.length} passed, ${fails.length} failed`);
    if (fails.length) { console.log(fails.map((f) => `    ${f}`).join('\n')); process.exitCode = 1; }
  }

  return { pool, check, step, makeUser, api, channel, post, reply, bulk, launch, openAs, finish, pass, fails };
}

/** Wait for a predicate on the page; resolves true/false instead of throwing. */
export const waitTrue = (page, fn, arg, ms = 8000) =>
  page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);

/** Delay matching requests (method + url regex) by `ms`. */
export async function delayRequests(target, method, urlRe, ms) {
  await target.route((url) => urlRe.test(url.toString()), async (route) => {
    if (route.request().method() !== method) return route.fallback();
    await sleep(ms);
    await route.fallback().catch(() => {});
  });
}
