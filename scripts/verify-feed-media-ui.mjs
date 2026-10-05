#!/usr/bin/env node
/**
 * Feed media — drives the real React app in Chromium.
 *
 * Publishes posts with 1–6 real uploads of different shapes through the
 * composer, then checks the social-feed rules: a single photo keeps its own
 * shape within 1.91:1…4:5 with no empty band around it, every picture fills
 * its collage cell, and the viewer opens over the whole screen (not inside
 * the card), edge to edge on a phone, with keys, swipe and swipe-to-close.
 * Writes desktop + phone screenshots to .feed-ui-shots/media-*.png.
 *
 *   npm run verify:feed:media      (needs `npm run dev` running)
 */
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const BASE = 'http://localhost:5194';
const SHOTS = `${ROOT}/.feed-ui-shots`;
mkdirSync(SHOTS, { recursive: true });

const pass = [], fails = [];
const check = (n, ok, d = '') => { (ok ? pass : fails).push(n); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const near = (a, b, tol = 0.03) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

async function makeUser(name, roleName = 'Admin') {
  const id = `feedmedia-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query('SELECT id FROM roles WHERE name = $1', [roleName]);
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, roleName.toLowerCase(), rows[0].id]);
  const perms = (await pool.query(
    `SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`,
    [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: roleName.toLowerCase() };
  return { id, perms, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '30m' }), user, roleName };
}
const seed = (u) => ({
  tupo_token: u.token,
  tupo_user: JSON.stringify(u.user),
  tupo_permissions: JSON.stringify([]),
  tupo_role_permissions: JSON.stringify({ keys: u.perms, name: u.roleName }),
  ["nga.appInstalled"]: '1', // skip the "Install Tupo as an app" prompt
});
// Test tokens carry no MIS session; the app would sign out on the poll.
const stubMisPoll = (ctx) => ctx.route('**/api/sso/verify-mis', (r) =>
  r.fulfill({ json: { success: true, data: { valid: true, degraded: false } } }));
const cleanup = async () => {
  await pool.query(`DELETE FROM feed_posts WHERE body LIKE 'media-%' AND author_id LIKE 'feedmedia-%'`).catch(() => {});
  await pool.query(`DELETE FROM feed_pages WHERE name LIKE 'Media Demo %'`).catch(() => {});
  await pool.query(`DELETE FROM files WHERE owner_id LIKE 'feedmedia-%'`).catch(() => {});
  await pool.query(`DELETE FROM users WHERE id LIKE 'feedmedia-%'`);
};

/* Test pictures of known shapes, drawn by the browser itself. */
const SHAPES = {
  letter: [1240, 1754], land: [1600, 900], land32: [1500, 1000], port: [900, 1350],
  port45: [1080, 1350], square: [1080, 1080], pano: [3000, 800],
};
async function drawImages(page) {
  const dir = mkdtempSync(join(tmpdir(), 'feedmedia-'));
  const files = {};
  for (const [name, [w, h]] of Object.entries(SHAPES)) {
    const b64 = await page.evaluate(({ name, w, h }) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = name === 'letter' ? '#fff' : `hsl(${(w * 7 + h) % 360} 55% 40%)`; g.fillRect(0, 0, w, h);
      g.fillStyle = name === 'letter' ? '#222' : '#fff'; g.font = `bold ${Math.round(w / 16)}px sans-serif`;
      g.fillText(`${name.toUpperCase()} TOP`, w * 0.08, h * 0.12);
      g.fillText('BOTTOM', w * 0.08, h * 0.95);
      if (name === 'letter') for (let y = h * 0.18; y < h * 0.88; y += 44) g.fillRect(w * 0.08, y, w * 0.8, 12);
      return c.toDataURL('image/jpeg', 0.85).split(',')[1];
    }, { name, w, h });
    const path = join(dir, `${name}.jpg`);
    (await import('node:fs')).writeFileSync(path, Buffer.from(b64, 'base64'));
    files[name] = path;
  }
  return files;
}

/** Wave away the "Install Tupo as an app" prompt if it shows. */
async function dismissInstall(page) {
  const notNow = page.getByRole('button', { name: 'Not now' });
  if (await notNow.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)) await notNow.click();
}

async function publish(page, body, paths) {
  await page.getByText(/What's on your mind/i).first().click();
  await page.getByPlaceholder('What would you like to share?').fill(body);
  await page.locator('input[type="file"]').last().setInputFiles(paths);
  const post = page.getByRole('button', { name: /^Post$/ });
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Post');
    return b && !b.disabled;
  }, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  await post.click();
  await page.getByText(body).first().waitFor({ state: 'visible', timeout: 10000 });
}

/** Geometry of a post's media block and its tiles/images. */
const measure = (page, body) => page.evaluate((body) => {
  const card = [...document.querySelectorAll('article.feed-card')].find((a) => a.textContent?.includes(body));
  if (!card) return null;
  const box = card.querySelector('[data-testid="feed-media-single"], [data-testid="feed-media-collage"]');
  const r = box.getBoundingClientRect();
  const tiles = [...box.querySelectorAll('[data-testid="feed-media-tile"]')].map((t) => {
    const tr = t.getBoundingClientRect();
    const img = t.querySelector('img');
    const ir = img?.getBoundingClientRect();
    return { w: tr.width, h: tr.height, img: ir ? { w: ir.width, h: ir.height, loaded: img.complete && img.naturalWidth > 0 } : null };
  });
  return { kind: box.dataset.testid, w: r.width, h: r.height, cardW: card.getBoundingClientRect().width, tiles };
}, body);

async function waitImages(page, body, n) {
  await page.locator('article.feed-card', { hasText: body })
    .locator('[data-testid="feed-media-single"], [data-testid="feed-media-collage"]').scrollIntoViewIfNeeded();
  await page.waitForFunction(({ body, n }) => {
    const card = [...document.querySelectorAll('article.feed-card')].find((a) => a.textContent?.includes(body));
    if (!card) return false;
    const imgs = [...card.querySelectorAll('[data-testid="feed-media-tile"] img')];
    return imgs.length >= n && imgs.every((i) => i.complete && i.naturalWidth > 0);
  }, { body, n }, { timeout: 20000 });
  await page.waitForTimeout(150);
}

let browser;
try {
  await cleanup();
  const ada = await makeUser('Media Ada', 'Admin');
  // The composer only shows for someone with a page to post on.
  await fetch('http://localhost:5190/api/feed/pages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ada.token}` },
    body: JSON.stringify({ name: `Media Demo ${randomBytes(3).toString('hex')}`, audience: 'everyone' }),
  });
  browser = await chromium.launch();

  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, seed(ada));
  await stubMisPoll(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  page error:', e.message));
  await page.goto(`${BASE}/app/feed`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/What's on your mind/i).first().waitFor({ state: 'visible', timeout: 20000 });
  await dismissInstall(page);
  const img = await drawImages(page);

  const tag = randomBytes(2).toString('hex');
  const POSTS = [
    { key: 'letter', files: ['letter'], single: 0.8, top: true },
    { key: 'pano', files: ['pano'], single: 1.91 },
    { key: 'land', files: ['land'], single: 1600 / 900 },
    { key: 'square', files: ['square'], single: 1 },
    { key: 'two-port', files: ['port', 'port45'], collage: 1 },
    { key: 'two-land', files: ['land', 'land32'], collage: 1 },
    { key: 'three-land', files: ['land', 'port', 'square'], collage: 1 },
    { key: 'four-port', files: ['port', 'land', 'square', 'land32'], collage: 1 },
    { key: 'six', files: ['square', 'land', 'port', 'land32', 'port45', 'pano'], collage: 1, more: 1 },
  ];
  // Oldest first so the feed reads top-down in the screenshot.
  for (const p of [...POSTS].reverse()) {
    p.body = `media-${p.key}-${tag}`;
    await publish(page, p.body, p.files.map((f) => img[f]));
  }

  // The Registrar's letter was posted before dimensions were stored: strip
  // them from the letter post so the fallback (measure on load) is covered.
  await pool.query(
    `UPDATE feed_posts SET media = (SELECT jsonb_agg(m - 'w' - 'h') FROM jsonb_array_elements(media) m)
      WHERE body = $1`, [POSTS[0].body]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText(POSTS[0].body).first().waitFor({ timeout: 20000 });
  await dismissInstall(page);

  for (const p of POSTS) {
    const n = Math.min(p.files.length, 5);
    await page.getByText(p.body).first().scrollIntoViewIfNeeded();
    await waitImages(page, p.body, n);
    const m = await measure(page, p.body);
    const ratio = m.w / m.h;
    const want = p.single ?? p.collage;
    check(`${p.key}: block ratio ${ratio.toFixed(2)} ≈ ${want.toFixed(2)}`, near(ratio, want));
    check(`${p.key}: spans the card width`, near(m.w, m.cardW, 0.01), `${m.w}px of ${m.cardW}px`);
    check(`${p.key}: ${n} tile(s), every picture fills its cell`,
      m.tiles.length === n && m.tiles.every((t) => t.img && near(t.img.w, t.w, 0.01) && near(t.img.h, t.h, 0.01)),
      m.tiles.map((t) => `${Math.round(t.w)}×${Math.round(t.h)}/${t.img ? `${Math.round(t.img.w)}×${Math.round(t.img.h)}` : '—'}`).join(' '));
    if (p.top) check(`${p.key}: tall picture anchored to its top`, await page.evaluate((body) => {
      const card = [...document.querySelectorAll('article.feed-card')].find((a) => a.textContent?.includes(body));
      return getComputedStyle(card.querySelector('[data-testid="feed-media-tile"] img')).objectPosition.startsWith('50% 0');
    }, p.body));
    await page.locator('article.feed-card', { hasText: p.body }).screenshot({ path: `${SHOTS}/media-card-${p.key}.png` });
    if (p.more) check(`${p.key}: "+${p.more}" on the last cell`, await page.locator('article.feed-card', { hasText: p.body }).getByText(`+${p.more}`).isVisible());
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}/media-feed-desktop.png`, fullPage: true });

  /* Viewer, desktop */
  const letterCard = page.locator('article.feed-card', { hasText: POSTS[0].body });
  await letterCard.getByTestId('feed-media-tile').first().click();
  const viewer = page.getByTestId('feed-media-viewer');
  await viewer.waitFor({ state: 'visible' });
  await page.waitForTimeout(300); // let the fade-in settle
  const vb = await viewer.boundingBox();
  check('viewer: covers the whole window', vb.x === 0 && vb.y === 0 && vb.width === 1360 && vb.height === 900, JSON.stringify(vb));
  check('viewer: rendered at <body>, outside the card', await page.evaluate(() =>
    document.querySelector('[data-testid="feed-media-viewer"]').parentElement === document.body));
  await page.waitForFunction(() => [...document.querySelectorAll('[data-viewer-media]')].some((i) => i.complete && i.naturalWidth));
  const full = await page.evaluate(() => {
    const i = [...document.querySelectorAll('img[data-viewer-media]')].find((x) => !x.closest('[aria-hidden="true"]'));
    const r = i.getBoundingClientRect(); return { w: r.width, h: r.height };
  });
  check('viewer: whole letter visible (contain, full height)', near(full.w / full.h, 1240 / 1754) && full.h <= 900, `${Math.round(full.w)}×${Math.round(full.h)}`);
  check('viewer: page scroll locked', await page.evaluate(() => document.body.style.overflow === 'hidden'));
  await page.screenshot({ path: `${SHOTS}/media-viewer-desktop.png` });
  await page.keyboard.press('Escape');
  check('viewer: Escape closes', await viewer.waitFor({ state: 'detached', timeout: 2000 }).then(() => true).catch(() => false));
  check('viewer: scroll unlocked after close', await page.evaluate(() => document.body.style.overflow === ''));

  const sixCard = page.locator('article.feed-card', { hasText: POSTS.at(-1).body });
  await sixCard.getByTestId('feed-media-tile').first().click();
  await viewer.waitFor({ state: 'visible' });
  await page.keyboard.press('ArrowRight');
  check('viewer: → advances', await viewer.getByText('2 / 6').isVisible());
  await viewer.getByRole('button', { name: 'Next' }).click();
  await page.waitForTimeout(350);
  check('viewer: Next button advances and keeps it open', await viewer.getByText('3 / 6').isVisible());
  await viewer.getByRole('button', { name: 'Show item 6' }).click();
  check('viewer: thumbnail jumps', await viewer.getByText('6 / 6').isVisible());
  await page.waitForTimeout(400); // let the slide transition finish
  await page.screenshot({ path: `${SHOTS}/media-viewer-gallery-desktop.png` });
  await viewer.getByRole('button', { name: 'Close' }).click();
  await viewer.waitFor({ state: 'detached' });

  /* Phone */
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await m.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, seed(ada));
  await stubMisPoll(m);
  const mp = await m.newPage();
  mp.on('pageerror', (e) => console.log('  page error (phone):', e.message));
  await mp.goto(`${BASE}/app/feed`, { waitUntil: 'domcontentloaded' });
  await mp.getByText(POSTS[0].body).first().waitFor({ timeout: 20000 });
  await dismissInstall(mp);
  for (const p of POSTS.slice(0, 5)) {
    await mp.getByText(p.body).first().scrollIntoViewIfNeeded();
    await waitImages(mp, p.body, Math.min(p.files.length, 5));
    const g = await measure(mp, p.body);
    check(`phone ${p.key}: full width, ratio ${(g.w / g.h).toFixed(2)}`, near(g.w, 390, 0.01) && near(g.w / g.h, p.single ?? p.collage));
  }
  check('phone: no horizontal overflow', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await mp.getByText(POSTS[0].body).first().scrollIntoViewIfNeeded();
  await mp.screenshot({ path: `${SHOTS}/media-feed-phone.png` });

  await mp.locator('article.feed-card', { hasText: POSTS[0].body }).getByTestId('feed-media-tile').first().tap();
  const mv = mp.getByTestId('feed-media-viewer');
  await mv.waitFor({ state: 'visible' });
  await mp.waitForTimeout(300);
  const mb = await mv.boundingBox();
  check('phone viewer: full screen', mb.x === 0 && mb.y === 0 && mb.width === 390 && mb.height === 844, JSON.stringify(mb));
  await mp.waitForFunction(() => [...document.querySelectorAll('img[data-viewer-media]')].some((i) => i.complete && i.naturalWidth));
  const pw = await mp.evaluate(() => document.querySelector('img[data-viewer-media]').getBoundingClientRect().width);
  check('phone viewer: picture is edge to edge', near(pw, 390, 0.01), `${pw}px`);
  await mp.screenshot({ path: `${SHOTS}/media-viewer-phone.png` });

  // Swipe down to close (pointer drag on the stage).
  const swipe = async (dx, dy) => {
    await mp.mouse.move(195, 420); await mp.mouse.down();
    for (let s = 1; s <= 8; s++) await mp.mouse.move(195 + (dx * s) / 8, 420 + (dy * s) / 8);
    await mp.mouse.up();
  };
  await swipe(0, 220);
  check('phone viewer: swipe down closes', await mv.waitFor({ state: 'detached', timeout: 2000 }).then(() => true).catch(() => false));

  await mp.getByText(POSTS[4].body).first().scrollIntoViewIfNeeded();
  await mp.locator('article.feed-card', { hasText: POSTS[4].body }).getByTestId('feed-media-tile').first().tap();
  await mv.waitFor({ state: 'visible' });
  await swipe(-200, 0);
  await mp.waitForTimeout(400);
  check('phone viewer: swipe left shows the next photo', await mv.getByText('2 / 2').isVisible());
  await swipe(-200, 0);
  await mp.waitForTimeout(400);
  check('phone viewer: no wrap past the last photo', await mv.getByText('2 / 2').isVisible());
  await mp.screenshot({ path: `${SHOTS}/media-viewer-phone-2.png` });
  // Backdrop tap closes (above the picture, below the top bar).
  await mp.mouse.click(195, 770);
  check('phone viewer: tap on backdrop closes', await mv.waitFor({ state: 'detached', timeout: 2000 }).then(() => true).catch(() => false));

  await browser.close();
  await cleanup();
  await pool.end();
  console.log(`\n  ${pass.length} passed, ${fails.length} failed · screenshots in .feed-ui-shots/media-*.png`);
  process.exit(fails.length ? 1 : 0);
} catch (e) {
  console.error(e);
  await browser?.close();
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
}
