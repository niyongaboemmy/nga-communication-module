#!/usr/bin/env node
/**
 * Pictures that do not jump and do not download twice (P-05), end to end:
 *
 *   - an uploaded photo gets real dimensions, a blurhash and a WebP thumbnail
 *     far smaller than the original;
 *   - a picture that predates thumbnails gets one on first request (backfill);
 *   - a GIF is served as itself (a thumbnail would freeze it);
 *   - a message carries the blurhash, and the chat shows the thumbnail;
 *   - the service worker keeps the picture: a reload does not fetch it again,
 *     even with a new ticket; signing out deletes that cache.
 *
 *   npm run verify:media      (needs `npm run dev`)
 */
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
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
const API = 'http://localhost:5190', FILES = 'http://localhost:5192', BASE = 'http://localhost:5194';
const results = []; const ids = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const tag = randomBytes(3).toString('hex');

async function makeUser(name) {
  const id = `vmd-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = 'Staff'`);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`, [id, name, `${id}@amashuri.com`, rows[0].id]);
  ids.push(id);
  const perms = (await pool.query(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = $1`, [rows[0].id])).rows.map((r) => r.key);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' };
  return { id, user, perms, token: jwt.sign(user, env.JWT_SECRET, { expiresIn: '60m' }) };
}
const auth = (u) => ({ authorization: `Bearer ${u.token}` });
async function upload(u, name, mime, buf) {
  const t = await (await fetch(`${FILES}/api/files/tickets`, { method: 'POST', headers: { ...auth(u), 'content-type': 'application/json' }, body: JSON.stringify({ name, mime, size: buf.length }) })).json();
  const put = await fetch(`${FILES}${t.data.uploadUrl}`, { method: 'PUT', headers: { ...auth(u), 'content-type': 'application/octet-stream' }, body: buf });
  return { fileId: t.data.fileId, body: await put.json(), ms: 0 };
}
async function content(u, fileId, thumb) {
  const tk = await (await fetch(`${FILES}/api/files/${fileId}/ticket`, { method: 'POST', headers: auth(u) })).json();
  const r = await fetch(`${FILES}/api/files/${fileId}/content?inline=1${thumb ? '&thumb=1' : ''}&t=${encodeURIComponent(tk.data.token)}`);
  return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), bytes: (await r.arrayBuffer()).byteLength };
}

let browser;
try {
  const me = await makeUser(`Mia Media ${tag}`);
  const peer = await makeUser(`Pat Peer ${tag}`);

  // A real photo-sized JPEG with detail, so the thumbnail saving is honest.
  const noise = Buffer.alloc(3000 * 2000 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24 ^ (i % 3000);
  const photo = await sharp(noise, { raw: { width: 3000, height: 2000, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();

  console.log('\nUpload');
  const t0 = Date.now();
  const up = await upload(me, `photo-${tag}.jpg`, 'image/jpeg', photo);
  const uploadMs = Date.now() - t0;
  check('the upload answers with the real size and a blurhash', up.body.data?.width === 3000 && up.body.data?.height === 2000 && typeof up.body.data?.blurhash === 'string',
    `${up.body.data?.width}×${up.body.data?.height} ${up.body.data?.blurhash} in ${uploadMs} ms`);
  const orig = await content(me, up.fileId, false);
  const thumb = await content(me, up.fileId, true);
  check('the thumbnail is WebP and far smaller than the original', thumb.type === 'image/webp' && thumb.bytes * 5 < orig.bytes,
    `${Math.round(orig.bytes / 1024)} KB → ${Math.round(thumb.bytes / 1024)} KB`);
  check('content is cacheable as immutable (and private)', /private/.test(thumb.cache) && /immutable/.test(thumb.cache), thumb.cache);

  console.log('\nBackfill and exceptions');
  const old = await upload(me, `old-${tag}.png`, 'image/png', await sharp({ create: { width: 900, height: 600, channels: 3, background: '#3366cc' } }).png().toBuffer());
  await pool.query(`UPDATE files SET metadata = metadata - 'thumb' - 'blurhash' WHERE id = $1`, [old.fileId]);
  const lazy = await content(me, old.fileId, true);
  const meta = (await pool.query(`SELECT metadata FROM files WHERE id = $1`, [old.fileId])).rows[0].metadata;
  check('an older picture gets its thumbnail on first request', lazy.type === 'image/webp' && meta.thumb === true && !!meta.blurhash);
  const gif = await upload(me, `anim-${tag}.gif`, 'image/gif', await sharp({ create: { width: 40, height: 40, channels: 3, background: '#ff0000' } }).gif().toBuffer());
  const gifThumb = await content(me, gif.fileId, true);
  check('a GIF is served as itself, not frozen into a thumbnail', gifThumb.type === 'image/gif', gifThumb.type);

  console.log('\nIn a conversation');
  const conv = (await (await fetch(`${API}/api/chat/conversations`, { method: 'POST', headers: { ...auth(peer), 'content-type': 'application/json' }, body: JSON.stringify({ type: 'group', name: `Media ${tag}`, memberIds: [me.id] }) })).json()).data.conversation;
  const sent = await (await fetch(`${API}/api/chat/conversations/${conv.id}/messages`, { method: 'POST', headers: { ...auth(me), 'content-type': 'application/json' }, body: JSON.stringify({ body: `photo ${tag}`, nonce: randomUUID(), attachments: [up.fileId] }) })).json();
  const att = sent.data?.message?.attachments?.[0];
  check('the message carries dimensions and the blurhash', att?.width === 3000 && att?.blurhash === up.body.data?.blurhash, JSON.stringify({ w: att?.width, h: att?.height, b: att?.blurhash }));

  browser = prepareBrowser(await chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, {
    tupo_token: me.token, tupo_user: JSON.stringify(me.user), tupo_permissions: '[]',
    tupo_role_permissions: JSON.stringify({ keys: me.perms, name: 'Staff' }) });
  const page = await ctx.newPage();
  const hits = [];
  page.on('response', (r) => { if (r.url().includes(`/api/files/${up.fileId}/content`)) hits.push({ url: r.url(), sw: r.fromServiceWorker() }); });
  // The service worker must be in control before its cache can be tested.
  await page.goto(`${BASE}/app/chat?c=${conv.id}`);
  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15_000 }).catch(() => {});
  await page.reload();
  const tile = page.getByRole('button', { name: `Open photo-${tag}.jpg` });
  await tile.waitFor({ timeout: 15_000 });
  const img = tile.locator('img');
  await img.waitFor({ timeout: 10_000 });
  const src = await img.getAttribute('src');
  check('the chat shows the thumbnail, not the original', /thumb=1/.test(src ?? ''), src?.replace(/t=[^&]+/, 't=…'));
  const bg = await tile.evaluate((el) => getComputedStyle(el).backgroundImage);
  check('with the blurhash as its placeholder', bg.startsWith('url("data:image/png'));
  await page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await img.elementHandle(), { timeout: 10_000 });

  hits.length = 0;
  await page.reload();
  await page.getByRole('button', { name: `Open photo-${tag}.jpg` }).locator('img').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1_500);
  const network = hits.filter((h) => !h.sw);
  check('a reload shows the picture from the service worker, not the network', hits.length > 0 && network.length === 0,
    `${hits.length} loads, ${network.length} from the network`);

  const before = await page.evaluate(async () => (await caches.keys()).includes('tupo-media-v1'));
  await page.evaluate(async () => { (await import('/src/lib/api.ts')).clearSession(); await new Promise((r) => setTimeout(r, 500)); });
  const after = await page.evaluate(async () => (await caches.keys()).includes('tupo-media-v1'));
  check('signing out deletes the picture cache', before && !after);

  await pool.query('DELETE FROM conversations WHERE id = $1', [conv.id]).catch(() => {});
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  await browser?.close();
  await pool.query(`DELETE FROM files WHERE owner_id = ANY($1)`, [ids]).catch(() => {});
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:media: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
