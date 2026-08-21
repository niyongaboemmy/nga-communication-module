#!/usr/bin/env node
/**
 * Chat Phase 4 — attachments, and who may read them.
 *
 * The access rule is the whole point of this gate. Phase 0 shipped
 * `owner_id = caller`, which meant an attachment was readable by exactly the
 * one person who did not need it. The rule now is: the owner, or a live member
 * of a conversation the file is attached to — checked on **every** request,
 * including the ones made by an `<img>` tag.
 *
 *   npm run verify:chat:files      (needs `npm run dev` running)
 */
import jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { purgeUsers } from './lib/purge.mjs';

const env = Object.fromEntries(readFileSync('apps/api/.env', 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));

const API = 'http://localhost:5190';
const FILES = 'http://localhost:5192';
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

const pass = [], fails = [];
const check = (name, ok, detail = '') => {
  const line = `${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`;
  (ok ? pass : fails).push(line);
  process.stderr.write('  ' + line + '\n');
  return ok;
};
const step = (s) => process.stderr.write(`\n  • ${s}\n`);
const nonce = () => randomBytes(8).toString('hex');

async function makeUser(name, roleName = 'Staff') {
  const id = `chatfile-${randomBytes(6).toString('hex')}`;
  const { rows } = await pool.query('SELECT id FROM roles WHERE name = $1', [roleName]);
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, roleName.toLowerCase(), rows[0]?.id ?? null]);
  const token = jwt.sign(
    { id, misUserId: id, name, email: `${id}@amashuri.com`, role: roleName.toLowerCase() },
    env.JWT_SECRET, { expiresIn: '30m' });
  return { id, name, token };
}

const api = async (base, path, token, init = {}) => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* binary or empty */ }
  return { status: res.status, body, data: body.data, text, headers: res.headers };
};

/** Ticket → PUT bytes → file id. The same three steps the browser makes. */
async function upload(who, name, bytes, mime) {
  const ticket = await api(FILES, '/api/files/tickets', who.token, {
    method: 'POST',
    body: JSON.stringify({ name, size: bytes.length, mime }),
  });
  if (!ticket.data?.fileId) throw new Error(`ticket failed: ${ticket.status} ${ticket.text}`);
  const put = await fetch(`${FILES}${ticket.data.uploadUrl}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': mime },
    body: bytes,
  });
  if (!put.ok) throw new Error(`upload failed: ${put.status}`);
  return ticket.data.fileId;
}

/* ══════════════════════════════════════════════════════════════════════════ */

const alice = await makeUser('File Alice');
const bob = await makeUser('File Bob');
const mallory = await makeUser('File Mallory');
const ids = [alice.id, bob.id, mallory.id];

try {
  const made = await api(API, '/api/chat/conversations', alice.token, {
    method: 'POST',
    body: JSON.stringify({
      type: 'channel', name: `Files ${randomBytes(3).toString('hex')}`, memberIds: [bob.id],
    }),
  });
  const channelId = made.data.conversation.id;
  check('a two-person channel exists', Boolean(channelId));

  /* ── Upload ────────────────────────────────────────────────────────────── */
  step('upload');

  const content = Buffer.from(`timetable ${randomBytes(16).toString('hex')}\n`.repeat(64));
  const checksum = createHash('sha256').update(content).digest('hex');
  const fileId = await upload(alice, 'timetable.txt', content, 'text/plain');
  check('a file can be uploaded', Boolean(fileId));

  const { rows: stored } = await pool.query(
    'SELECT size_bytes, checksum, status FROM files WHERE id = $1', [fileId]);
  check('the stored size matches what was sent',
    Number(stored[0].size_bytes) === content.length,
    `${stored[0].size_bytes} vs ${content.length}`);
  check('and so does the checksum', stored[0].checksum === checksum);
  check('the file is marked ready', stored[0].status === 'ready');

  /* ── Access before it is shared ────────────────────────────────────────── */
  step('access before sharing');

  const ownerRead = await api(FILES, `/api/files/${fileId}/content`, alice.token);
  check('the uploader can read their own file before attaching it',
    ownerRead.status === 200 && ownerRead.text === content.toString(),
    String(ownerRead.status));

  const strangerEarly = await api(FILES, `/api/files/${fileId}/content`, bob.token);
  check('nobody else can, even a channel-mate — it has not been shared yet',
    strangerEarly.status === 404, String(strangerEarly.status));

  const anon = await api(FILES, `/api/files/${fileId}/content`, null);
  check('and an unauthenticated request is refused', anon.status === 401, String(anon.status));

  /* ── Attaching grants access ───────────────────────────────────────────── */
  step('attaching grants access');

  const sent = await api(API, `/api/chat/conversations/${channelId}/messages`, alice.token, {
    method: 'POST',
    body: JSON.stringify({ body: 'Here is the timetable', nonce: nonce(), attachments: [fileId] }),
  });
  check('a message can carry an attachment',
    sent.status === 201 && sent.data.message.attachments.length === 1,
    `${sent.status} ${sent.body.message ?? ''}`);
  check('the attachment arrives classified and sized',
    sent.data.message.attachments[0].kind === 'document'
      && sent.data.message.attachments[0].size === content.length,
    JSON.stringify(sent.data.message.attachments[0]));

  const recipientRead = await api(FILES, `/api/files/${fileId}/content`, bob.token);
  check('a recipient can now read it — this is the bug Phase 0 shipped',
    recipientRead.status === 200 && recipientRead.text === content.toString(),
    String(recipientRead.status));

  const outsiderRead = await api(FILES, `/api/files/${fileId}/content`, mallory.token);
  check('someone outside the conversation still cannot',
    outsiderRead.status === 404, String(outsiderRead.status));

  const outsiderMeta = await api(FILES, `/api/files/${fileId}`, mallory.token);
  check('nor read its name — a file name can be as revealing as the file',
    outsiderMeta.status === 404, String(outsiderMeta.status));

  /* ── Access is live, not granted once ──────────────────────────────────── */
  step('access follows membership');

  await pool.query(
    `UPDATE conversation_members SET left_at = now()
      WHERE conversation_id = $1 AND user_id = $2`, [channelId, bob.id]);
  const afterLeaving = await api(FILES, `/api/files/${fileId}/content`, bob.token);
  check('leaving the conversation takes the file with it',
    afterLeaving.status === 404, String(afterLeaving.status));

  await pool.query(
    `UPDATE conversation_members SET left_at = NULL
      WHERE conversation_id = $1 AND user_id = $2`, [channelId, bob.id]);
  check('and rejoining restores it',
    (await api(FILES, `/api/files/${fileId}/content`, bob.token)).status === 200);

  await api(API,
    `/api/chat/conversations/${channelId}/messages/${sent.data.message.id}`, alice.token,
    { method: 'DELETE' });
  const afterMessageDeleted = await api(FILES, `/api/files/${fileId}/content`, bob.token);
  check('deleting the message that carried it revokes the recipient’s access',
    afterMessageDeleted.status === 404, String(afterMessageDeleted.status));
  check('though the uploader still has their own copy',
    (await api(FILES, `/api/files/${fileId}/content`, alice.token)).status === 200);

  /* ── Media tickets ─────────────────────────────────────────────────────── */
  step('media tickets');

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const imageId = await upload(alice, 'photo.png', png, 'image/png');
  await api(API, `/api/chat/conversations/${channelId}/messages`, alice.token, {
    method: 'POST',
    body: JSON.stringify({ body: '', nonce: nonce(), attachments: [imageId] }),
  });

  const ticket = await api(FILES, `/api/files/${imageId}/ticket`, bob.token, { method: 'POST' });
  check('a member can mint a media ticket', ticket.status === 200 && Boolean(ticket.data.token),
    String(ticket.status));
  check('it is short-lived', ticket.data.expiresIn <= 120, String(ticket.data.expiresIn));

  const viaTicket = await fetch(
    `${FILES}/api/files/${imageId}/content?inline=1&t=${encodeURIComponent(ticket.data.token)}`);
  check('an <img> can load the file with no Authorization header',
    viaTicket.status === 200, String(viaTicket.status));
  check('and it is served inline rather than as a download',
    (viaTicket.headers.get('content-disposition') ?? '').startsWith('inline'),
    viaTicket.headers.get('content-disposition') ?? '');

  const outsiderTicket = await api(FILES, `/api/files/${imageId}/ticket`, mallory.token,
    { method: 'POST' });
  check('an outsider cannot mint one', outsiderTicket.status === 404, String(outsiderTicket.status));

  // The ticket is an identity, not a capability: the ACL still runs.
  const bobsTicket = ticket.data.token;
  await pool.query(
    `UPDATE conversation_members SET left_at = now()
      WHERE conversation_id = $1 AND user_id = $2`, [channelId, bob.id]);
  const staleTicket = await fetch(
    `${FILES}/api/files/${imageId}/content?t=${encodeURIComponent(bobsTicket)}`);
  check('a ticket stops working the moment its holder loses access — it is not a signed link',
    staleTicket.status === 404, String(staleTicket.status));
  await pool.query(
    `UPDATE conversation_members SET left_at = NULL
      WHERE conversation_id = $1 AND user_id = $2`, [channelId, bob.id]);

  const wrongFile = await fetch(
    `${FILES}/api/files/${fileId}/content?t=${encodeURIComponent(bobsTicket)}`);
  check('a ticket for one file cannot be replayed against another',
    wrongFile.status === 401, String(wrongFile.status));

  /* ── Serving rules ─────────────────────────────────────────────────────── */
  step('serving rules');

  const html = Buffer.from('<script>window.__x=1</script>');
  const htmlId = await upload(alice, 'evil.html', html, 'text/html');
  await api(API, `/api/chat/conversations/${channelId}/messages`, alice.token, {
    method: 'POST', body: JSON.stringify({ body: 'doc', nonce: nonce(), attachments: [htmlId] }),
  });
  const served = await api(FILES, `/api/files/${htmlId}/content?inline=1`, bob.token);
  check('uploaded HTML is never served inline, even when inline is asked for',
    (served.headers.get('content-disposition') ?? '').startsWith('attachment'),
    served.headers.get('content-disposition') ?? '');
  check('and is served with nosniff',
    served.headers.get('x-content-type-options') === 'nosniff');

  const ranged = await fetch(`${FILES}/api/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${alice.token}`, Range: 'bytes=0-9' },
  });
  check('range requests are honoured — video is unusable without them',
    ranged.status === 206, String(ranged.status));
  check('and return exactly the bytes asked for',
    (await ranged.text()).length === 10);
  check('with a correct Content-Range',
    (ranged.headers.get('content-range') ?? '').startsWith('bytes 0-9/'),
    ranged.headers.get('content-range') ?? '');

  /* ── Attachment authorisation on send ──────────────────────────────────── */
  step('attaching someone else’s upload');

  const alicesPrivate = await upload(alice, 'private.txt', Buffer.from('mine'), 'text/plain');
  const theft = await api(API, `/api/chat/conversations/${channelId}/messages`, bob.token, {
    method: 'POST',
    body: JSON.stringify({ body: 'look', nonce: nonce(), attachments: [alicesPrivate] }),
  });
  check('you cannot attach a file id you do not own', theft.status === 403, String(theft.status));

  const ghost = await api(API, `/api/chat/conversations/${channelId}/messages`, bob.token, {
    method: 'POST',
    body: JSON.stringify({ body: 'look', nonce: nonce(), attachments: ['404404404'] }),
  });
  check('nor one that does not exist', ghost.status === 404, String(ghost.status));

  /* ── Metadata ──────────────────────────────────────────────────────────── */
  step('media metadata');

  const meta = await api(FILES, `/api/files/${imageId}/metadata`, alice.token, {
    method: 'PATCH',
    body: JSON.stringify({ width: 1920, height: 1080, waveform: [0.5, 2, -1], durationMs: 4000 }),
  });
  check('presentation metadata can be attached', meta.status === 200, String(meta.status));
  check('and out-of-range waveform values are clamped rather than trusted',
    JSON.stringify(meta.data.metadata.waveform) === JSON.stringify([0.5, 1, 0]),
    JSON.stringify(meta.data.metadata.waveform));

  const foreignMeta = await api(FILES, `/api/files/${imageId}/metadata`, bob.token, {
    method: 'PATCH', body: JSON.stringify({ width: 1 }) });
  check('only the uploader may set it', foreignMeta.status === 403, String(foreignMeta.status));

  /* ── The Files tab ─────────────────────────────────────────────────────── */
  step('conversation file list');

  const listed = await api(FILES, `/api/files/conversations/${channelId}`, bob.token);
  check('a member can list what has been shared',
    listed.status === 200 && listed.data.files.length >= 2,
    `${listed.status} ${listed.data?.files?.length}`);
  check('and each entry points back at the message it came from',
    listed.data.files.every((f) => Boolean(f.messageId && f.senderName)));
  check('a deleted message’s attachment drops out of the list',
    !listed.data.files.some((f) => f.id === fileId));

  const outsiderList = await api(FILES, `/api/files/conversations/${channelId}`, mallory.token);
  check('a non-member cannot list it', outsiderList.status === 404, String(outsiderList.status));

  const filtered = await api(FILES, `/api/files/conversations/${channelId}?kind=image`, bob.token);
  check('the list can be filtered to media',
    filtered.data.files.every((f) => f.kind === 'image'),
    JSON.stringify(filtered.data.files.map((f) => f.kind)));

  /* ── Deletion ──────────────────────────────────────────────────────────── */
  step('deletion');

  const outsiderDelete = await api(FILES, `/api/files/${imageId}`, mallory.token,
    { method: 'DELETE' });
  check('an outsider cannot delete a file', outsiderDelete.status === 404,
    String(outsiderDelete.status));

  const ownerDelete = await api(FILES, `/api/files/${imageId}`, alice.token, { method: 'DELETE' });
  check('the uploader can', ownerDelete.status === 200, String(ownerDelete.status));
  check('and it stops being readable afterwards',
    (await api(FILES, `/api/files/${imageId}/content`, bob.token)).status === 404);

} catch (err) {
  fails.push(`❌ threw: ${err instanceof Error ? err.stack : err}`);
} finally {
  // One helper, in dependency order, each step in its own try/catch — see
  // scripts/lib/purge.mjs for why the previous inline version leaked users on
  // every interrupted run.
  try { await pool.query('DELETE FROM files WHERE owner_id = ANY($1::text[])', [ids]); } catch { /* files may not reference these */ }
  await purgeUsers(pool, ids);
  await pool.end();
}

console.log('\n── Chat Phase 4: files and media ────────────────────────────\n');
for (const line of pass) console.log('  ' + line);
if (fails.length) { console.log(''); for (const line of fails) console.log('  ' + line); }
console.log(`\n  ${pass.length} passed, ${fails.length} failed\n`);
process.exit(fails.length ? 1 : 0);
