#!/usr/bin/env node
/**
 * Gap-analysis probe (round 2): chat user journeys in a real browser.
 * A acts through the API; B drives the web UI. Needs `npm run dev`.
 * MEDIA=<dir with clip.mp4, voice.webm, pic.png>  OUT=<dir>
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
const OUT = process.env.OUT ?? '/tmp/gap2-chat';
const MEDIA = process.env.MEDIA ?? OUT;
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const API = 'http://localhost:5190', FILES = 'http://localhost:5192', BASE = 'http://localhost:5194';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const ids = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const nonce = () => randomBytes(8).toString('hex');
const want = (k) => !ONLY || ONLY.has(k);

async function makeUser(name, roleName = 'Staff') {
  const id = `gapc-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = $1`, [roleName]);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, roleName.toLowerCase(), rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: roleName.toLowerCase() };
  return { id, name, perms, roleName, user, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
const call = async (u, method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
async function upload(u, path, name, mime) {
  const bytes = readFileSync(path);
  const t = await fetch(`${FILES}/api/files/tickets`, { method: 'POST', headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, size: bytes.length, mime }) }).then((r) => r.json());
  const put = await fetch(`${FILES}${t.data.uploadUrl}`, { method: 'PUT', headers: { authorization: `Bearer ${u.token}`, 'content-type': mime }, body: bytes });
  if (!put.ok) throw new Error(`upload ${put.status}`);
  return t.data.fileId;
}
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
const send = (u, conv, body, extra = {}) => call(u, 'POST', `/api/chat/conversations/${conv}/messages`, { body, nonce: nonce(), ...extra });
const headerName = (p) => p.evaluate(() => document.querySelector('#composer')?.closest('section')?.getAttribute('aria-label') ?? (document.querySelector('section[aria-label] header') ? 'section-without-composer' : 'no conversation open'));
const openConv = async (p, name) => { await p.locator('aside, div').getByRole('button', { name: new RegExp(name) }).first().click(); await sleep(1200); };

let browser;
try {
  const A = await makeUser('Ada Journey');
  const C = await makeUser('Cyd Journey');
  const B = await makeUser('Ben Journey');
  // Two DMs for B: with Cyd (older), with Ada (newer).
  const dmC = (await call(C, 'POST', '/api/chat/conversations/direct', { userId: B.id })).body.data.conversation.id;
  await send(C, dmC, 'older hello from cyd');
  await sleep(1100);
  const dmA = (await call(A, 'POST', '/api/chat/conversations/direct', { userId: B.id })).body.data.conversation.id;
  await send(A, dmA, 'newer hello from ada');
  browser = await chromium.launch();

  // ── 1. Deep link ?c= (the form global search emits) ──────────────────
  if (want('deeplink')) {
    console.log('\n── deep link');
    const ctx = await ctxFor(browser, B); const p = await ctx.newPage();
    await p.goto(`${BASE}/app/chat?c=${dmC}`, { waitUntil: "domcontentloaded" }); await p.waitForLoadState('networkidle').catch(() => {}); await sleep(2000);
    const h = await headerName(p);
    check('/app/chat?c=<Cyd DM> opens the Cyd conversation', /Cyd/.test(h), `header shows: ${h.split('\n')[0]}`);
    await p.goto(`${BASE}/app/chat?dm=${C.id}`, { waitUntil: "domcontentloaded" }); await p.waitForLoadState('networkidle').catch(() => {}); await sleep(2000);
    const h2 = await headerName(p);
    check('/app/chat?dm=<user> opens a DM with that user', /Cyd/.test(h2), `header shows: ${h2.split('\n')[0]}`);
    // reload keeps the open conversation?
    await openConv(p, 'Cyd Journey');
    await p.reload({ waitUntil: "domcontentloaded" }); await p.waitForLoadState('networkidle').catch(() => {}); await sleep(2000);
    const h3 = await headerName(p);
    check('reload keeps the conversation that was open (Cyd)', /Cyd/.test(h3), `after reload header: ${h3.split('\n')[0]}; url=${p.url()}`);
    await ctx.close();
  }

  // ── 2. Sidebar ordering and draft indicator ──────────────────────────
  if (want('sidebar')) {
    console.log('\n── sidebar ordering + drafts');
    await call(B, 'PUT', `/api/chat/conversations/${dmC}/draft`, { draft: 'SERVERDRAFT-x1' });
    const ctx = await ctxFor(browser, B); const p = await ctx.newPage();
    await p.goto(`${BASE}/app/chat`, { waitUntil: "domcontentloaded" }); await p.waitForLoadState('networkidle').catch(() => {}); await sleep(2000);
    const rowNames = async () => (await p.evaluate(() => [...document.querySelectorAll('li > button span.truncate.text-sm')].map((s) => s.textContent.trim()))).filter((t) => /Journey/.test(t));
    const before = await rowNames();
    await send(C, dmC, 'brand new message bumps cyd');
    await sleep(2500);
    const after = await rowNames();
    check('a new message in an older conversation moves it to the top of the list', after[0] === 'Cyd Journey', `before=${before.join(' > ')} after=${after.join(' > ')}`);
    await p.screenshot({ path: `${OUT}/sidebar-order.png` });

    // open Cyd, composer pre-filled from server draft, send it
    await openConv(p, 'Cyd Journey');
    const box = p.locator('#composer');
    const prefilled = await box.inputValue();
    await box.click(); await p.keyboard.press('End'); await p.keyboard.press('Enter');
    await sleep(1500);
    await openConv(p, 'Ada Journey');
    await sleep(1200);
    const staleDraft = await p.getByText('Draft: SERVERDRAFT-x1').first().isVisible().catch(() => false);
    check('after sending the drafted text, the sidebar stops showing "Draft: …"', !staleDraft, `composer prefill="${prefilled}", stale draft row visible=${staleDraft}`);
    // a local unsent draft in Ada → switch to Cyd → is it shown?
    await box.fill('LOCALDRAFT-zz');
    await sleep(1200);
    await openConv(p, 'Cyd Journey');
    const localShown = await p.getByText('Draft: LOCALDRAFT-zz').first().isVisible().catch(() => false);
    check('an unsent draft typed in Ada is shown on Ada\'s sidebar row', localShown);
    await p.screenshot({ path: `${OUT}/sidebar-draft.png` });
    await ctx.close();
  }

  // ── 3. Composer journeys ─────────────────────────────────────────────
  if (want('composer')) {
    console.log('\n── composer');
    const ctx = await ctxFor(browser, B); const p = await ctx.newPage();
    await p.goto(`${BASE}/app/chat`, { waitUntil: "domcontentloaded" }); await p.waitForLoadState('networkidle').catch(() => {}); await sleep(2000);
    await openConv(p, 'Ada Journey');
    const box = p.locator('#composer');

    // over-limit + Enter
    const long = 'x'.repeat(8005);
    await box.fill(long);
    await sleep(300);
    const btnDisabled = await p.getByRole('button', { name: 'Send message' }).isDisabled().catch(() => null);
    await box.press('Enter');
    await sleep(2500);
    const afterValue = await box.inputValue();
    const notSent = await visible(p, 'Not sent', 3000);
    check('Enter on an over-limit message is blocked like the disabled Send button', !notSent && afterValue.length === long.length,
      `send button disabled=${btnDisabled}; after Enter composer length=${afterValue.length}; "Not sent" bubble=${notSent}`);
    await p.screenshot({ path: `${OUT}/overlimit.png` });
    if (notSent) {
      // try to delete the failed bubble
      const row = p.locator('li[data-message-row]').filter({ hasText: 'Not sent' }).last();
      await row.hover();
      await row.getByRole('button', { name: 'Delete message' }).click().catch(() => {});
      await p.getByRole('button', { name: 'Delete', exact: true }).click().catch(() => {});
      await sleep(1500);
      const still = await visible(p, 'Not sent', 1500);
      check('a failed message can be deleted/discarded from the log', !still, `still visible after Delete=${still}`);
    }

    // slash hint keyboard: "/sea" + Enter
    await box.fill('/sea');
    await sleep(300);
    await box.press('Enter');
    await sleep(1500);
    const searchOpened = await p.locator('aside[aria-label="Search messages"]').isVisible().catch(() => false);
    const sentAsText = await p.locator('li[data-message-row]').filter({ hasText: /^\s*\/sea/ }).count();
    check('Enter on a highlighted slash suggestion ("/sea" → /search) runs it', searchOpened && !sentAsText, `search panel=${searchOpened}, "/sea" posted as a message=${sentAsText > 0}`);
    await p.keyboard.press('Escape');

    // mention token shown raw in the textarea
    await box.fill('');
    await box.pressSequentially('hi @Ada', { delay: 40 });
    await sleep(600);
    await box.press('Enter');
    await sleep(300);
    const val = await box.inputValue();
    check('picking a mention shows a readable name in the composer', !/<@/.test(val), `composer value="${val}"`);
    await p.screenshot({ path: `${OUT}/mention-raw.png` });
    await box.fill('');

    // tray follows conversation switch
    writeFileSync(`${OUT}/note.txt`, 'tray probe');
    await p.locator('input[type=file]').first().setInputFiles(`${OUT}/note.txt`);
    await sleep(2500);
    console.log('    tray in Ada before switch:', await p.locator('ul[aria-label="Attachments"]').innerText().catch(() => 'none'));
    await openConv(p, 'Cyd Journey');
    const trayInCyd = await p.locator('ul[aria-label="Attachments"]').getByText('note.txt').isVisible().catch(() => false);
    check('an attachment picked in Ada\'s DM does not follow you into Cyd\'s DM', !trayInCyd, `tray still shows note.txt in Cyd=${trayInCyd}`);
    await p.screenshot({ path: `${OUT}/tray-follows.png` });
    if (trayInCyd) {
      await box.fill('which conversation gets this?');
      await box.press('Enter'); await sleep(1500);
      const { rows } = await pool.query(
        `SELECT m.conversation_id FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE m.body = 'which conversation gets this?'`).catch(() => ({ rows: [] }));
      check('…and is sent with the message to Cyd instead', rows.length > 0 && rows[0].conversation_id === dmC, `attached in conv=${rows[0]?.conversation_id === dmC ? 'Cyd' : rows[0]?.conversation_id ?? 'n/a'}`);
    }

    // header pinned button
    const pinBtn = p.getByRole('button', { name: 'Pinned messages' });
    const panelsBefore = await p.locator('aside').count();
    await pinBtn.click().catch(() => {});
    await sleep(800);
    const panelsAfter = await p.locator('aside').count();
    check('header "Pinned messages" button opens something', panelsAfter > panelsBefore, `asides before=${panelsBefore} after=${panelsAfter}`);
    await ctx.close();
  }

  // ── 4. Rendering: snake_case, media, voice, thread attachments ───────
  if (want('render')) {
    console.log('\n── rendering + media');
    await send(A, dmA, 'open my_file_name_v2.txt and compute 2*3*4 please');
    const vid = await upload(A, `${MEDIA}/clip.mp4`, 'clip.mp4', 'video/mp4');
    await send(A, dmA, '', { attachments: [vid] });
    const pic = await upload(A, `${MEDIA}/pic.png`, 'pic.png', 'image/png');
    const picMsg = await send(A, dmA, 'photo for thread', { attachments: [pic] });
    const voice = await upload(A, `${MEDIA}/voice.webm`, 'voice.webm', 'audio/webm');
    await send(A, dmA, '', { attachments: [voice], type: 'voice_note' });
    const ctx = await ctxFor(browser, B, { width: 1440, height: 900 }); const p = await ctx.newPage();
    await p.goto(`${BASE}/app/chat`, { waitUntil: "domcontentloaded" }); await p.waitForLoadState('networkidle').catch(() => {}); await sleep(1500);
    await openConv(p, 'Ada Journey');
    await sleep(2500);
    const snake = await visible(p, 'my_file_name_v2.txt', 2000);
    check('snake_case text renders verbatim (underscores kept)', snake,
      `rendered: ${await p.evaluate(() => [...document.querySelectorAll('.message-body')].find((e) => e.textContent.includes('compute'))?.innerHTML.replace(/class="[^"]*"/g, '').slice(0, 200))}`);

    const videoImg = await p.evaluate(() => {
      const btn = [...document.querySelectorAll('button[aria-label="Open clip.mp4"]')][0];
      const img = btn?.querySelector('img'); const v = btn?.querySelector('video');
      return { hasImg: Boolean(img), naturalWidth: img?.naturalWidth ?? null, complete: img?.complete ?? null, hasVideo: Boolean(v) };
    });
    check('a video attachment shows a working thumbnail in the log', !videoImg.hasImg || videoImg.naturalWidth > 0,
      `tile uses <img>=${videoImg.hasImg}, naturalWidth=${videoImg.naturalWidth}, <video>=${videoImg.hasVideo}`);
    await p.locator('button[aria-label="Open clip.mp4"]').first().scrollIntoViewIfNeeded().catch(() => {});
    await p.screenshot({ path: `${OUT}/video-tile.png` });

    // thread panel with an image root
    const row = p.locator('li[data-message-row]').filter({ hasText: 'photo for thread' }).first();
    await row.hover();
    await row.getByRole('button', { name: 'Reply in thread' }).click().catch(() => {});
    await sleep(1500);
    const threadImgs = await p.locator('aside[aria-label="Thread"] img').count();
    const threadAvatarsOnly = await p.locator('aside[aria-label="Thread"] button[aria-label^="Open"]').count();
    check('thread panel shows the root message\'s image attachment', threadAvatarsOnly > 0, `attachment tiles in thread=${threadAvatarsOnly}, imgs=${threadImgs}`);
    await p.screenshot({ path: `${OUT}/thread-no-attachment.png` });
    // Escape inside thread composer drops typed text?
    await p.locator('#thread-composer').fill('half-written thread reply');
    await p.keyboard.press('Escape');
    await sleep(500);
    await row.hover();
    await row.getByRole('button', { name: 'Reply in thread' }).click().catch(() => {});
    await sleep(1200);
    const kept = await p.locator('#thread-composer').inputValue().catch(() => '');
    check('Esc in the thread composer keeps the half-written reply', kept === 'half-written thread reply', `after Esc + reopen composer="${kept}"`);
    await p.getByRole('button', { name: 'Close thread' }).click().catch(() => {});

    // Lightbox Escape also closes the details panel?
    await p.getByRole('button', { name: 'Conversation details' }).click(); await sleep(800);
    const detailsOpen = await p.locator('aside[aria-label="Conversation details"]').isVisible();
    await p.locator('button[aria-label="Open pic.png"]').first().click(); await sleep(1000);
    const lb = await p.locator('div[role=dialog][aria-modal=true]').filter({ hasText: 'pic.png' }).isVisible().catch(() => false);
    await p.keyboard.press('Escape'); await sleep(600);
    const detailsAfter = await p.locator('aside[aria-label="Conversation details"]').isVisible().catch(() => false);
    const lbAfter = await p.locator('div[role=dialog][aria-modal=true]').count();
    console.log('    lightboxes still open after one Esc:', lbAfter);
    await p.screenshot({ path: `${OUT}/lightbox-esc.png` });
    for (let i = 0; i < 3 && (await p.locator('div[role=dialog][aria-modal=true]').count()); i++) { await p.getByRole('button', { name: 'Close viewer' }).first().click().catch(() => {}); await sleep(300); }
    check('Esc closes only the lightbox, not the details panel behind it', !detailsOpen || !lb || detailsAfter, `details before=${detailsOpen}, lightbox=${lb}, details after Esc=${detailsAfter}`);

    // members tab: rows clickable → profile card?
    await p.getByRole('button', { name: 'Conversation details' }).click().catch(() => {}); await sleep(400);
    if (!(await p.locator('aside[aria-label="Conversation details"]').isVisible().catch(() => false))) {
      await p.getByRole('button', { name: 'Conversation details' }).click(); await sleep(600);
    }
    await p.getByRole('tab', { name: 'Members' }).click(); await sleep(1200);
    await p.locator('aside[aria-label="Conversation details"] ul li button').filter({ hasText: 'Ada Journey' }).first().click().catch(() => {});
    await sleep(800);
    const card = await p.locator('[role=dialog][aria-label*="profile"]').count();
    check('clicking a member opens their profile card', card > 0, `profile dialogs=${card}`);
    await p.getByRole('tab', { name: 'Files' }).click(); await sleep(1500);
    const filesText = await p.locator('aside[aria-label="Conversation details"]').innerText();
    await p.getByRole('button', { name: 'Media' }).click().catch(() => {}); await sleep(1500);
    const mediaText = await p.locator('aside[aria-label="Conversation details"]').innerText();
    check('Files › Media filter includes the shared video', /clip\.mp4/.test(mediaText), `All has clip.mp4=${/clip\.mp4/.test(filesText)}, Media has clip.mp4=${/clip\.mp4/.test(mediaText)}`);
    await p.getByRole('button', { name: 'Close details' }).click().catch(() => {});

    // voice note after ticket expiry
    console.log('    (waiting 70 s for the media ticket to expire)');
    const audioReady = await p.locator('audio').count();
    await sleep(70_000);
    const playBtn = p.getByRole('button', { name: 'Play voice message' }).last();
    await playBtn.scrollIntoViewIfNeeded().catch(() => {});
    const respStatuses = [];
    p.on('response', (r) => { if (r.url().includes('/content?inline=1')) respStatuses.push(r.status()); });
    await playBtn.click().catch(() => {});
    await sleep(3000);
    const state = await p.evaluate(() => {
      const a = [...document.querySelectorAll('audio')].pop();
      return a ? { paused: a.paused, currentTime: a.currentTime, error: a.error?.code ?? null, networkState: a.networkState, readyState: a.readyState } : null;
    });
    check('a voice note plays when pressed >60 s after the message rendered', state && !state.paused && state.currentTime > 0.5,
      `audio elements=${audioReady}, state=${JSON.stringify(state)}, content responses=${JSON.stringify(respStatuses)}`);
    await p.screenshot({ path: `${OUT}/voice-expired.png` });
    await ctx.close();
  }

  // ── 5. Search prefix ─────────────────────────────────────────────────
  if (want('search')) {
    console.log('\n── search');
    await send(A, dmA, 'Remember the homework assignment for Thursday');
    await sleep(1500);
    const ctx = await ctxFor(browser, B); const p = await ctx.newPage();
    await p.goto(`${BASE}/app/chat`, { waitUntil: "domcontentloaded" }); await p.waitForLoadState('networkidle').catch(() => {}); await sleep(1500);
    await p.getByRole('button', { name: 'Search messages' }).first().click();
    const input = p.getByLabel('Search term');
    await input.fill('homew'); await sleep(1500);
    const prefix = await p.locator('aside[aria-label="Search messages"]').innerText();
    await input.fill('homework'); await sleep(1500);
    const full = await p.locator('aside[aria-label="Search messages"]').innerText();
    check('search-as-you-type finds "homework" from the prefix "homew"', !/Nothing matches/.test(prefix),
      `"homew": ${/Nothing matches/.test(prefix) ? 'Nothing matches' : 'hits'}; "homework": ${/Nothing matches/.test(full) ? 'Nothing matches' : 'hits'}`);
    await ctx.close();
  }

  // ── 6. Dock ──────────────────────────────────────────────────────────
  if (want('dock')) {
    console.log('\n── dock');
    const ctx = await ctxFor(browser, B); const p = await ctx.newPage();
    await p.goto(`${BASE}/app/mail`, { waitUntil: "domcontentloaded" }); await p.waitForLoadState('networkidle').catch(() => {}); await sleep(1500);
    await p.locator('button[aria-haspopup="dialog"][aria-label^="Messages"]').click().catch(() => {});
    await sleep(800);
    const dock = p.locator('div[role=dialog][aria-label="Messages"]');
    await dock.getByRole('button', { name: /Ada Journey/ }).first().click().catch(() => {});
    await sleep(1500);
    const row = dock.locator('li[data-message-row]').last();
    await row.hover();
    await row.getByRole('button', { name: 'Reply in thread' }).click().catch(() => {});
    await sleep(1200);
    const threadVisible = await p.locator('aside[aria-label="Thread"]').isVisible().catch(() => false);
    check('"Reply in thread" from the dock opens a thread', threadVisible, `thread visible=${threadVisible}`);
    await p.screenshot({ path: `${OUT}/dock-thread.png` });
    // slash /saved in dock
    await dock.locator('#composer').fill('/saved'); await dock.locator('#composer').press('Enter'); await sleep(2000);
    const url = p.url();
    const savedOpen = await p.locator('aside[aria-label="Saved items"]').isVisible().catch(() => false);
    check('/saved typed in the dock opens Saved items', savedOpen, `url=${url.replace(BASE, '')}, saved panel=${savedOpen}`);
    await ctx.close();
  }
  if (want('mobile')) {
    console.log('\n── mobile back');
    const ctx = await ctxFor(browser, B, { width: 390, height: 844 }); const p = await ctx.newPage();
    await p.goto(`${BASE}/app/feed`, { waitUntil: "domcontentloaded" }); await sleep(1500);
    await p.goto(`${BASE}/app/chat`, { waitUntil: "domcontentloaded" }); await p.waitForLoadState('networkidle').catch(() => {}); await sleep(1500);
    await p.getByRole('button', { name: /Ada Journey/ }).first().click(); await sleep(1200);
    const opened = await headerName(p);
    await p.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {}); await sleep(1500);
    check('phone: browser Back from an open conversation returns to the conversation list', p.url().includes('/app/chat'), `opened=${opened}; after Back url=${p.url().replace(BASE, '')}`);
    await ctx.close();
  }
} catch (err) {
  console.error('probe error', err);
  check('probe ran to completion', false, String(err?.message ?? err));
} finally {
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  await browser?.close().catch(() => {});
  await purgeUsers(pool, ids, { quiet: true });
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed; results in ${OUT}`);
}
