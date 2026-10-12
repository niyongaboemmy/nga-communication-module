#!/usr/bin/env node
/**
 * Second-pass gap probe (temporary) for Mail + Feed. Each check prints
 * GAP when the defect reproduces. Needs `npm run dev`. OUT=<dir>.
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
const OUT = process.env.OUT ?? '/tmp/gap2';
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const API = 'http://localhost:5190';
const BASE = 'http://localhost:5194';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const gap = (id, reproduced, d = '') => { results.push({ id, reproduced, d }); console.log(`  ${reproduced ? 'GAP ' : 'ok  '} ${id}${d ? `  — ${d}` : ''}`); };
const ids = [];
const pageIds = [];
const ONLY = process.env.ONLY ?? 'all';

async function makeUser(name, roleName) {
  const id = `gap2-${randomBytes(5).toString('hex')}`;
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
const tok = () => randomBytes(3).toString('hex');
const send = (from, to, subject, extra = {}) => call(from, 'POST', '/api/mail/compose', { to: [`userId:${to.id}`], subject, bodyHtml: `<p>${subject}</p>`, ...extra });
const threadOf = async (u, folder, subject, label) => (await call(u, 'GET', `/api/mail/threads?folder=${folder}${label ? `&label=${label}` : ''}`)).body?.data?.threads?.find((t) => t.subject.includes(subject));

async function cleanupMailFeed(userIds) {
  const q = (sql) => pool.query(sql, [userIds]).catch((e) => console.error('  cleanup:', e.message.split('\n')[0]));
  // mail
  await q(`DELETE FROM mail_delivery_events WHERE message_id IN (SELECT id FROM mail_messages WHERE from_user_id = ANY($1::text[]))`);
  await q(`DELETE FROM mail_attachments WHERE message_id IN (SELECT id FROM mail_messages WHERE from_user_id = ANY($1::text[]))`);
  await q(`DELETE FROM mail_recipients WHERE message_id IN (SELECT id FROM mail_messages WHERE from_user_id = ANY($1::text[])) OR user_id = ANY($1::text[])`);
  await q(`DELETE FROM mail_threads WHERE id IN (SELECT thread_id FROM mail_messages WHERE from_user_id = ANY($1::text[]))`);
  await q(`DELETE FROM mail_messages WHERE from_user_id = ANY($1::text[])`);
  await q(`DELETE FROM mail_threads WHERE created_by = ANY($1::text[])`);
  await q(`DELETE FROM mail_labels WHERE owner_id = ANY($1::text[])`);
  await q(`DELETE FROM mail_prefs WHERE user_id = ANY($1::text[])`);
  await q(`DELETE FROM mail_templates WHERE created_by = ANY($1::text[])`);
  // feed
  const posts = `(SELECT id FROM feed_posts WHERE author_id = ANY($1::text[]) OR page_id IN (SELECT id FROM feed_pages WHERE created_by = ANY($1::text[])))`;
  await q(`DELETE FROM feed_reports WHERE reporter_id = ANY($1::text[]) OR post_id IN ${posts}`);
  await q(`DELETE FROM feed_comment_reactions WHERE user_id = ANY($1::text[]) OR comment_id IN (SELECT id FROM feed_comments WHERE post_id IN ${posts})`);
  await q(`DELETE FROM feed_comments WHERE author_id = ANY($1::text[]) OR post_id IN ${posts}`);
  for (const t of ['feed_reactions', 'feed_bookmarks', 'feed_poll_votes', 'feed_event_rsvps', 'feed_post_views', 'feed_timeline']) {
    await q(`DELETE FROM ${t} WHERE user_id = ANY($1::text[]) OR post_id IN ${posts}`);
  }
  await q(`DELETE FROM feed_post_edits WHERE post_id IN ${posts}`);
  await q(`DELETE FROM feed_posts WHERE id IN ${posts}`);
  await q(`DELETE FROM feed_page_followers WHERE user_id = ANY($1::text[]) OR page_id IN (SELECT id FROM feed_pages WHERE created_by = ANY($1::text[]))`);
  await q(`DELETE FROM feed_page_editors WHERE user_id = ANY($1::text[]) OR page_id IN (SELECT id FROM feed_pages WHERE created_by = ANY($1::text[]))`);
  await q(`DELETE FROM feed_pages WHERE created_by = ANY($1::text[])`);
  await q(`DELETE FROM feed_story_views WHERE user_id = ANY($1::text[]) OR story_id IN (SELECT id FROM feed_stories WHERE author_id = ANY($1::text[]))`);
  await q(`DELETE FROM feed_stories WHERE author_id = ANY($1::text[])`);
  await q(`DELETE FROM feed_reel_likes WHERE user_id = ANY($1::text[])`);
  await q(`DELETE FROM feed_reel_views WHERE user_id = ANY($1::text[])`);
  await q(`DELETE FROM feed_reel_comments WHERE author_id = ANY($1::text[])`);
  await q(`DELETE FROM feed_reels WHERE author_id = ANY($1::text[])`);
  await q(`DELETE FROM files WHERE owner_id = ANY($1::text[])`);
}

let browser;
try {
  const A = await makeUser('Ada Gap', 'Staff');
  const B = await makeUser('Ben Gap', 'Staff');
  const S = await makeUser('Sam Student', 'Student');
  const ADM = await makeUser('Admin Gap', 'Admin');
  browser = await chromium.launch();

  if (ONLY === 'all' || ONLY === 'mail') {
    console.log('\n── Mail API');
    // 1. labels vanish when a reply arrives
    const s1 = `LBL-${tok()}`;
    await send(A, B, s1);
    let t = await threadOf(B, 'inbox', s1);
    const lab = (await call(B, 'POST', '/api/mail/labels', { name: `L${tok()}`, color: '#ef4444' })).body?.data?.label;
    await call(B, 'POST', `/api/mail/threads/${t.threadId}/labels`, { labels: [lab.id] });
    const before = (await call(B, 'GET', `/api/mail/threads/${t.threadId}`)).body?.data?.thread?.labels;
    const msgs = (await call(A, 'GET', `/api/mail/threads/${t.threadId}`)).body?.data?.thread?.messages;
    await send(A, B, `Re: ${s1}`, { threadId: t.threadId, parentId: msgs[0].id, kind: 'reply' });
    const after = (await call(B, 'GET', `/api/mail/threads/${t.threadId}`)).body?.data?.thread?.labels;
    const listed = await threadOf(B, 'inbox', s1);
    gap('MAIL2 label dropped after a new reply', before?.length === 1 && after?.length === 0, `labels before=${JSON.stringify(before)} after=${JSON.stringify(after)} list chips=${JSON.stringify(listed?.labels)}`);

    // 2. archived thread + reply -> shows in both inbox and archive
    const s2 = `ARC-${tok()}`;
    await send(A, B, s2);
    t = await threadOf(B, 'inbox', s2);
    await call(B, 'POST', `/api/mail/threads/${t.threadId}/move`, { folder: 'archive' });
    const m2 = (await call(A, 'GET', `/api/mail/threads/${t.threadId}`)).body?.data?.thread?.messages;
    await send(A, B, `Re: ${s2}`, { threadId: t.threadId, parentId: m2[0].id, kind: 'reply' });
    const inInbox = Boolean(await threadOf(B, 'inbox', s2));
    const inArchive = Boolean(await threadOf(B, 'archive', s2));
    gap('MAIL2 thread listed in Inbox AND Archive after reply', inInbox && inArchive, `inbox=${inInbox} archive=${inArchive}`);

    // 3. label view (folder=inbox) hides archived labelled threads
    const s3 = `LBLARC-${tok()}`;
    await send(A, B, s3);
    t = await threadOf(B, 'inbox', s3);
    await call(B, 'POST', `/api/mail/threads/${t.threadId}/labels`, { labels: [lab.id] });
    await call(B, 'POST', `/api/mail/threads/${t.threadId}/move`, { folder: 'archive' });
    const inLabelView = Boolean(await threadOf(B, 'inbox', s3, lab.id));
    gap('MAIL2 label view hides archived labelled thread', !inLabelView, `found in label view=${inLabelView}`);

    // 4. starred count includes trashed, starred list does not
    const s4 = `STAR-${tok()}`;
    await send(A, B, s4);
    t = await threadOf(B, 'inbox', s4);
    await call(B, 'POST', `/api/mail/threads/${t.threadId}/star`, { starred: true });
    await call(B, 'POST', `/api/mail/threads/${t.threadId}/move`, { folder: 'trash' });
    const cnt = (await call(B, 'GET', '/api/mail/counts')).body?.data?.counts;
    const starredList = (await call(B, 'GET', '/api/mail/threads?folder=starred')).body?.data?.threads ?? [];
    gap('MAIL2 Starred badge counts trashed rows the Starred list hides', cnt.starred > starredList.length, `counts.starred=${cnt.starred} starred list=${starredList.length}`);

    // 5. star on Sent: 200 but no effect
    const s5 = `SENTSTAR-${tok()}`;
    await send(A, B, s5);
    const st = await threadOf(A, 'sent', s5);
    const r5 = await call(A, 'POST', `/api/mail/threads/${st.threadId}/star`, { starred: true });
    const aStarred = (await call(A, 'GET', '/api/mail/threads?folder=starred')).body?.data?.threads ?? [];
    gap('MAIL2 starring a Sent thread returns 200 but stars nothing', r5.status === 200 && !aStarred.some((x) => x.threadId === st.threadId), `status=${r5.status} inStarred=${aStarred.some((x) => x.threadId === st.threadId)}`);

    // 6. cancel scheduled -> recipients destroyed
    const s6 = `SCHED-${tok()}`;
    const sc = await send(A, B, s6, { scheduledAt: new Date(Date.now() + 86_400_000).toISOString() });
    await call(A, 'POST', `/api/mail/messages/${sc.body?.data?.messageId}/cancel`);
    const after6 = (await call(A, 'GET', `/api/mail/threads/${sc.body?.data?.threadId}`)).body?.data?.thread?.messages?.[0];
    gap('MAIL2 cancelling a scheduled send wipes its recipients', after6 && after6.isDraft && after6.to.length === 0, `isDraft=${after6?.isDraft} to=${JSON.stringify(after6?.to)}`);

    // 7. display-name spoofing + no length cap
    const spoof = 'Head Teacher (Official Notice)';
    await call(A, 'PUT', '/api/mail/prefs', { displayName: spoof });
    const s7 = `SPOOF-${tok()}`;
    await send(A, B, s7);
    t = await threadOf(B, 'inbox', s7);
    const fromName = (await call(B, 'GET', `/api/mail/threads/${t.threadId}`)).body?.data?.thread?.messages?.[0]?.from?.name;
    const long = await call(A, 'PUT', '/api/mail/prefs', { displayName: 'X'.repeat(5000) });
    gap('MAIL2 free-text display name shown as sender (spoofable, unbounded)', fromName === spoof && long.status === 200, `B sees from="${fromName}"; 5000-char name status=${long.status} len=${long.body?.data?.prefs?.displayName?.length}`);
    await call(A, 'PUT', '/api/mail/prefs', { displayName: null });

    // 8. no label rename/recolour endpoint
    const r8 = await call(B, 'PATCH', `/api/mail/labels/${lab.id}`, { name: 'renamed', color: '#000000' });
    gap('MAIL2 no API to rename/recolour a label', r8.status === 404, `PATCH /labels/:id → ${r8.status}`);

    // 9. template merge fields go out literally in personal compose
    const s9 = `MERGE-${tok()}`;
    await call(A, 'POST', '/api/mail/compose', { to: [`userId:${B.id}`], subject: `${s9} {{first_name}}`, bodyHtml: '<p>Dear {{first_name}}, fees due.</p>' });
    t = await threadOf(B, 'inbox', s9);
    const body9 = (await call(B, 'GET', `/api/mail/threads/${t.threadId}`)).body?.data?.thread?.messages?.[0]?.bodyHtml;
    gap('MAIL2 template merge tokens delivered literally in personal mail', /\{\{first_name\}\}/.test(body9 ?? ''), `body=${body9}`);

    console.log('\n── Mail UI');
    const ctxB = await ctxFor(browser, B);
    const pB = await ctxB.newPage();
    const errsB = []; pB.on('pageerror', (e) => errsB.push(e.message));
    await pB.goto(`${BASE}/app/mail`, { waitUntil: 'domcontentloaded' });
    await pB.waitForLoadState('networkidle').catch(() => {});
    await sleep(1200);

    // composer seed ignored while a composer is open
    await pB.getByRole('button', { name: /^Compose$/ }).first().click();
    await sleep(500);
    await pB.getByPlaceholder('Subject').fill('FIRST-COMPOSE');
    await pB.getByRole('button', { name: 'Minimise' }).click().catch(() => {});
    await pB.getByText(s4).first().waitFor({ timeout: 4000 }).catch(() => {});
    // open a thread in inbox and click Forward
    const s10 = `FWD-${tok()}`;
    await send(A, B, s10);
    await sleep(2500);
    await pB.getByText(s10).first().click().catch(() => {});
    await sleep(1500);
    await pB.getByRole('button', { name: /Forward/ }).first().click().catch(() => {});
    await sleep(800);
    const minimisedLabel = await pB.locator('button:has-text("FIRST-COMPOSE")').count();
    // expand the composer if minimised
    if (minimisedLabel) await pB.locator('button:has-text("FIRST-COMPOSE")').first().click();
    await sleep(500);
    const subjVal = await pB.getByPlaceholder('Subject').inputValue().catch(() => 'n/a');
    gap('MAIL2 Forward/Compose ignored while a composer is already open', subjVal === 'FIRST-COMPOSE', `subject after Forward="${subjVal}"`);
    await pB.screenshot({ path: `${OUT}/mail-forward-ignored.png`, timeout: 5000 }).catch(() => {});
    await pB.getByRole('button', { name: 'Close' }).first().click().catch(() => {});
    await sleep(500);

    // open thread does not show a new reply live
    const s11 = `LIVE-${tok()}`;
    const r11 = await send(A, B, s11);
    await sleep(2500);
    await pB.goto(`${BASE}/app/mail/t/${r11.body.data.threadId}`, { waitUntil: "domcontentloaded" }); await sleep(2000);
    const m11 = (await call(A, 'GET', `/api/mail/threads/${r11.body.data.threadId}`)).body?.data?.thread?.messages;
    await send(A, B, `Re: ${s11}`, { threadId: r11.body.data.threadId, parentId: m11[0].id, kind: 'reply', bodyHtml: '<p>LIVE-REPLY-BODY</p>' });
    const replyLive = await pB.getByText('LIVE-REPLY-BODY').first().isVisible({ timeout: 100 }).catch(() => false) || await visible(pB, 'LIVE-REPLY-BODY', 6000);
    gap('MAIL2 open thread does not render a new reply live', !replyLive, `reply visible=${replyLive}`);

    // selection cleared when any mail arrives
    await pB.goto(`${BASE}/app/mail`, { waitUntil: "domcontentloaded" }); await sleep(2000);
    await pB.locator('ul input[type=checkbox]').first().check().catch(() => {});
    const selBefore = await visible(pB, '1 selected', 2000);
    await send(A, B, `SEL-${tok()}`);
    await sleep(3500);
    const selAfter = await pB.getByText('1 selected').first().isVisible().catch(() => false);
    gap('MAIL2 incoming mail wipes the user\'s bulk selection', selBefore && !selAfter, `selected before=${selBefore} after=${selAfter}`);

    // no restore / move-to-inbox from Trash or Archive
    await pB.getByRole('button', { name: /^Trash$/ }).first().click(); await sleep(1500);
    await pB.getByText(s4).first().hover().catch(() => {});
    const trashActions = await pB.evaluate(() => [...document.querySelectorAll('ul button[aria-label]')].map((b) => b.getAttribute('aria-label')).filter((x, i, a) => a.indexOf(x) === i));
    await pB.getByText(s4).first().click().catch(() => {}); await sleep(1500);
    const threadActions = await pB.evaluate(() => [...document.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label')).filter((x) => /restore|inbox|not spam|delete|archive/i.test(x)));
    gap('MAIL2 no Restore / Move to Inbox anywhere in Trash', !trashActions.concat(threadActions).some((x) => /restore|inbox/i.test(x)), `row: ${trashActions.join(',')} | thread: ${threadActions.join(',')}`);
    await pB.screenshot({ path: `${OUT}/mail-trash-thread.png`, timeout: 5000 }).catch(() => {});

    // recipient paste of two addresses
    await pB.getByRole('button', { name: /^Compose$/ }).first().click(); await sleep(600);
    const toInput = pB.getByPlaceholder('Name or email address').first();
    await toInput.fill('x1@example.com, x2@example.com');
    await toInput.press('Enter');
    await sleep(300);
    const chips = await pB.locator('span:has(> button[aria-label="Remove"])').count();
    const leftover = await toInput.inputValue();
    gap('MAIL2 pasted address list is not split into chips', chips === 0, `chips=${chips} leftover text="${leftover}"`);
    await pB.screenshot({ path: `${OUT}/mail-paste-recipients.png`, timeout: 5000 }).catch(() => {});
    await pB.getByRole('button', { name: 'Discard draft' }).click().catch(() => {});

    // mobile: per-row actions hidden
    const ctxM = await ctxFor(browser, B, { width: 375, height: 780 });
    const pM = await ctxM.newPage();
    await pM.goto(`${BASE}/app/mail`, { waitUntil: "domcontentloaded" }); await pM.waitForLoadState('networkidle').catch(() => {}); await sleep(1500);
    const rowBtns = await pM.evaluate(() => [...document.querySelectorAll('ul button[aria-label]')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.getAttribute('aria-label')).filter((x, i, a) => a.indexOf(x) === i));
    gap('MAIL2 phone: no per-row archive/delete/unread (only star)', !rowBtns.some((x) => /archive|delete|mark/i.test(x)), `visible row buttons: ${rowBtns.join(',')}`);
    await pM.screenshot({ path: `${OUT}/mail-phone-list.png`, timeout: 5000 }).catch(() => {});
    await ctxM.close();
    console.log('  page errors (mail):', [...new Set(errsB)].slice(0, 5));
    await ctxB.close();
  }

  if (ONLY === 'all' || ONLY === 'feed') {
    console.log('\n── Feed');
    // staff-only page, default-audience post leaks to students
    const pg1 = (await call(ADM, 'POST', '/api/feed/pages', { name: `Staff Room ${tok()}`, audience: 'staff', kind: 'official' })).body?.data?.page;
    pageIds.push(pg1.id);
    await call(ADM, 'POST', `/api/feed/pages/${pg1.id}/editors`, { userId: A.id, role: 'editor' });
    const leakBody = `STAFFROOM-LEAK-${tok()}`;
    const lp = await call(A, 'POST', `/api/feed/pages/${pg1.id}/posts`, { body: leakBody });
    const studentFeed = (await call(S, 'GET', '/api/feed?limit=50')).body?.data?.items ?? [];
    const sPage = await call(S, 'GET', `/api/feed/pages/${pg1.slug}`);
    const sPost = await call(S, 'GET', `/api/feed/posts/${lp.body?.data?.postId}`);
    gap('FEED2 post on a staff-only page (default audience) visible to students', studentFeed.some((p) => p.body === leakBody) || sPost.status === 200,
      `create=${lp.status} in student feed=${studentFeed.some((p) => p.body === leakBody)} student GET post=${sPost.status} student GET page=${sPage.status}`);

    const ctxS = await ctxFor(browser, S);
    const pS = await ctxS.newPage();
    await pS.goto(`${BASE}/app/feed/p/${pg1.slug}`, { waitUntil: "domcontentloaded" }); await sleep(5000);
    const spinner = await pS.locator('.animate-spin').count();
    const notFound = await pS.getByText(/not found|unavailable|not available/i).first().isVisible().catch(() => false);
    gap('FEED2 page profile spins forever when the page is not visible / not found', spinner > 0 && !notFound, `spinners=${spinner} not-found text=${notFound}`);
    await pS.screenshot({ path: `${OUT}/feed-student-staffpage.png`, timeout: 5000 }).catch(() => {});
    await pS.goto(`${BASE}/app/feed/p/no-such-page-${tok()}`, { waitUntil: "domcontentloaded" }); await sleep(4000);
    gap('FEED2 unknown page slug spins forever', (await pS.locator('.animate-spin').count()) > 0, '');
    await ctxS.close();

    // composer default audience on a staff page
    const ctxA = await ctxFor(browser, A);
    const pA = await ctxA.newPage();
    const errsA = []; pA.on('pageerror', (e) => errsA.push(e.message));
    await pA.goto(`${BASE}/app/feed/p/${pg1.slug}`, { waitUntil: "domcontentloaded" }); await pA.waitForLoadState('networkidle').catch(() => {}); await sleep(1500);
    await pA.getByText(/What's on your mind/).first().click().catch(() => {});
    await sleep(500);
    const audVal = await pA.locator('select').first().inputValue().catch(() => 'n/a');
    const audOpts = await pA.locator('select').first().locator('option').allTextContents().catch(() => []);
    gap('FEED2 composer defaults to "Everyone" on a staff-audience page', audVal === 'everyone', `default=${audVal} options=${audOpts.join('/')}`);
    await pA.getByRole('button', { name: 'Close' }).first().click().catch(() => {});
    await sleep(400);

    // collapsed composer "Photo/video" — chosen file never attaches
    await pA.goto(`${BASE}/app/feed`, { waitUntil: "domcontentloaded" }); await pA.waitForLoadState('networkidle').catch(() => {}); await sleep(1500);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    let chooserOk = false;
    try {
      const [fc] = await Promise.all([pA.waitForEvent('filechooser', { timeout: 4000 }), pA.getByRole('button', { name: /Photo\/video/ }).first().click()]);
      await fc.setFiles({ name: 'probe.png', mimeType: 'image/png', buffer: png });
      chooserOk = true;
    } catch (e) { chooserOk = false; }
    await sleep(2500);
    const tiles = await pA.locator('div.aspect-square').count();
    gap('FEED2 collapsed-composer Photo/video: picked file is dropped', chooserOk && tiles === 0, `filechooser=${chooserOk} media tiles=${tiles}`);
    await pA.screenshot({ path: `${OUT}/feed-photo-from-collapsed.png`, timeout: 5000 }).catch(() => {});
    // open composer then attach to confirm the in-modal path works
    let tiles2 = -1;
    try {
      const [fc2] = await Promise.all([pA.waitForEvent('filechooser', { timeout: 4000 }), pA.getByRole('button', { name: 'Photo/video' }).last().click()]);
      await fc2.setFiles({ name: 'probe2.png', mimeType: 'image/png', buffer: png });
      await sleep(2500);
      tiles2 = await pA.locator('div.aspect-square').count();
    } catch {}
    console.log(`     (control: in-modal Photo/video tiles=${tiles2})`);
    await pA.getByRole('button', { name: 'Close' }).first().click().catch(() => {});

    // report twice -> dialog stuck, no message
    const pg2 = (await call(ADM, 'POST', '/api/feed/pages', { name: `Gap2 Pub ${tok()}`, audience: 'everyone' })).body?.data?.page;
    pageIds.push(pg2.id);
    for (let i = 0; i < 24; i++) await call(ADM, 'POST', `/api/feed/pages/${pg2.id}/posts`, { body: `bulk-${i}-${tok()}`, audience: 'everyone' });
    const rp = await call(ADM, 'POST', `/api/feed/pages/${pg2.id}/posts`, { body: `REPORT-ME-${tok()}`, audience: 'everyone' });
    const rpId = rp.body?.data?.postId;
    await call(A, 'POST', `/api/feed/posts/${rpId}/report`, { reason: 'spam' });
    await pA.goto(`${BASE}/app/feed/post/${rpId}`, { waitUntil: "domcontentloaded" }); await pA.waitForLoadState('networkidle').catch(() => {}); await sleep(1500);
    await pA.getByRole('button', { name: 'Post actions' }).first().click();
    await pA.getByText('Report post').first().click(); await sleep(400);
    await pA.getByRole('button', { name: /^Report$/ }).click(); await sleep(1500);
    const stillOpen = await pA.getByText('Report this post').first().isVisible().catch(() => false);
    const msgShown = await pA.getByText(/already reported/i).first().isVisible().catch(() => false);
    gap('FEED2 second report: dialog stays open with no feedback', stillOpen && !msgShown, `dialog open=${stillOpen} message=${msgShown} pageErrors=${errsA.filter((e) => /already/i.test(e)).length}`);
    await pA.screenshot({ path: `${OUT}/feed-report-twice.png`, timeout: 5000 }).catch(() => {});
    await pA.keyboard.press('Escape');

    // load-more failure wipes the feed
    await pA.goto(`${BASE}/app/feed`, { waitUntil: "domcontentloaded" }); await pA.waitForLoadState('networkidle').catch(() => {}); await sleep(1500);
    const cardsBefore = await pA.locator('article.feed-card').count();
    await pA.route(/\/api\/feed\?.*cursor=/, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"error":"boom"}' }));
    await pA.evaluate(() => { const el = document.querySelector('[data-app-scroll]'); el?.scrollTo({ top: el.scrollHeight }); });
    await sleep(2500);
    const cardsAfter = await pA.locator('article.feed-card').count();
    const errCard = await pA.getByText('Could not load the feed').first().isVisible().catch(() => false);
    gap('FEED2 a failed "load more" replaces the whole feed with an error', cardsBefore > 0 && cardsAfter === 0 && errCard, `cards before=${cardsBefore} after=${cardsAfter} errorCard=${errCard}`);
    await pA.screenshot({ path: `${OUT}/feed-loadmore-fail.png`, timeout: 5000 }).catch(() => {});
    await pA.unroute(/\/api\/feed\?.*cursor=/);

    // scroll restoration after opening a permalink and going back
    await pA.goto(`${BASE}/app/feed`, { waitUntil: "domcontentloaded" }); await pA.waitForLoadState('networkidle').catch(() => {}); await sleep(1500);
    await pA.evaluate(() => document.querySelector('[data-app-scroll]')?.scrollTo({ top: 2500 }));
    await sleep(1200);
    const yBefore = await pA.evaluate(() => document.querySelector('[data-app-scroll]')?.scrollTop ?? -1);
    const link = pA.locator('article.feed-card a[href*="/app/feed/post/"]').nth(4);
    await link.scrollIntoViewIfNeeded().catch(() => {});
    const yClick = await pA.evaluate(() => document.querySelector('[data-app-scroll]')?.scrollTop ?? -1);
    await link.click().catch(() => {});
    await sleep(1500);
    await pA.goBack(); await sleep(2500);
    const yAfter = await pA.evaluate(() => document.querySelector('[data-app-scroll]')?.scrollTop ?? -1);
    gap('FEED2 Back from a post loses the feed scroll position', yClick > 600 && yAfter < 200, `scrollTop before=${yBefore} at click=${yClick} after back=${yAfter}`);

    // story seen-state not reflected after viewing
    await call(A, 'POST', '/api/feed/stories', { caption: `STORY-${tok()}`, background: 'linear-gradient(135deg,#2563eb,#7c3aed)' });
    const ctxB2 = await ctxFor(browser, B);
    const pB2 = await ctxB2.newPage();
    await pB2.goto(`${BASE}/app/feed`, { waitUntil: "domcontentloaded" }); await pB2.waitForLoadState('networkidle').catch(() => {}); await sleep(2000);
    const thumb = pB2.locator('button:has-text("Ada")').first();
    const ringBefore = await thumb.locator('span.ring-blue-500').count();
    await thumb.click(); await sleep(7500);
    const viewerStill = await pB2.locator('[role=dialog][aria-modal=true]').count();
    await pB2.keyboard.press('Escape'); await sleep(800);
    const ringAfter = await pB2.locator('button:has-text("Ada")').first().locator('span.ring-blue-500').count();
    gap('FEED2 viewed story still shows the unseen ring until reload', ringBefore === 1 && ringAfter === 1, `ring before=${ringBefore} after=${ringAfter}`);
    gap('FEED2 story viewer never closes at the end (loops/freezes)', viewerStill > 0, `viewer still open after the story ended=${viewerStill > 0}`);
    await pB2.screenshot({ path: `${OUT}/feed-story-after-view.png`, timeout: 5000 }).catch(() => {});
    await ctxB2.close();

    // directory: follow does not update rails
    await pA.goto(`${BASE}/app/feed/pages`, { waitUntil: "domcontentloaded" }); await pA.waitForLoadState('networkidle').catch(() => {}); await sleep(1500);
    const card = pA.locator(`div.rounded-2xl:has-text("${pg2.name}")`).first();
    await card.getByRole('button', { name: /^Follow$/ }).click().catch(() => {});
    await sleep(1200);
    const railHas = await pA.locator('aside').first().getByText(pg2.name).count();
    gap('FEED2 following from the directory does not update the left rail', railHas === 0, `rail mentions page=${railHas}`);
    console.log('  page errors (feed):', [...new Set(errsA)].slice(0, 6));
    await ctxA.close();
  }
} catch (e) {
  console.error('probe crashed:', e);
} finally {
  await browser?.close();
  for (const id of pageIds) await pool.query('UPDATE feed_pages SET deleted_at = now() WHERE id = $1', [id]).catch(() => {});
  await cleanupMailFeed(ids);
  try { await purgeUsers(pool, ids, { quiet: true }); } catch (e) { console.error('cleanup:', e.message); }
  const left = (await pool.query(`SELECT count(*)::int n FROM users WHERE id = ANY($1::text[])`, [ids])).rows[0].n;
  console.log(`  leftover users: ${left}`);
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  await pool.end();
}
