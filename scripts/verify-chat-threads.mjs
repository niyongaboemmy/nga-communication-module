#!/usr/bin/env node
/**
 * Chat Phase 3 — threads, quote-replies, pins, saves, forwarding, permalinks.
 *
 * The property that matters most here is *containment*: a thread must not leak
 * into the main flow, a forward must not lose attribution, and a saved message
 * must not outlive the access that allowed it to be saved.
 *
 *   npm run verify:chat:threads      (needs `npm run dev` running)
 */
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync('apps/api/.env', 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

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
  const id = `chatthr-${randomBytes(6).toString('hex')}`;
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

/* ══════════════════════════════════════════════════════════════════════════ */

const alice = await makeUser('Thread Alice');
const bob = await makeUser('Thread Bob');
const carol = await makeUser('Thread Carol');
const ids = [alice.id, bob.id, carol.id];

try {
  const made = await api('/api/chat/conversations', alice.token, {
    method: 'POST',
    body: JSON.stringify({
      type: 'channel', name: `Threads ${randomBytes(3).toString('hex')}`,
      memberIds: [bob.id, carol.id],
    }),
  });
  const channelId = made.data.conversation.id;

  const other = await api('/api/chat/conversations', alice.token, {
    method: 'POST',
    body: JSON.stringify({
      type: 'channel', name: `Target ${randomBytes(3).toString('hex')}`, memberIds: [bob.id],
    }),
  });
  const targetId = other.data.conversation.id;
  check('two channels exist', Boolean(channelId && targetId));

  const post = async (who, conv, body, extra = {}) => {
    const r = await api(`/api/chat/conversations/${conv}/messages`, who.token, {
      method: 'POST', body: JSON.stringify({ body, nonce: nonce(), ...extra }),
    });
    return r.data?.message;
  };

  /* ── Threads ───────────────────────────────────────────────────────────── */
  step('threads');

  const root = await post(alice, channelId, 'Shall we move the practical to Thursday?');
  const replyUrl = `/api/chat/conversations/${channelId}/messages/${root.id}/replies`;

  const r1 = await api(replyUrl, bob.token, {
    method: 'POST', body: JSON.stringify({ body: 'Thursday works for me', nonce: nonce() }) });
  check('a reply can be posted into a thread', r1.status === 201, `${r1.status} ${r1.body.message ?? ''}`);
  check('the reply carries the thread root', r1.data.message.threadRootId === root.id);
  check('the root reports its reply count', r1.data.root?.replyCount === 1,
    String(r1.data.root?.replyCount));

  await api(replyUrl, carol.token, {
    method: 'POST', body: JSON.stringify({ body: 'Not for me, I have Lab 2', nonce: nonce() }) });

  const mainFlow = await api(
    `/api/chat/conversations/${channelId}/messages?limit=50`, alice.token);
  const leaked = mainFlow.data.messages.filter((m) => m.threadRootId);
  check('thread replies do NOT appear in the main channel flow — the point of threads',
    leaked.length === 0, `${leaked.length} leaked`);

  const threadView = await api(
    `/api/chat/conversations/${channelId}/messages?thread=${root.id}&limit=50`, alice.token);
  check('the thread view returns the root plus its replies',
    threadView.data.messages.length === 3
      && threadView.data.messages.some((m) => m.id === root.id),
    `${threadView.data.messages.length} messages`);

  // Replying to a reply must thread onto the same root rather than nesting.
  const nested = await api(
    `/api/chat/conversations/${channelId}/messages/${r1.data.message.id}/replies`, alice.token,
    { method: 'POST', body: JSON.stringify({ body: 'Good, settled', nonce: nonce() }) });
  check('replying to a reply joins the same thread rather than nesting a second level',
    nested.data.message.threadRootId === root.id, nested.data.message.threadRootId);

  // "Also send to channel" puts one copy in the room and keeps the thread intact.
  const beforeEcho = (await api(`/api/chat/conversations/${channelId}/messages?limit=50`, alice.token))
    .data.messages.length;
  await api(replyUrl, alice.token, {
    method: 'POST',
    body: JSON.stringify({ body: 'Decision: Thursday.', nonce: nonce(), alsoSendToChannel: true }) });
  const afterEcho = (await api(`/api/chat/conversations/${channelId}/messages?limit=50`, alice.token))
    .data.messages;
  check('"also send to channel" puts exactly one copy in the main flow',
    afterEcho.length === beforeEcho + 1, `${beforeEcho} → ${afterEcho.length}`);
  check('and the reply still belongs to the thread',
    (await api(`/api/chat/conversations/${channelId}/messages?thread=${root.id}&limit=50`, alice.token))
      .data.messages.length === 5);

  // Thread participants are notified; a silent bystander is not.
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [ids]);
  const quiet = await makeUser('Thread Bystander');
  ids.push(quiet.id);
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'member')`,
    [channelId, quiet.id]);
  await api(`/api/chat/conversations/${channelId}/prefs`, quiet.token, {
    method: 'PATCH', body: JSON.stringify({ notification: 'mentions' }) });

  await api(replyUrl, bob.token, {
    method: 'POST', body: JSON.stringify({ body: 'One more thought', nonce: nonce() }) });
  await sleep(300);

  const carolNotes = await pool.query(
    'SELECT kind FROM notifications WHERE user_id = $1', [carol.id]);
  check('someone who spoke in a thread is notified of new replies',
    carolNotes.rows.length > 0, JSON.stringify(carolNotes.rows.map((r) => r.kind)));

  const quietNotes = await pool.query(
    'SELECT kind FROM notifications WHERE user_id = $1', [quiet.id]);
  check('someone on "mentions only" who never spoke in it is not',
    quietNotes.rows.length === 0, JSON.stringify(quietNotes.rows.map((r) => r.kind)));

  /* ── Quote replies ─────────────────────────────────────────────────────── */
  step('quote replies');

  const quoted = await post(alice, channelId, 'The bus leaves at 07:30');
  const answer = await post(bob, channelId, 'Understood', { replyToId: quoted.id });
  check('a quote-reply records what it answers', answer.replyTo?.id === quoted.id);
  check('and carries the quoted text, so no second fetch is needed',
    answer.replyTo?.body === 'The bus leaves at 07:30', answer.replyTo?.body);
  check('a quote-reply stays in the main flow — it is not a thread',
    answer.threadRootId === null);

  await api(`/api/chat/conversations/${channelId}/messages/${quoted.id}`, alice.token,
    { method: 'DELETE' });
  const afterDelete = (await api(`/api/chat/conversations/${channelId}/messages?limit=50`, bob.token))
    .data.messages.find((m) => m.id === answer.id);
  check('deleting the quoted message leaves the quote marked deleted, not showing its text',
    afterDelete.replyTo?.deleted === true && afterDelete.replyTo?.body === null,
    JSON.stringify(afterDelete.replyTo));

  /* ── Pins ──────────────────────────────────────────────────────────────── */
  step('pins');

  const pinTarget = await post(alice, channelId, 'Exam timetable: see attached');
  const pinUrl = `/api/chat/conversations/${channelId}/messages/${pinTarget.id}/pin`;

  const pinned = await api(pinUrl, alice.token, { method: 'POST', body: JSON.stringify({ pinned: true }) });
  check('a message can be pinned', pinned.status === 200 && Boolean(pinned.data.message.pinnedAt),
    `${pinned.status}`);

  const pins = await api(`/api/chat/conversations/${channelId}/pins`, bob.token);
  check('the pinned list is visible to every member',
    pins.data.messages.some((m) => m.id === pinTarget.id));

  await sleep(150);
  const { rows: pinNotice } = await pool.query(
    `SELECT body FROM messages WHERE conversation_id = $1 AND type = 'system'
      AND metadata->>'event' = 'pinned'`, [channelId]);
  check('pinning is announced in the room, not just in the header',
    pinNotice.length === 1, `${pinNotice.length} notices`);

  // Carol is Staff, and Staff legitimately holds MESSAGE_PIN — testing the
  // permission against her proved nothing. A Student is the role that does not.
  const pupil = await makeUser('Thread Pupil', 'Student');
  ids.push(pupil.id);
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'member')`,
    [channelId, pupil.id]);
  const noPerm = await api(pinUrl, pupil.token,
    { method: 'POST', body: JSON.stringify({ pinned: false }) });
  check('pinning is permissioned — a role without MESSAGE_PIN is refused',
    noPerm.status === 403, String(noPerm.status));

  const stillPinned = await api(`/api/chat/conversations/${channelId}/pins`, alice.token);
  check('and the refused unpin did not take effect',
    stillPinned.data.messages.some((m) => m.id === pinTarget.id));

  await api(pinUrl, alice.token, { method: 'POST', body: JSON.stringify({ pinned: false }) });
  const unpinned = await api(`/api/chat/conversations/${channelId}/pins`, bob.token);
  check('unpinning removes it from the list',
    !unpinned.data.messages.some((m) => m.id === pinTarget.id));

  /* ── Saved items ───────────────────────────────────────────────────────── */
  step('saved items');

  const saveTarget = await post(alice, channelId, 'Remember this for revision');
  await api(`/api/chat/conversations/${channelId}/messages/${saveTarget.id}/save`, bob.token,
    { method: 'POST', body: JSON.stringify({ saved: true }) });

  const bobSaved = await api('/api/chat/saved', bob.token);
  check('a message can be saved to a personal list',
    bobSaved.data.items.some((i) => i.message.id === saveTarget.id));
  check('a saved item carries the conversation it came from',
    Boolean(bobSaved.data.items[0]?.conversationName), bobSaved.data.items[0]?.conversationName);

  const carolSaved = await api('/api/chat/saved', carol.token);
  check('saving is personal — nobody else sees it',
    !carolSaved.data.items.some((i) => i.message.id === saveTarget.id));

  // Leaving the channel must take the bookmark's access with it.
  await pool.query(
    `UPDATE conversation_members SET left_at = now()
      WHERE conversation_id = $1 AND user_id = $2`, [channelId, bob.id]);
  const afterLeaving = await api('/api/chat/saved', bob.token);
  check('a saved message stops appearing once you leave the conversation',
    !afterLeaving.data.items.some((i) => i.message.id === saveTarget.id),
    `${afterLeaving.data.items.length} items`);
  await pool.query(
    `UPDATE conversation_members SET left_at = NULL
      WHERE conversation_id = $1 AND user_id = $2`, [channelId, bob.id]);

  /* ── Forwarding ────────────────────────────────────────────────────────── */
  step('forwarding');

  const fwdSource = await post(carol, channelId, 'Original words by Carol');
  const fwdUrl = `/api/chat/conversations/${channelId}/messages/${fwdSource.id}/forward`;

  const forwarded = await api(fwdUrl, alice.token, {
    method: 'POST', body: JSON.stringify({ conversationIds: [targetId] }) });
  check('a message can be forwarded', forwarded.status === 200,
    `${forwarded.status} ${forwarded.body.message ?? ''}`);

  const inTarget = (await api(`/api/chat/conversations/${targetId}/messages?limit=20`, bob.token))
    .data.messages;
  const copy = inTarget.find((m) => m.body === 'Original words by Carol');
  check('the forwarded copy arrives in the destination', Boolean(copy));
  check('attribution travels with it — it cannot be passed off as the forwarder’s own',
    copy?.forwardedFrom?.senderName === 'Thread Carol',
    JSON.stringify(copy?.forwardedFrom));

  const notMember = await api(fwdUrl, alice.token, {
    method: 'POST', body: JSON.stringify({ conversationIds: ['999999999999'] }) });
  check('forwarding into a conversation you are not in is refused',
    notMember.status === 404, String(notMember.status));

  // A DM's name must not leak into a channel via a forward.
  const dm = await api('/api/chat/conversations/direct', alice.token, {
    method: 'POST', body: JSON.stringify({ userId: bob.id }) });
  const dmMsg = await post(alice, dm.data.conversation.id, 'Said privately');
  await api(
    `/api/chat/conversations/${dm.data.conversation.id}/messages/${dmMsg.id}/forward`,
    alice.token, { method: 'POST', body: JSON.stringify({ conversationIds: [channelId] }) });
  const fromDm = (await api(`/api/chat/conversations/${channelId}/messages?limit=20`, carol.token))
    .data.messages.find((m) => m.body === 'Said privately');
  check('forwarding out of a DM does not disclose which DM it came from',
    fromDm?.forwardedFrom?.conversationName === null,
    JSON.stringify(fromDm?.forwardedFrom));

  /* ── Permalinks and jump-to-message ────────────────────────────────────── */
  step('jump to message');

  for (let i = 0; i < 60; i++) await post(alice, channelId, `filler ${i}`);

  const context = await api(
    `/api/chat/conversations/${channelId}/messages/${fwdSource.id}/context?radius=10`, bob.token);
  check('a permalink returns the message with context around it',
    context.status === 200 && context.data.target.id === fwdSource.id,
    `${context.status}`);
  check('and enough either side to read it in',
    context.data.messages.length > 1 && context.data.messages.length <= 21,
    `${context.data.messages.length} messages`);
  check('the window is centred on the target',
    context.data.messages.some((m) => m.seq < context.data.target.seq)
      && context.data.messages.some((m) => m.seq > context.data.target.seq));
  check('more history is reported as available',
    context.data.hasMore === true, String(context.data.hasMore));

  const stranger = await makeUser('Thread Stranger');
  ids.push(stranger.id);
  const denied = await api(
    `/api/chat/conversations/${channelId}/messages/${fwdSource.id}/context`, stranger.token);
  check('a permalink is not a bypass — a non-member gets nothing',
    denied.status === 404, String(denied.status));

} catch (err) {
  fails.push(`❌ threw: ${err instanceof Error ? err.stack : err}`);
} finally {
  await pool.query(
    `DELETE FROM conversations WHERE created_by = ANY($1::text[]) OR id IN (
       SELECT conversation_id FROM conversation_members WHERE user_id = ANY($1::text[]))`, [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [ids]);
  await pool.end();
}

console.log('\n── Chat Phase 3: structure ──────────────────────────────────\n');
for (const line of pass) console.log('  ' + line);
if (fails.length) { console.log(''); for (const line of fails) console.log('  ' + line); }
console.log(`\n  ${pass.length} passed, ${fails.length} failed\n`);
process.exit(fails.length ? 1 : 0);
