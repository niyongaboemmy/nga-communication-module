#!/usr/bin/env node
/**
 * verify:feed:experience — the feed interaction plan (docs/FEED_EXPERIENCE_PLAN_2026-11.md):
 *
 *   F-01/02  a new page photo reaches the sidebar and the page's posts, no reload
 *   F-03     in-post video: unmute/mute, time left, progress
 *   F-04     the viewer continues from the inline position
 *   F-05     composer link preview; previews published; script links refused
 *   F-06     PDF preview in the app, readable sizes, download busy state
 *   F-07     share sheet: send in chat (card for the recipient), copy-link fallback,
 *            a post the recipient may not see stays hidden
 *   F-08     delete asks in-app and removes at once; move to drafts says where
 *   F-09     a failed feed load offers Try again, which works
 *   F-10     See more / See less
 *
 *   npm run verify:feed:experience       (needs `npm run dev`)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createSuite, sleep, waitTrue, API } from './lib/chatSuite.mjs';

const FILES = 'http://localhost:5192';
const SHOTS = process.argv[2] ?? '.feed-visual';
mkdirSync(SHOTS, { recursive: true });
const S = createSuite('verify:feed:experience', 'vcx-');
const part = async (name, fn) => {
  S.step(name);
  try { await fn(); } catch (e) { S.check(`${name} ran`, false, String(e?.message ?? e).split('\n')[0]); }
};

/* Test media */
const dir = mkdtempSync(join(tmpdir(), 'feedexp-'));
const photo = join(dir, 'photo.jpg');
writeFileSync(photo, await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#2563eb' } }).jpeg().toBuffer());
const avatarPng = join(dir, 'avatar.png');
writeFileSync(avatarPng, await sharp({ create: { width: 400, height: 400, channels: 3, background: '#16a34a' } }).png().toBuffer());
const video = join(dir, 'clip.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '8', '-pix_fmt', 'yuv420p', '-shortest', video]);
const pdfBytes = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

async function upload(u, name, mime, bytes) {
  const t = await (await fetch(`${FILES}/api/files/tickets`, {
    method: 'POST', headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, mime, size: bytes.length }),
  })).json();
  const put = await fetch(`${FILES}${t.data.uploadUrl}`, { method: 'PUT', headers: { authorization: `Bearer ${u.token}` }, body: bytes });
  if (!put.ok) throw new Error(`upload ${name} → ${put.status}`);
  return t.data.fileId;
}
const { readFileSync } = await import('node:fs');

try {
  await S.launch();
  const ada = await S.makeUser('Ada Feedx', 'Admin');
  const bosco = await S.makeUser('Bosco Feedx', 'Staff');
  const stud = await S.makeUser('Sam Student', 'Student');
  const pg = (await S.api('/api/feed/pages', ada, { body: { name: `Exp Page ${Date.now() % 10000}`, audience: 'everyone' } })).page;
  const post = (payload) => S.api(`/api/feed/pages/${pg.id}/posts`, ada, { body: { audience: 'everyone', status: 'published', ...payload } });

  const videoId = await upload(ada, 'clip.mp4', 'video/mp4', readFileSync(video));
  const pdfId = await upload(ada, 'Timetable.pdf', 'application/pdf', pdfBytes);
  const imgId = await upload(ada, 'photo.jpg', 'image/jpeg', readFileSync(photo));
  const pText = await post({ body: `Plain update ${Date.now()}` });
  const pVideo = await post({ body: 'Robot demo video', media: [{ fileId: videoId, kind: 'video', name: 'clip.mp4', w: 640, h: 360 }] });
  const pDoc = await post({ body: 'Timetable attached', media: [{ fileId: pdfId, kind: 'document', name: 'Timetable.pdf', size: pdfBytes.length }] });
  const pPhoto = await post({ body: 'Science fair photo', media: [{ fileId: imgId, kind: 'image', name: 'photo.jpg', w: 1200, h: 900 }] });
  const pLong = await post({ body: `${'This is a long announcement line. '.repeat(16)}THE END` });
  const pStaff = await post({ body: 'Staff-only briefing', audience: 'staff' });
  const pDel = await post({ body: 'Post to delete' });
  const pDraft = await post({ body: 'Post to move to drafts' });
  // Everyone follows the page so it is in their rails.
  for (const u of [bosco, stud]) await S.api(`/api/feed/pages/${pg.id}/follow`, u, { body: {} }).catch(() => {});

  const { page, ctx } = await S.openAs(ada, null);
  const feedUrl = page.url().split('/app/')[0] + '/app/feed';
  await page.goto(feedUrl, { waitUntil: 'domcontentloaded' });
  await page.getByText(/What's on your mind/i).first().waitFor({ timeout: 25000 });
  const nn = page.getByRole('button', { name: 'Not now' }); if (await nn.isVisible().catch(() => false)) await nn.click();
  const card = (text) => page.locator('article').filter({ hasText: text }).first();

  await part('F-10 See more / See less', async () => {
    const c = card('long announcement line');
    await c.scrollIntoViewIfNeeded();
    await c.getByRole('button', { name: 'See more' }).click();
    S.check('See more expands', await c.getByText('THE END').isVisible());
    await c.getByRole('button', { name: 'See less' }).click();
    S.check('See less collapses again', await c.getByRole('button', { name: 'See more' }).isVisible());
  });

  await part('F-03 in-post video controls', async () => {
    const c = card('Robot demo video');
    await c.scrollIntoViewIfNeeded();
    const timeLeft = c.getByTestId('video-time-left');
    S.check('time left is shown', await timeLeft.waitFor({ timeout: 10000 }).then(() => true).catch(() => false)
      && /\d:\d\d/.test(await timeLeft.innerText()), await timeLeft.innerText().catch(() => ''));
    const unmute = c.getByRole('button', { name: 'Unmute video' });
    S.check('an unmute switch is there', await unmute.isVisible());
    await unmute.click();
    await sleep(400);
    S.check('unmuting turns the sound on', await c.locator('video').evaluate((v) => v.muted === false));
    await sleep(1500);
    const w = await c.getByTestId('video-progress').evaluate((el) => parseFloat(el.style.width));
    S.check('progress moves', w > 0, `${w}%`);
    await c.getByRole('button', { name: 'Mute video' }).click();
    await sleep(300);
    S.check('mute turns it off again', await c.locator('video').evaluate((v) => v.muted === true));
    await page.screenshot({ path: `${SHOTS}/video-inline.png` });
  });

  await part('F-04 viewer continues from the inline position', async () => {
    const c = card('Robot demo video');
    const at = await c.locator('video').evaluate((v) => v.currentTime);
    await c.getByRole('button', { name: 'Play video' }).click();
    const vv = page.locator('[data-viewer-media]').filter({ has: page.locator('video') }).first();
    const viewerVideo = page.locator('video[data-viewer-media]').first();
    await viewerVideo.waitFor({ timeout: 8000 });
    await sleep(1200);
    const t = await viewerVideo.evaluate((v) => v.currentTime);
    S.check('viewer starts where the post was', t >= Math.max(0.5, at - 0.5), `inline ${at.toFixed(1)}s → viewer ${t.toFixed(1)}s`);
    void vv;
    await page.keyboard.press('Escape');
    await sleep(400);
  });

  await part('F-06 document preview, sizes, download', async () => {
    const c = card('Timetable attached');
    await c.scrollIntoViewIfNeeded();
    const txt = await c.innerText();
    S.check('size reads in bytes/KB, not "0.0 MB"', !/0\.0 MB/.test(txt) && /\d+ (B|KB)/.test(txt), txt.match(/\d+(\.\d)? ?(B|KB|MB)/)?.[0]);
    await c.getByRole('button', { name: /Preview Timetable\.pdf/ }).click();
    const dlg = page.getByRole('dialog', { name: /Preview of Timetable\.pdf/ });
    S.check('PDF opens in an in-app preview', await dlg.waitFor({ timeout: 6000 }).then(() => true).catch(() => false));
    S.check('preview shows the document', await dlg.locator('iframe').waitFor({ timeout: 8000 }).then(() => true).catch(() => false));
    S.check('preview offers Download', await dlg.getByRole('button', { name: 'Download' }).isVisible());
    await page.screenshot({ path: `${SHOTS}/document-preview.png` });
    await page.keyboard.press('Escape');
  });

  await part('F-07 share sheet: copy-link fallback, send in chat', async () => {
    const dm = (await S.api('/api/chat/conversations/direct', ada, { body: { userId: bosco.id } })).conversation;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText(/What's on your mind/i).first().waitFor({ timeout: 20000 });
    const c = card('Science fair photo');
    await c.scrollIntoViewIfNeeded();
    await c.getByRole('button', { name: /Share/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Share post' });
    S.check('Share opens a sheet', await sheet.waitFor({ timeout: 4000 }).then(() => true).catch(() => false));
    await sheet.getByRole('button', { name: /Copy link/ }).click();
    const copiedOrShown = await waitTrue(page, () => Boolean(document.querySelector('#share-link')) || /Copied/.test(document.body.innerText), null, 3000);
    S.check('copy link copies, or shows the link to copy by hand', copiedOrShown);
    await page.screenshot({ path: `${SHOTS}/share-sheet.png` });
    const send = sheet.getByRole('button', { name: `Send to ${bosco.name}` });
    await send.waitFor({ timeout: 6000 });
    await send.click();
    S.check('send in chat confirms', await sheet.getByRole('button', { name: `Sent to ${bosco.name}` }).waitFor({ timeout: 6000 }).then(() => true).catch(() => false));
    await page.keyboard.press('Escape');
    const after = (await S.api(`/api/feed/posts/${pPhoto.postId}`, ada)).post;
    S.check('the share is counted', after.shareCount >= 1, `shareCount=${after.shareCount}`);

    const b = await S.openAs(bosco, dm);
    const shared = b.page.getByTestId('post-share-card').first();
    S.check('the recipient sees a card of the post', await shared.waitFor({ timeout: 10000 }).then(() => true).catch(() => false));
    S.check('the card shows the post', /Science fair photo/.test(await shared.innerText().catch(() => '')));
    await b.page.screenshot({ path: `${SHOTS}/chat-post-card.png` });

    // A staff-only post shared to a student shows nothing of it.
    const dm2 = (await S.api('/api/chat/conversations/direct', ada, { body: { userId: stud.id } })).conversation;
    await S.api(`/api/chat/conversations/${dm2.id}/messages`, ada, { body: { body: 'see this', nonce: `x${Date.now()}`, type: 'post_share', metadata: { postId: pStaff.postId } } });
    const s2 = await S.openAs(stud, dm2);
    S.check('a post the reader may not see stays hidden',
      await s2.page.getByTestId('post-share-unavailable').first().waitFor({ timeout: 10000 }).then(() => true).catch(() => false)
      && !(await s2.page.getByText('Staff-only briefing').count()));
  });

  await part('F-05 link preview: composer card and safety', async () => {
    await page.getByText(/What's on your mind/i).first().click();
    const box = page.getByPlaceholder('What would you like to share?');
    await box.fill('Worth reading https://example.com');
    const prev = page.getByTestId('composer-link-preview');
    const shown = await prev.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
    S.check('the composer starts a link preview', shown);
    const titled = await waitTrue(page, () => /Example Domain/i.test(document.querySelector('[data-testid="composer-link-preview"]')?.textContent ?? ''), null, 12000);
    S.check('the preview card shows the page title (needs internet)', titled);
    if (titled) {
      await page.getByRole('button', { name: /^Post$/ }).click();
      const pc = card('Worth reading');
      await pc.waitFor({ timeout: 10000 });
      S.check('the published post carries the preview', await pc.locator('a[target="_blank"]').filter({ hasText: /Example Domain/i }).count() > 0);
    } else {
      await page.keyboard.press('Escape');
    }
    const bad = await S.api(`/api/feed/pages/${pg.id}/posts`, ada, { body: { body: 'bad link', status: 'published', linkPreview: { url: 'javascript:alert(1)', title: 'x' } } });
    const stored = (await S.api(`/api/feed/posts/${bad.postId}`, ada)).post;
    S.check('a script link preview is refused by the server', stored.linkPreview === null, JSON.stringify(stored.linkPreview));
  });

  await part('F-08 delete and move to drafts', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText(/What's on your mind/i).first().waitFor({ timeout: 20000 });
    const c = card('Post to delete');
    await c.scrollIntoViewIfNeeded();
    await c.getByRole('button', { name: 'Post actions' }).click();
    await page.getByRole('button', { name: 'Delete post' }).click();
    const dlg = page.getByRole('alertdialog').filter({ hasText: 'Delete this post?' });
    S.check('delete asks in the app', await dlg.waitFor({ timeout: 3000 }).then(() => true).catch(() => false));
    await dlg.getByRole('button', { name: 'Delete', exact: true }).click();
    S.check('the post leaves at once', await c.waitFor({ state: 'detached', timeout: 1500 }).then(() => true).catch(() => false));
    await sleep(800);
    const gone = await fetch(`${API}/api/feed/posts/${pDel.postId}`, { headers: { Authorization: `Bearer ${ada.token}` } });
    S.check('and is deleted on the server', gone.status === 404 || gone.status === 410, `HTTP ${gone.status}`);

    const d = card('Post to move to drafts');
    await d.scrollIntoViewIfNeeded();
    await d.getByRole('button', { name: 'Post actions' }).click();
    await page.getByRole('button', { name: 'Move to drafts' }).click();
    S.check('moving to drafts removes it at once', await d.waitFor({ state: 'detached', timeout: 1500 }).then(() => true).catch(() => false));
    const open = page.getByRole('button', { name: 'Open drafts' });
    S.check('and says where it went', await open.waitFor({ timeout: 5000 }).then(() => true).catch(() => false));
    await open.click();
    S.check('"Open drafts" lands on the drafts tab', await page.getByRole('tab', { name: /Drafts/ }).waitFor({ timeout: 8000 }).then(async () =>
      (await page.getByRole('tab', { name: /Drafts/ }).getAttribute('aria-selected')) === 'true').catch(() => false));
  });

  await part('F-01 a new page photo reaches the feed without a reload', async () => {
    await page.goto(`${feedUrl}/p/${pg.slug}`, { waitUntil: 'domcontentloaded' });
    const btn = page.getByRole('button', { name: 'Change page photo' });
    await btn.waitFor({ timeout: 10000 });
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), btn.click()]);
    await chooser.setFiles(avatarPng);
    await page.getByText('Page photo updated').first().waitFor({ timeout: 15000 }).catch(() => {});
    await page.getByRole('link', { name: /Back to feed/ }).first().click();
    await page.getByText(/What's on your mind/i).first().waitFor({ timeout: 10000 });
    const railHasPhoto = await waitTrue(page, (name) => {
      const row = [...document.querySelectorAll('a')].find((a) => a.textContent?.trim() === name && a.querySelector('img'));
      return Boolean(row);
    }, pg.name, 4000);
    S.check('the sidebar shows the new photo', railHasPhoto);
    const postHasPhoto = await waitTrue(page, (txt) => {
      const art = [...document.querySelectorAll('article')].find((a) => a.textContent?.includes(txt));
      return Boolean(art?.querySelector('header img'));
    }, 'Plain update', 4000);
    S.check("the page's posts show the new photo", postHasPhoto);
    await page.screenshot({ path: `${SHOTS}/after-avatar.png` });
  });

  await part('F-09 a failed feed load offers Try again', async () => {
    // A fresh browser: with a copy of the feed on the device, a failed load
    // keeps showing it (local-first) instead of an error — by design.
    let fail = true;
    const fresh = await S.openAs(bosco, null);
    await fresh.ctx.route((u) => u.pathname === '/api/feed', (route) => (fail ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"message":"Down for a moment"}' }) : route.fallback()));
    await fresh.page.goto(feedUrl, { waitUntil: 'domcontentloaded' });
    const retry = fresh.page.getByRole('button', { name: 'Try again' });
    S.check('the error offers Try again', await retry.waitFor({ timeout: 10000 }).then(() => true).catch(() => false));
    fail = false;
    await retry.click();
    S.check('Try again loads the feed', await fresh.page.locator('article').filter({ hasText: 'Plain update' }).first().waitFor({ timeout: 10000 }).then(() => true).catch(() => false));
    void pText; void pDraft;
  });
} catch (e) {
  S.check('suite ran to the end', false, String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '));
} finally {
  await S.pool.query("DELETE FROM feed_pages WHERE name LIKE 'Exp Page %'").catch(() => {});
  await S.finish();
}
