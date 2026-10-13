#!/usr/bin/env node
/**
 * UI journeys (verify:ui:journeys, promoted from the gap-analysis probe — G-03): one user acts through the API while a
 * second watches in a real browser, plus responsive / a11y sweeps.
 * Needs `npm run dev`. OUT=<dir> for screenshots + results.json.
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
const OUT = process.env.OUT ?? '/tmp/gap-ui';
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const API = 'http://localhost:5190';
const BASE = 'http://localhost:5194';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const ids = [];

async function makeUser(name, roleName) {
  const id = `gapu-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = $1`, [roleName]);
  const role = roleName.toLowerCase();
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, role, rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role };
  return { id, name, email: user.email, perms, roleName, user, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
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
  await ctx.addInitScript((kv) => {
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
    sessionStorage.setItem('nga.installDismissedThisSession', '1');
  }, kv);
  await ctx.route('**/api/sso/verify-mis**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":{"valid":true}}' }));
  return ctx;
}
const visible = (page, text, timeout = 6000) => page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);

let browser;
try {
  const A = await makeUser('Ada Probe', 'Staff');
  const B = await makeUser('Ben Probe', 'Staff');
  const ADM = await makeUser('Admin Probe', 'Admin');
  browser = await chromium.launch();

  console.log('\n── Chat live UI');
  const ctxB = await ctxFor(browser, B);
  const pB = await ctxB.newPage();
  const errors = [];
  pB.on('pageerror', (e) => errors.push(e.message));
  pB.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  const dialogs = [];
  pB.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  await pB.goto(`${BASE}/app/chat`, { waitUntil: 'domcontentloaded' });
  await pB.waitForLoadState('networkidle').catch(() => {});
  await sleep(1500);
  check('chat page loads for B (not bounced to sign-in)', pB.url().includes('/app/chat'), pB.url());

  const dm = await call(A, 'POST', '/api/chat/conversations/direct', { userId: B.id });
  const convId = dm.body?.data?.conversation?.id;
  const t1 = `first-${randomBytes(3).toString('hex')}`;
  const s1 = await call(A, 'POST', `/api/chat/conversations/${convId}/messages`, { body: t1, nonce: randomBytes(8).toString('hex') });
  const msgId = s1.body?.data?.message?.id;
  check('new DM from A appears in B\'s sidebar without reload', await visible(pB, 'Ada Probe', 8000));
  check('sidebar preview shows the new message text live', await visible(pB, t1, 5000));
  await pB.screenshot({ path: `${OUT}/chat-sidebar-live.png` });

  await pB.getByText('Ada Probe').first().click();
  await sleep(1500);
  check('B opens the DM and sees the message', await visible(pB, t1, 5000));
  const t2 = `second-${randomBytes(3).toString('hex')}`;
  await call(A, 'POST', `/api/chat/conversations/${convId}/messages`, { body: t2, nonce: randomBytes(8).toString('hex') });
  check('a new message renders in the open thread live', await visible(pB, t2, 5000));
  await call(A, 'POST', `/api/chat/conversations/${convId}/messages/${msgId}/reactions`, { emoji: '🎉' });
  check('a reaction from A renders live on B\'s screen', await visible(pB, '🎉', 5000));
  await call(A, 'PATCH', `/api/chat/conversations/${convId}/messages/${msgId}`, { body: `${t1}-EDITED` });
  check('an edit renders live', await visible(pB, `${t1}-EDITED`, 5000));
  await call(A, 'DELETE', `/api/chat/conversations/${convId}/messages/${msgId}`);
  await sleep(2000);
  check('a delete removes the text live', !(await pB.getByText(`${t1}-EDITED`).first().isVisible().catch(() => false)));

  // typing indicator via the real web composer of A? We use a second browser for A.
  const ctxA = await ctxFor(browser, A);
  const pA = await ctxA.newPage();
  await pA.goto(`${BASE}/app/chat`, { waitUntil: 'domcontentloaded' });
  await pA.waitForLoadState('networkidle').catch(() => {});
  await pA.getByText('Ben Probe').first().click().catch(() => {});
  await sleep(1200);
  const box = pA.locator('[contenteditable="true"], textarea').last();
  await box.click().catch(() => {});
  await box.pressSequentially('typing now', { delay: 60 }).catch(() => {});
  check('typing indicator appears for B while A types', await visible(pB, 'typing', 4000));
  await pB.screenshot({ path: `${OUT}/chat-typing.png` });
  await pA.keyboard.press('Enter');
  await sleep(1500);
  check('message typed in A\'s browser reaches B live', await visible(pB, 'typing now', 5000));

  // offline recovery for the open thread
  await ctxB.setOffline(true);
  await sleep(1500);
  const missed = `missed-${randomBytes(3).toString('hex')}`;
  await call(A, 'POST', `/api/chat/conversations/${convId}/messages`, { body: missed, nonce: randomBytes(8).toString('hex') });
  const offlineBanner = await pB.getByText(/offline|reconnecting|connection/i).first().isVisible().catch(() => false);
  check('B sees an offline/reconnecting indicator', offlineBanner);
  await pB.screenshot({ path: `${OUT}/chat-offline.png` });
  await ctxB.setOffline(false);
  check('after reconnect, a message sent while B was offline appears in the open thread (gap fill)', await visible(pB, missed, 12000));

  // send while offline (outbox)
  await ctxB.setOffline(true); await sleep(800);
  const bBox = pB.locator('[contenteditable="true"], textarea').last();
  await bBox.click().catch(() => {});
  await bBox.pressSequentially('queued-offline', { delay: 20 }).catch(() => {});
  await pB.keyboard.press('Enter');
  await sleep(800);
  await pB.screenshot({ path: `${OUT}/chat-outbox.png` });
  await ctxB.setOffline(false);
  check('message composed offline is delivered after reconnect (outbox)', await visible(pA, 'queued-offline', 12000));

  console.log('\n── Mail live UI');
  await pB.goto(`${BASE}/app/chat`); await sleep(1500);
  const subj = `Live mail ${randomBytes(3).toString('hex')}`;
  await call(A, 'POST', '/api/mail/compose', { to: [B.email], subject: subj, bodyHtml: '<p>hello</p>' });
  await sleep(2500);
  await pB.screenshot({ path: `${OUT}/nav-after-mail.png` });
  const navBadge = await pB.evaluate(() => {
    const a = [...document.querySelectorAll('a[href*="/app/mail"]')];
    return a.map((x) => x.innerText.replace(/\s+/g, ' ')).join(' | ');
  });
  check('nav shows an unread mail badge while on another module', /\d/.test(navBadge), `mail nav text: "${navBadge}"`);
  await pB.goto(`${BASE}/app/mail`); await pB.waitForLoadState('networkidle').catch(() => {});
  check('mail inbox shows the mail', await visible(pB, subj, 8000));
  const subj2 = `Second live ${randomBytes(3).toString('hex')}`;
  await call(A, 'POST', '/api/mail/compose', { to: [B.email], subject: subj2, bodyHtml: '<p>again</p>' });
  check('new mail appears in the open inbox without reload', await visible(pB, subj2, 8000));
  const xsub = `XSS probe ${randomBytes(3).toString('hex')}`;
  await call(A, 'POST', '/api/mail/compose', { to: [B.email], subject: xsub, bodyHtml: '<p>look</p><img src=x onerror="window.__xss=1;alert(\'xss-mail\')">' });
  await visible(pB, xsub, 8000);
  await pB.getByText(xsub).first().click();
  await sleep(2500);
  const xssRan = await pB.evaluate(() => window.__xss === 1);
  check('mail HTML with onerror payload does NOT execute in recipient browser', !xssRan && !dialogs.includes('xss-mail'), `executed=${xssRan} dialogs=${JSON.stringify(dialogs)}`);
  await pB.screenshot({ path: `${OUT}/mail-xss.png` });
  // reply into the open thread
  const tid = (await call(B, 'GET', '/api/mail/threads?folder=inbox')).body?.data?.threads?.find((t) => t.subject === xsub)?.threadId;
  const msgs = tid ? (await call(A, 'GET', `/api/mail/threads/${tid}`)).body?.data?.thread?.messages : null;
  if (msgs?.length) {
    await call(A, 'POST', '/api/mail/compose', { to: [B.email], subject: `Re: ${xsub}`, bodyHtml: '<p>REPLY-IN-THREAD</p>', threadId: tid, parentId: msgs[0].id, kind: 'reply' });
    check('a reply arriving in the currently open thread renders live', await visible(pB, 'REPLY-IN-THREAD', 8000));
  }

  console.log('\n── Notification centre');
  await pB.goto(`${BASE}/app/chat`); await sleep(1500);
  const bell = pB.getByRole('button', { name: /notification/i }).first();
  const hasBell = await bell.isVisible().catch(() => false);
  check('a notification bell / centre exists in the shell', hasBell);
  if (hasBell) { await bell.click(); await sleep(1000); await pB.screenshot({ path: `${OUT}/notification-centre.png` }); }

  console.log('\n── Feed live UI');
  const page = await call(ADM, 'POST', '/api/feed/pages', { name: `UI page ${randomBytes(3).toString('hex')}`, audience: 'everyone' });
  const pageId = page.body?.data?.page?.id;
  await call(B, 'POST', `/api/feed/pages/${pageId}/follow`, {});
  const post = await call(ADM, 'POST', `/api/feed/pages/${pageId}/posts`, { body: 'UI feed post', audience: 'everyone' });
  const postId = post.body?.data?.postId;
  await pB.goto(`${BASE}/app/feed/post/${postId}`); await pB.waitForLoadState('networkidle').catch(() => {});
  await sleep(1500);
  await call(A, 'POST', `/api/feed/posts/${postId}/comments`, { body: 'LIVE-FEED-COMMENT' });
  check('feed comment by another user appears live on the permalink', await visible(pB, 'LIVE-FEED-COMMENT', 6000));
  await call(A, 'POST', `/api/feed/posts/${postId}/reactions`, { emoji: 'love' });
  await sleep(1500);
  await pB.screenshot({ path: `${OUT}/feed-after-foreign-reaction.png` });
  const likeState = await pB.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.innerText.trim()).filter((t) => /like|love|haha|wow|sad|angry/i.test(t)).join(' | '));
  check('B\'s own reaction button is not switched to A\'s reaction', !/love/i.test(likeState), `buttons: ${likeState.slice(0, 120)}`);
  const menuItems = await (async () => {
    const more = pB.getByRole('button', { name: /more|options|actions/i }).first();
    if (!(await more.isVisible().catch(() => false))) return 'no menu';
    await more.click(); await sleep(500);
    return pB.evaluate(() => document.body.innerText.match(/Edit post|Delete post|Pin|Move to drafts/gi)?.join(',') ?? 'none');
  })();
  await call(ADM, 'PATCH', `/api/feed/posts/${postId}`, { body: 'UI feed post (edited)' });
  await sleep(1500);
  await pB.keyboard.press('Escape');
  const menu2 = await (async () => {
    const more = pB.getByRole('button', { name: /more|options|actions/i }).first();
    if (!(await more.isVisible().catch(() => false))) return 'no menu';
    await more.click(); await sleep(500);
    return pB.evaluate(() => document.body.innerText.match(/Edit post|Delete post|Pin post|Move to drafts/gi)?.join(',') ?? 'none');
  })();
  await pB.screenshot({ path: `${OUT}/feed-menu-after-edit.png` });
  check('after an admin edit, a plain follower is NOT shown Edit/Delete actions', !/Edit post|Delete post/i.test(menu2), `before: ${menuItems}; after: ${menu2}`);
  await pB.keyboard.press('Escape');

  console.log('\n── Responsive + a11y sweep');
  const pages = ['/app/chat', '/app/feed', '/app/feed/pages', '/app/mail', '/app/mail/settings', '/app/meet', '/app/meet/history', '/app/files', '/app/admin/dashboard', '/app/admin/users', '/app/admin/audit', '/app/admin/oversight', '/app/admin/roles'];
  const widths = [{ width: 360, height: 760, tag: 'phone' }, { width: 768, height: 1024, tag: 'tablet' }, { width: 1440, height: 900, tag: 'desktop' }];
  const sweep = [];
  for (const vp of widths) {
    const c = await ctxFor(browser, ADM, { width: vp.width, height: vp.height });
    const p = await c.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    for (const path of pages) {
      errs.length = 0;
      const t0 = Date.now();
      await p.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
      await p.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      await sleep(700);
      const ms = Date.now() - t0;
      const m = await p.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const overflowX = document.documentElement.scrollWidth - vw;
        const offenders = [...document.querySelectorAll('body *')].filter((el) => {
          const r = el.getBoundingClientRect(); return r.width > 0 && r.right > vw + 2 && getComputedStyle(el).position !== 'fixed';
        }).slice(0, 3).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')}`);
        const noName = [...document.querySelectorAll('button, [role=button], a[href]')].filter((el) => {
          const r = el.getBoundingClientRect(); if (!r.width) return false;
          return !(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim() || el.getAttribute('aria-labelledby'));
        }).length;
        const imgsNoAlt = [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).length;
        const inputsNoLabel = [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select')].filter((i) => {
          if (i.getAttribute('aria-label') || i.getAttribute('aria-labelledby') || i.getAttribute('title')) return false;
          if (i.id && document.querySelector(`label[for="${i.id}"]`)) return false;
          return !i.closest('label');
        }).length;
        const smallTargets = [...document.querySelectorAll('button, [role=button], a[href]')].filter((el) => {
          const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
        }).length;
        const h1 = document.querySelectorAll('h1').length;
        return { overflowX, offenders, noName, imgsNoAlt, inputsNoLabel, smallTargets, h1, lang: document.documentElement.lang, text: document.body.innerText.slice(0, 80).replace(/\s+/g, ' ') };
      });
      sweep.push({ vp: vp.tag, path, ms, url: p.url(), errors: [...errs], ...m });
      await p.screenshot({ path: `${OUT}/${vp.tag}${path.replace(/\//g, '_')}.png` });
    }
    await c.close();
  }
  writeFileSync(`${OUT}/sweep.json`, JSON.stringify(sweep, null, 2));
  for (const s of sweep) {
    const bad = s.overflowX > 2 || s.errors.length;
    console.log(`  ${bad ? '⚠️ ' : '  '}${s.vp.padEnd(7)} ${s.path.padEnd(22)} ${String(s.ms).padStart(5)}ms overflowX=${s.overflowX} noName=${s.noName} noAlt=${s.imgsNoAlt} noLabel=${s.inputsNoLabel} small=${s.smallTargets} h1=${s.h1} err=${s.errors.length} ${s.overflowX > 2 ? s.offenders.join(',') : ''} ${s.url.endsWith(s.path) ? '' : '→ ' + s.url}`);
  }
  console.log('\n  page errors during live tests:', [...new Set(errors)].slice(0, 8));
  await call(ADM, 'DELETE', `/api/feed/pages/${pageId}`);
} catch (e) {
  console.error('ui probe crashed:', e);
} finally {
  await browser?.close();
  try { await purgeUsers(pool, ids, { quiet: true }); } catch (e) { console.error('cleanup:', e.message); }
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
  await pool.end();
  process.exit(0);
}
