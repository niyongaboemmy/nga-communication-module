#!/usr/bin/env node
/**
 * Chat Phase 2 — reactions, edits, deletions, receipts, notifications.
 *
 * The rules worth pinning are the ones about *authority* and *audience*:
 * who may change a message once it is sent, what survives a deletion, and —
 * the one that decides whether people keep notifications switched on — who
 * gets told.
 *
 *   npm run verify:chat:live       (needs `npm run dev` running)
 */
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { io as ioClient } from 'socket.io-client';

const env = Object.fromEntries(readFileSync('apps/api/.env', 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));

const API = 'http://localhost:5190';
const WS = 'http://localhost:5191';
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
  const id = `chatlive-${randomBytes(6).toString('hex')}`;
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

const connect = (token) => new Promise((resolve, reject) => {
  const s = ioClient(WS, { auth: { token }, transports: ['websocket'], reconnection: false });
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
  setTimeout(() => reject(new Error('socket timeout')), 6000);
});

const waitFor = (socket, event, ms = 2500) => new Promise((resolve) => {
  const t = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
  const handler = (p) => { clearTimeout(t); socket.off(event, handler); resolve(p); };
  socket.on(event, handler);
});

const notificationsOf = (userId) => pool.query(
  `SELECT kind, title, body FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`,
  [userId]).then((r) => r.rows);

/* ══════════════════════════════════════════════════════════════════════════ */

const alice = await makeUser('Live Alice');
const bob = await makeUser('Live Bob');
const carol = await makeUser('Live Carol');
const mod = await makeUser('Live Moderator', 'Moderator');

let sockets = [];
const ids = [alice.id, bob.id, carol.id, mod.id];

try {
  const made = await api('/api/chat/conversations', alice.token, {
    method: 'POST',
    body: JSON.stringify({
      type: 'channel', name: `Live ${randomBytes(3).toString('hex')}`,
      memberIds: [bob.id, carol.id, mod.id],
    }),
  });
  const channelId = made.data.conversation.id;
  check('a four-person channel exists', Boolean(channelId), `${made.status}`);

  const post = async (who, body, extra = {}) => {
    const r = await api(`/api/chat/conversations/${channelId}/messages`, who.token, {
      method: 'POST', body: JSON.stringify({ body, nonce: nonce(), ...extra }),
    });
    return r.data?.message;
  };

  /* ── Reactions ─────────────────────────────────────────────────────────── */
  step('reactions');

  const target = await post(alice, 'React to this');
  const reactUrl = `/api/chat/conversations/${channelId}/messages/${target.id}/reactions`;

  const r1 = await api(reactUrl, bob.token, { method: 'POST', body: JSON.stringify({ emoji: '👍' }) });
  check('a reaction can be added',
    r1.status === 200 && r1.data?.added === true && r1.data.reactions[0]?.count === 1,
    JSON.stringify(r1.data?.reactions));

  const r2 = await api(reactUrl, carol.token, { method: 'POST', body: JSON.stringify({ emoji: '👍' }) });
  check('a second person adds to the same pill rather than making a new one',
    r2.data.reactions.length === 1 && r2.data.reactions[0].count === 2,
    JSON.stringify(r2.data?.reactions));

  const r3 = await api(reactUrl, bob.token, { method: 'POST', body: JSON.stringify({ emoji: '👍' }) });
  check('reacting again removes your own — it is a toggle',
    r3.data?.added === false && r3.data.reactions[0].count === 1);

  const r4 = await api(reactUrl, bob.token, { method: 'POST', body: JSON.stringify({ emoji: '🎉' }) });
  check('different emoji are counted separately', r4.data.reactions.length === 2);

  const mineView = await api(
    `/api/chat/conversations/${channelId}/messages?limit=5`, carol.token);
  const asCarol = mineView.data.messages.find((m) => m.id === target.id);
  check('"mine" is resolved per viewer',
    asCarol.reactions.find((r) => r.emoji === '👍')?.mine === true
      && asCarol.reactions.find((r) => r.emoji === '🎉')?.mine === false);

  const outsider = await makeUser('Live Outsider');
  ids.push(outsider.id);
  const denied = await api(reactUrl, outsider.token, {
    method: 'POST', body: JSON.stringify({ emoji: '👍' }) });
  check('a non-member cannot react', denied.status === 404, String(denied.status));

  const junk = await api(reactUrl, bob.token, {
    method: 'POST', body: JSON.stringify({ emoji: 'x'.repeat(200) }) });
  check('the emoji column cannot be used as free storage', junk.status === 400, String(junk.status));

  /* ── Editing ───────────────────────────────────────────────────────────── */
  step('editing');

  const editable = await post(alice, 'Original text');
  const editUrl = `/api/chat/conversations/${channelId}/messages/${editable.id}`;

  const edited = await api(editUrl, alice.token, {
    method: 'PATCH', body: JSON.stringify({ body: 'Corrected text' }) });
  check('an author can edit their own message',
    edited.status === 200 && edited.data.message.body === 'Corrected text',
    `${edited.status}`);
  check('an edit is marked as one', Boolean(edited.data.message.editedAt));

  const notMine = await api(editUrl, bob.token, {
    method: 'PATCH', body: JSON.stringify({ body: 'I rewrote your words' }) });
  check('nobody else can edit it', notMine.status === 403, String(notMine.status));

  const byMod = await api(editUrl, mod.token, {
    method: 'PATCH', body: JSON.stringify({ body: 'Moderator rewrite' }) });
  check('not even a moderator can rewrite someone’s words — removing is not rewriting',
    byMod.status === 403, String(byMod.status));

  const emptied = await api(editUrl, alice.token, {
    method: 'PATCH', body: JSON.stringify({ body: '   ' }) });
  check('an edit cannot empty a message — that is a deletion', emptied.status === 400);

  const history = await api(`${editUrl}/history`, bob.token);
  check('the previous version is kept',
    history.data.versions.length === 1 && history.data.versions[0].body === 'Original text',
    JSON.stringify(history.data.versions.map((v) => v.body)));

  // Age the message past the edit window and try again.
  await pool.query(
    `UPDATE messages SET created_at = now() - interval '25 hours'
      WHERE conversation_id = $1 AND id = $2`, [channelId, editable.id]);
  const tooLate = await api(editUrl, alice.token, {
    method: 'PATCH', body: JSON.stringify({ body: 'Much later' }) });
  check('the edit window is enforced', tooLate.status === 409, String(tooLate.status));

  /* ── Deleting ──────────────────────────────────────────────────────────── */
  step('deleting');

  const doomed = await post(bob, 'Delete me');
  const delUrl = `/api/chat/conversations/${channelId}/messages/${doomed.id}`;

  const byStranger = await api(delUrl, carol.token, { method: 'DELETE' });
  check('an ordinary member cannot delete someone else’s message',
    byStranger.status === 403, String(byStranger.status));

  const own = await api(delUrl, bob.token, { method: 'DELETE' });
  check('an author can delete their own', own.status === 200 && own.data.deleted === true);
  check('deleting your own is not a moderation action', own.data.byModerator === false);

  const after = await api(`/api/chat/conversations/${channelId}/messages?limit=50`, carol.token);
  const tomb = after.data.messages.find((m) => m.id === doomed.id);
  check('the message survives as a tombstone, keeping its place in the sequence',
    Boolean(tomb) && tomb.seq === doomed.seq);
  check('a deleted message discloses no body', tomb.body === null, JSON.stringify(tomb.body));
  check('and no attachments or reactions', tomb.attachments.length === 0 && tomb.reactions.length === 0);

  const modTarget = await post(carol, 'Something a moderator removes');
  const modDel = await api(
    `/api/chat/conversations/${channelId}/messages/${modTarget.id}`, mod.token, { method: 'DELETE' });
  check('a moderator can remove someone else’s message',
    modDel.status === 200 && modDel.data.byModerator === true,
    `${modDel.status} ${modDel.body.message ?? ''}`);

  await sleep(200);
  const { rows: audited } = await pool.query(
    `SELECT action, target_id, metadata FROM audit_log
      WHERE action = 'chat.message.delete_other' AND target_id = $1`, [modTarget.id]);
  check('removing someone else’s words is always on the record',
    audited.length === 1, `${audited.length} audit rows`);

  const twice = await api(
    `/api/chat/conversations/${channelId}/messages/${modTarget.id}`, mod.token, { method: 'DELETE' });
  check('deleting twice is refused, not repeated', twice.status === 409, String(twice.status));

  /* ── Unread arithmetic after a deletion ────────────────────────────────── */
  step('unread after deletion');

  const solo = await api('/api/chat/conversations', alice.token, {
    method: 'POST',
    body: JSON.stringify({ type: 'channel', name: `Del ${randomBytes(3).toString('hex')}`, memberIds: [bob.id] }),
  });
  const soloId = solo.data.conversation.id;
  const a1 = await api(`/api/chat/conversations/${soloId}/messages`, alice.token, {
    method: 'POST', body: JSON.stringify({ body: 'one', nonce: nonce() }) });
  await api(`/api/chat/conversations/${soloId}/messages`, alice.token, {
    method: 'POST', body: JSON.stringify({ body: 'two', nonce: nonce() }) });

  let bobView = (await api('/api/chat/conversations', bob.token))
    .data.conversations.find((c) => c.id === soloId);
  check('two messages, two unread', bobView.unread === 2, String(bobView.unread));

  await api(`/api/chat/conversations/${soloId}/messages/${a1.data.message.id}`, alice.token,
    { method: 'DELETE' });
  bobView = (await api('/api/chat/conversations', bob.token))
    .data.conversations.find((c) => c.id === soloId);
  check('deleting one drops the unread count to match',
    bobView.unread === 1, String(bobView.unread));

  /* ── Notifications ─────────────────────────────────────────────────────── */
  step('notifications');

  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [ids]);

  const dm = await api('/api/chat/conversations/direct', alice.token, {
    method: 'POST', body: JSON.stringify({ userId: bob.id }) });
  await api(`/api/chat/conversations/${dm.data.conversation.id}/messages`, alice.token, {
    method: 'POST', body: JSON.stringify({ body: 'A direct message', nonce: nonce() }) });
  await sleep(300);

  let bobNotes = await notificationsOf(bob.id);
  check('a direct message always notifies',
    bobNotes.some((n) => n.kind === 'chat.dm'), JSON.stringify(bobNotes.map((n) => n.kind)));

  const aliceNotes = await notificationsOf(alice.id);
  check('nobody is ever notified about their own message', aliceNotes.length === 0,
    JSON.stringify(aliceNotes.map((n) => n.kind)));

  // Carol sets the channel to mentions-only; Bob leaves it on all.
  await api(`/api/chat/conversations/${channelId}/prefs`, carol.token, {
    method: 'PATCH', body: JSON.stringify({ notification: 'mentions' }) });
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [ids]);

  await post(alice, 'An ordinary channel message');
  await sleep(300);

  check('an ordinary channel message notifies members on "all"',
    (await notificationsOf(bob.id)).some((n) => n.kind === 'chat.message'));
  check('and stays silent for a member on "mentions only"',
    (await notificationsOf(carol.id)).length === 0,
    JSON.stringify((await notificationsOf(carol.id)).map((n) => n.kind)));

  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [ids]);
  await post(alice, `Please look at this <@${carol.id}>`);
  await sleep(300);

  const carolNotes = await notificationsOf(carol.id);
  check('a mention reaches someone on "mentions only" — that is what the level means',
    carolNotes.some((n) => n.kind === 'chat.mention'),
    JSON.stringify(carolNotes.map((n) => n.kind)));

  // And "none" means none.
  await api(`/api/chat/conversations/${channelId}/prefs`, carol.token, {
    method: 'PATCH', body: JSON.stringify({ notification: 'none' }) });
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [ids]);
  await post(alice, `Ignoring your setting <@${carol.id}>`);
  await sleep(300);
  check('a mention does NOT pierce "notify me about nothing"',
    (await notificationsOf(carol.id)).length === 0,
    JSON.stringify((await notificationsOf(carol.id)).map((n) => n.kind)));

  // A burst collapses to one row rather than stacking.
  await api(`/api/chat/conversations/${channelId}/prefs`, carol.token, {
    method: 'PATCH', body: JSON.stringify({ notification: 'all' }) });
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [ids]);
  for (let i = 0; i < 5; i++) await post(alice, `burst ${i}`);
  await sleep(400);
  const burstNotes = (await notificationsOf(carol.id)).filter((n) => n.kind === 'chat.message');
  check('five messages in a row produce one notification, not five',
    burstNotes.length === 1, `${burstNotes.length} rows`);

  // Muting for a period silences even that.
  await api(`/api/chat/conversations/${channelId}/prefs`, bob.token, {
    method: 'PATCH', body: JSON.stringify({ mutedUntil: new Date(Date.now() + 3600_000).toISOString() }) });
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [ids]);
  await post(alice, 'While muted');
  await sleep(300);
  check('"mute for an hour" actually means an hour',
    (await notificationsOf(bob.id)).length === 0);

  /* ── Realtime ──────────────────────────────────────────────────────────── */
  step('realtime');

  const aliceSock = await connect(alice.token);
  const bobSock = await connect(bob.token);
  sockets = [aliceSock, bobSock];
  for (const s of sockets) {
    await new Promise((r) => s.emit('conversation:subscribe', { conversationIds: [channelId] }, r));
  }

  const liveTarget = await post(alice, 'Live reaction target');
  const reactionEvent = waitFor(bobSock, 'message:reaction', 3000);
  const reactAck = await new Promise((r) => aliceSock.emit('message:react', {
    conversationId: channelId, messageId: liveTarget.id, emoji: '🔥',
  }, r));
  check('a reaction over the socket is acknowledged', reactAck?.ok === true);
  const gotReaction = await reactionEvent;
  check('and reaches the room live',
    gotReaction?.messageId === liveTarget.id && gotReaction.reactions[0]?.emoji === '🔥',
    JSON.stringify(gotReaction));

  const editEvent = waitFor(bobSock, 'message:updated', 3000);
  await new Promise((r) => aliceSock.emit('message:edit', {
    conversationId: channelId, messageId: liveTarget.id, body: 'Edited live',
  }, r));
  const gotEdit = await editEvent;
  check('an edit reaches the room live', gotEdit?.message?.body === 'Edited live',
    JSON.stringify(gotEdit?.message?.body));

  const deleteEvent = waitFor(bobSock, 'message:deleted', 3000);
  await new Promise((r) => aliceSock.emit('message:delete', {
    conversationId: channelId, messageId: liveTarget.id,
  }, r));
  const gotDelete = await deleteEvent;
  check('a deletion reaches the room live', gotDelete?.messageId === liveTarget.id);

  /* ── Presence ──────────────────────────────────────────────────────────── */
  step('presence');

  // Alice and Bob share a DM, so Bob is an audience for Alice's presence.
  const presenceEvent = waitFor(bobSock, 'presence:update', 4000);
  const carolSock = await connect(carol.token);
  sockets.push(carolSock);
  const carolPresence = await presenceEvent;
  check('presence is not broadcast to people with no DM with you',
    carolPresence === null || carolPresence.userId !== carol.id,
    JSON.stringify(carolPresence));

  const dmPresence = waitFor(bobSock, 'presence:update', 4000);
  await new Promise((r) => aliceSock.emit('presence:set', { status: 'busy' }, r));
  const gotPresence = await dmPresence;
  check('a DM counterpart is told when your presence changes',
    gotPresence?.userId === alice.id && gotPresence.status === 'busy',
    JSON.stringify(gotPresence));

  /* ── Read receipts ─────────────────────────────────────────────────────── */
  step('receipts');

  const receiptTarget = await post(alice, 'Has this been read?');
  await api(`/api/chat/conversations/${channelId}/read`, bob.token, {
    method: 'POST', body: JSON.stringify({ seq: receiptTarget.seq }) });
  await sleep(200);

  const { rows: receipts } = await pool.query(
    `SELECT state FROM message_receipts WHERE message_id = $1 AND user_id = $2`,
    [receiptTarget.id, bob.id]);
  check('reading a message records a read receipt',
    receipts[0]?.state === 'read', JSON.stringify(receipts));

  // Carol opts out; a later read must produce nothing.
  await pool.query(
    `INSERT INTO user_chat_prefs (user_id, read_receipts) VALUES ($1, false)
     ON CONFLICT (user_id) DO UPDATE SET read_receipts = false`, [carol.id]);
  const second = await post(alice, 'Second receipt target');
  await api(`/api/chat/conversations/${channelId}/read`, carol.token, {
    method: 'POST', body: JSON.stringify({ seq: second.seq }) });
  await sleep(200);
  const { rows: none } = await pool.query(
    `SELECT 1 FROM message_receipts WHERE message_id = $1 AND user_id = $2`,
    [second.id, carol.id]);
  check('someone who has turned read receipts off does not generate them',
    none.length === 0, `${none.length} rows`);

  const stillUnread = (await api('/api/chat/conversations', carol.token))
    .data.conversations.find((c) => c.id === channelId);
  check('but their own unread still clears — the opt-out is about others seeing, not about reading',
    stillUnread.unread === 0, String(stillUnread.unread));

} catch (err) {
  fails.push(`❌ threw: ${err instanceof Error ? err.stack : err}`);
} finally {
  for (const s of sockets) s.close();
  await pool.query(
    `DELETE FROM conversations WHERE created_by = ANY($1::text[]) OR id IN (
       SELECT conversation_id FROM conversation_members WHERE user_id = ANY($1::text[]))`, [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [ids]);
  await pool.end();
}

console.log('\n── Chat Phase 2: live ───────────────────────────────────────\n');
for (const line of pass) console.log('  ' + line);
if (fails.length) { console.log(''); for (const line of fails) console.log('  ' + line); }
console.log(`\n  ${pass.length} passed, ${fails.length} failed\n`);
process.exit(fails.length ? 1 : 0);
