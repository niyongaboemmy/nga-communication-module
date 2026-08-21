#!/usr/bin/env node
/**
 * Chat Phase 5 — mentions, preferences, quiet hours, badges.
 *
 * Phase 2 pinned the audience rules. This pins the parts around them: that a
 * mention resolves to a real member, that `@here` cannot be used by someone
 * without the permission to address everyone, that preferences are whitelisted
 * rather than spread, and that quiet hours suppress the *interruption* without
 * ever suppressing the *record*.
 *
 *   npm run verify:chat:notifications      (needs `npm run dev` running)
 */
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { purgeUsers } from './lib/purge.mjs';

const env = Object.fromEntries(readFileSync('apps/api/.env', 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));

const API = 'http://localhost:5190';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeUser(name, roleName = 'Staff') {
  const id = `chatnot-${randomBytes(6).toString('hex')}`;
  const { rows } = await pool.query('SELECT id FROM roles WHERE name = $1', [roleName]);
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, roleName.toLowerCase(), rows[0]?.id ?? null]);
  const token = jwt.sign(
    { id, misUserId: id, name, email: `${id}@amashuri.com`, role: roleName.toLowerCase() },
    env.JWT_SECRET, { expiresIn: '30m' });
  return { id, name, token };
}

const api = async (path, token, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, data: body.data };
};

const notificationsOf = (userId) => pool.query(
  'SELECT kind, title, body FROM notifications WHERE user_id = $1 ORDER BY created_at DESC',
  [userId]).then((r) => r.rows);
const clearNotifications = (ids) =>
  pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [ids]);

/* ══════════════════════════════════════════════════════════════════════════ */

const alice = await makeUser('Notif Alice');
const bob = await makeUser('Notif Bob');
const carol = await makeUser('Notif Carol');
const pupil = await makeUser('Notif Pupil', 'Student');
const ids = [alice.id, bob.id, carol.id, pupil.id];

try {
  const made = await api('/api/chat/conversations', alice.token, {
    method: 'POST',
    body: JSON.stringify({
      type: 'channel', name: `Notif ${randomBytes(3).toString('hex')}`,
      memberIds: [bob.id, carol.id, pupil.id],
    }),
  });
  const channelId = made.data.conversation.id;
  check('a four-person channel exists', Boolean(channelId));

  const post = async (who, body) => {
    const r = await api(`/api/chat/conversations/${channelId}/messages`, who.token, {
      method: 'POST', body: JSON.stringify({ body, nonce: nonce() }) });
    return r.data?.message;
  };

  /* ── Mentions resolve against membership ───────────────────────────────── */
  step('mentions');

  await clearNotifications(ids);
  const mentioned = await post(alice, `Morning <@${bob.id}>, can you cover period 4?`);
  await sleep(300);

  check('a mention is recorded against the person mentioned',
    (await pool.query('SELECT user_id FROM message_mentions WHERE message_id = $1',
      [mentioned.id])).rows.length === 1);
  check('and only that person is told they were mentioned',
    (await notificationsOf(bob.id)).some((n) => n.kind === 'chat.mention')
      && !(await notificationsOf(carol.id)).some((n) => n.kind === 'chat.mention'));

  const outsider = await makeUser('Notif Outsider');
  ids.push(outsider.id);
  await clearNotifications(ids);
  await post(alice, `Hello <@${outsider.id}>`);
  await sleep(300);
  check('mentioning someone who is not in the channel notifies nobody — an id is not access',
    (await notificationsOf(outsider.id)).length === 0);
  check('and writes no mention row',
    (await pool.query('SELECT 1 FROM message_mentions WHERE user_id = $1',
      [outsider.id])).rows.length === 0);

  const bobBefore = (await api('/api/chat/conversations', bob.token))
    .data.conversations.find((c) => c.id === channelId);
  check('a mention raises the recipient’s mention counter, not just their unread',
    bobBefore.unreadMentions >= 1, String(bobBefore.unreadMentions));

  await api(`/api/chat/conversations/${channelId}/read`, bob.token, {
    method: 'POST', body: JSON.stringify({ seq: bobBefore.lastSeq }) });
  const bobAfter = (await api('/api/chat/conversations', bob.token))
    .data.conversations.find((c) => c.id === channelId);
  check('and reading clears it', bobAfter.unreadMentions === 0, String(bobAfter.unreadMentions));

  /* ── Mention names are resolved everywhere ─────────────────────────────── */
  step('mention names');

  const named = await post(alice, `Please cover for <@${bob.id}> on Friday`);
  check('a message carries resolved names for the ids in its body',
    named.mentionNames?.[bob.id] === 'Notif Bob',
    JSON.stringify(named.mentionNames));

  const sidebar = (await api('/api/chat/conversations', carol.token))
    .data.conversations.find((c) => c.id === channelId);
  check('the sidebar preview shows the real name, not "@mention"',
    sidebar.lastMessage.preview.includes('@Notif Bob'),
    sidebar.lastMessage.preview);
  check('and never leaks the raw id form',
    !sidebar.lastMessage.preview.includes('<@'), sidebar.lastMessage.preview);

  await clearNotifications(ids);
  await post(alice, `Morning <@${carol.id}>, can you take Hall B?`);
  await sleep(300);
  const carolPreview = (await notificationsOf(carol.id))[0];
  check('a notification body names the person mentioned rather than "@someone"',
    carolPreview?.body?.includes('@Notif Carol') === true,
    JSON.stringify(carolPreview?.body));

  const found = await api(
    `/api/chat/search?q=${encodeURIComponent('Hall')}`, carol.token);
  check('search results resolve mentions too',
    found.data.hits.length > 0 && !found.data.hits[0].highlight.includes('<@'),
    JSON.stringify(found.data.hits[0]?.highlight));

  // A mention of a deleted account must degrade, not show a raw id.
  const ghost = await makeUser('Notif Ghost');
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'member')`,
    [channelId, ghost.id]);
  const ghostMsg = await post(alice, `Thanks <@${ghost.id}>`);
  await pool.query('DELETE FROM notifications WHERE user_id = $1', [ghost.id]);
  await pool.query('DELETE FROM message_mentions WHERE user_id = $1', [ghost.id]);
  await pool.query('DELETE FROM conversation_members WHERE user_id = $1', [ghost.id]);
  await pool.query('DELETE FROM users WHERE id = $1', [ghost.id]);

  const reread = (await api(`/api/chat/conversations/${channelId}/messages?limit=10`, alice.token))
    .data.messages.find((m) => m.id === ghostMsg.id);
  check('a mention of a deleted account degrades to a readable placeholder',
    reread.mentionNames[ghost.id] === 'Unknown person',
    JSON.stringify(reread.mentionNames));

  /* ── Broadcast mentions ────────────────────────────────────────────────── */
  step('@here and @channel');

  // Carol goes mentions-only. A broadcast from someone without CHANNEL_ANNOUNCE
  // must not reach her; one from someone with it may.
  await api(`/api/chat/conversations/${channelId}/prefs`, carol.token, {
    method: 'PATCH', body: JSON.stringify({ notification: 'mentions' }) });

  await clearNotifications(ids);
  await post(pupil, 'Everyone look at this @here');
  await sleep(300);
  check('@here from someone without CHANNEL_ANNOUNCE does not pierce "mentions only"',
    (await notificationsOf(carol.id)).length === 0,
    JSON.stringify((await notificationsOf(carol.id)).map((n) => n.kind)));

  await clearNotifications(ids);
  await post(alice, 'Timetable change @channel');
  await sleep(300);
  check('@channel from a staff member with the permission does reach them',
    (await notificationsOf(carol.id)).some((n) => n.kind === 'chat.mention'),
    JSON.stringify((await notificationsOf(carol.id)).map((n) => n.kind)));

  await api(`/api/chat/conversations/${channelId}/prefs`, carol.token, {
    method: 'PATCH', body: JSON.stringify({ notification: 'all' }) });

  /* ── Reaction notifications ────────────────────────────────────────────── */
  step('reactions');

  await clearNotifications(ids);
  const reactTarget = await post(alice, 'Something worth a thumbs-up');
  await api(
    `/api/chat/conversations/${channelId}/messages/${reactTarget.id}/reactions`, bob.token,
    { method: 'POST', body: JSON.stringify({ emoji: '👍' }) });
  await sleep(300);

  check('the author is told when someone reacts to their message',
    (await notificationsOf(alice.id)).some((n) => n.kind === 'chat.reaction'),
    JSON.stringify((await notificationsOf(alice.id)).map((n) => n.kind)));
  check('and nobody else is',
    !(await notificationsOf(carol.id)).some((n) => n.kind === 'chat.reaction'));

  await clearNotifications(ids);
  await api(
    `/api/chat/conversations/${channelId}/messages/${reactTarget.id}/reactions`, alice.token,
    { method: 'POST', body: JSON.stringify({ emoji: '🎉' }) });
  await sleep(300);
  check('reacting to your own message notifies nobody',
    (await notificationsOf(alice.id)).length === 0);

  // Un-reacting must not notify — otherwise a mis-click buzzes twice.
  await clearNotifications(ids);
  await api(
    `/api/chat/conversations/${channelId}/messages/${reactTarget.id}/reactions`, bob.token,
    { method: 'POST', body: JSON.stringify({ emoji: '👍' }) });
  await sleep(300);
  check('removing a reaction is not an event anyone is told about',
    (await notificationsOf(alice.id)).length === 0,
    JSON.stringify((await notificationsOf(alice.id)).map((n) => n.kind)));

  // A reaction is not a mention, and must not pierce "mentions only".
  await api(`/api/chat/conversations/${channelId}/prefs`, alice.token, {
    method: 'PATCH', body: JSON.stringify({ notification: 'mentions' }) });
  await clearNotifications(ids);
  await api(
    `/api/chat/conversations/${channelId}/messages/${reactTarget.id}/reactions`, carol.token,
    { method: 'POST', body: JSON.stringify({ emoji: '🔥' }) });
  await sleep(300);
  check('a reaction does not reach someone on "mentions only" — a thumbs-up is not a mention',
    (await notificationsOf(alice.id)).length === 0);
  await api(`/api/chat/conversations/${channelId}/prefs`, alice.token, {
    method: 'PATCH', body: JSON.stringify({ notification: 'all' }) });

  /* ── Preferences ───────────────────────────────────────────────────────── */
  step('preferences');

  const defaults = await api('/api/chat/prefs', outsider.token);
  check('a user who has never opened settings still has preferences',
    defaults.status === 200 && defaults.data.prefs.sound === true
      && defaults.data.prefs.defaultLevel === 'all',
    JSON.stringify(defaults.data?.prefs));

  const saved = await api('/api/chat/prefs', bob.token, {
    method: 'PATCH',
    body: JSON.stringify({
      sound: false, desktopNotifications: false,
      quietFromMinute: 22 * 60, quietToMinute: 7 * 60,
      timezone: 'Africa/Kigali',
    }),
  });
  check('preferences can be saved', saved.status === 200 && saved.data.prefs.sound === false,
    `${saved.status}`);
  check('and read back', (await api('/api/chat/prefs', bob.token)).data.prefs.quietFromMinute === 1320);

  const junk = await api('/api/chat/prefs', bob.token, {
    method: 'PATCH',
    body: JSON.stringify({ sound: true, role: 'admin', user_id: alice.id, readReceipts: 'yes' }),
  });
  check('unknown fields in a settings body are ignored, not spread into the row',
    junk.status === 200 && junk.data.prefs.sound === true,
    `${junk.status}`);
  check('and a wrongly-typed field does not overwrite a good value',
    junk.data.prefs.readReceipts === true, String(junk.data.prefs.readReceipts));

  const { rows: unchanged } = await pool.query('SELECT role FROM users WHERE id = $1', [bob.id]);
  check('a settings write cannot touch anything outside the settings row',
    unchanged[0].role === 'staff', unchanged[0].role);

  const badLevel = await api('/api/chat/prefs', bob.token, {
    method: 'PATCH', body: JSON.stringify({ defaultLevel: 'shout' }) });
  check('an invalid notification level is refused rather than stored',
    badLevel.data.prefs.defaultLevel !== 'shout', badLevel.data.prefs.defaultLevel);

  const badMinute = await api('/api/chat/prefs', bob.token, {
    method: 'PATCH', body: JSON.stringify({ quietFromMinute: 99999 }) });
  check('an out-of-range quiet hour is discarded',
    badMinute.data.prefs.quietFromMinute === null,
    String(badMinute.data.prefs.quietFromMinute));

  /* ── Quiet hours suppress the interruption, not the record ─────────────── */
  step('quiet hours');

  await api('/api/chat/prefs', bob.token, {
    method: 'PATCH',
    body: JSON.stringify({ quietFromMinute: 0, quietToMinute: 1439 }),
  });
  await clearNotifications(ids);
  await post(alice, 'Sent during Bob’s quiet hours');
  await sleep(300);

  check('a message during quiet hours still writes the notification — it is waiting in the morning',
    (await notificationsOf(bob.id)).length > 0,
    JSON.stringify((await notificationsOf(bob.id)).map((n) => n.kind)));

  const unreadDuringQuiet = await api('/api/chat/unread', bob.token);
  check('and still counts towards the badge',
    unreadDuringQuiet.data.unread > 0, JSON.stringify(unreadDuringQuiet.data));

  /* ── Read receipts opt-out is reciprocal ───────────────────────────────── */
  step('read receipts');

  await api('/api/chat/prefs', carol.token, {
    method: 'PATCH', body: JSON.stringify({ readReceipts: false }) });
  const target = await post(alice, 'Receipt check');
  await api(`/api/chat/conversations/${channelId}/read`, carol.token, {
    method: 'POST', body: JSON.stringify({ seq: target.seq }) });
  await sleep(200);
  check('someone who opted out of read receipts generates none',
    (await pool.query('SELECT 1 FROM message_receipts WHERE message_id = $1 AND user_id = $2',
      [target.id, carol.id])).rows.length === 0);

  await api('/api/chat/prefs', carol.token, {
    method: 'PATCH', body: JSON.stringify({ readReceipts: true }) });
  const target2 = await post(alice, 'Receipt check two');
  await api(`/api/chat/conversations/${channelId}/read`, carol.token, {
    method: 'POST', body: JSON.stringify({ seq: target2.seq }) });
  await sleep(200);
  check('and switching it back on starts generating them again',
    (await pool.query(`SELECT state FROM message_receipts WHERE message_id = $1 AND user_id = $2`,
      [target2.id, carol.id])).rows[0]?.state === 'read');

  /* ── The rail badge ────────────────────────────────────────────────────── */
  step('unread badge');

  const badge = await api('/api/chat/unread', carol.token);
  check('the module badge is one number for everything',
    badge.status === 200 && typeof badge.data.unread === 'number'
      && typeof badge.data.mentions === 'number',
    JSON.stringify(badge.data));

  await api(`/api/chat/conversations/${channelId}/prefs`, carol.token, {
    method: 'PATCH', body: JSON.stringify({ notification: 'none' }) });
  await post(alice, 'Into a silenced channel');
  await sleep(200);
  const silenced = await api('/api/chat/unread', carol.token);
  check('a conversation set to "nothing" does not contribute to the badge',
    silenced.data.unread === 0, JSON.stringify(silenced.data));

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

console.log('\n── Chat Phase 5: notifications ──────────────────────────────\n');
for (const line of pass) console.log('  ' + line);
if (fails.length) { console.log(''); for (const line of fails) console.log('  ' + line); }
console.log(`\n  ${pass.length} passed, ${fails.length} failed\n`);
process.exit(fails.length ? 1 : 0);
