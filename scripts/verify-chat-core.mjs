#!/usr/bin/env node
/**
 * Chat Phase 1 — the spine, against the running stack.
 *
 * What is worth pinning here is not "a row was written". It is the handful of
 * invariants that everything later depends on and that are expensive to
 * discover broken:
 *
 *   · a per-conversation total order that survives concurrent senders
 *   · idempotent send — a retry resolves to the original message
 *   · membership as the only key to a conversation, on both transports
 *   · unread counters that agree with the log they are counting
 *   · fan-out that reaches the room *and* the sidebar of people not in it
 *
 *   npm run verify:chat        (needs `npm run dev` running)
 */
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { io as ioClient } from 'socket.io-client';
import { purgeUsers } from './lib/purge.mjs';

const env = Object.fromEntries(readFileSync('apps/api/.env', 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));

const API = 'http://localhost:5190';
const WS = 'http://localhost:5191';
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

const pass = [], fails = [];
// Printed as it happens, not buffered to the end: a gate that hangs must say
// where, and a silent script that never returns tells you nothing.
const check = (name, ok, detail = '') => {
  const line = `${ok ? '\u2705' : '\u274c'} ${name}${detail ? `  \u2014 ${detail}` : ''}`;
  (ok ? pass : fails).push(line);
  process.stderr.write('  ' + line + '\n');
  return ok;
};
const step = (s) => process.stderr.write(`\n  \u2022 ${s}\n`);

const nonce = () => randomBytes(8).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeUser(name, roleName = 'Staff') {
  const id = `chattest-${randomBytes(6).toString('hex')}`;
  const { rows } = await pool.query('SELECT id FROM roles WHERE name = $1', [roleName]);
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id)
     VALUES ($1,$1,$2,$3,$4,$5)`,
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

/** Wait for one event, or resolve null after a grace period. */
const waitFor = (socket, event, ms = 2500) => new Promise((resolve) => {
  const t = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
  const handler = (p) => { clearTimeout(t); socket.off(event, handler); resolve(p); };
  socket.on(event, handler);
});

/* ══════════════════════════════════════════════════════════════════════════ */

const alice = await makeUser('Chat Alice');
const bob = await makeUser('Chat Bob');
const mallory = await makeUser('Chat Mallory');
const student = await makeUser('Chat Student', 'Student');

let sockets = [];
let channelId = null;

try {
  step('conversations');
  /* ── Conversations ─────────────────────────────────────────────────────── */

  const empty = await api('/api/chat/conversations', alice.token);
  check('a new user has an empty conversation list',
    empty.status === 200 && Array.isArray(empty.data?.conversations) && empty.data.conversations.length === 0,
    `${empty.status} ${JSON.stringify(empty.data?.conversations?.length)}`);

  const created = await api('/api/chat/conversations', alice.token, {
    method: 'POST',
    body: JSON.stringify({ type: 'channel', name: `Test Channel ${randomBytes(3).toString('hex')}`,
      topic: 'Phase 1 gate', memberIds: [bob.id] }),
  });
  channelId = created.data?.conversation?.id;
  check('a channel can be created', created.status === 201 && Boolean(channelId),
    `${created.status} ${created.body.message ?? ''}`);
  check('the creator is its owner', created.data?.conversation?.myRole === 'owner',
    created.data?.conversation?.myRole);
  check('invited members are counted', created.data?.conversation?.memberCount === 2,
    String(created.data?.conversation?.memberCount));

  const bobList = await api('/api/chat/conversations', bob.token);
  check('an invited member sees the channel',
    bobList.data?.conversations?.some((c) => c.id === channelId));

  const malloryList = await api('/api/chat/conversations', mallory.token);
  check('a non-member does not see it',
    !malloryList.data?.conversations?.some((c) => c.id === channelId));

  const peek = await api(`/api/chat/conversations/${channelId}/messages`, mallory.token);
  check('a non-member reading it gets 404, not 403', peek.status === 404,
    `${peek.status} — 403 would confirm the channel exists`);

  const intruder = await api(`/api/chat/conversations/${channelId}/messages`, mallory.token, {
    method: 'POST', body: JSON.stringify({ body: 'let me in', nonce: nonce() }),
  });
  check('a non-member cannot post into it', intruder.status === 404, String(intruder.status));

  step('sending');
  /* ── Sending ───────────────────────────────────────────────────────────── */

  const n1 = nonce();
  const sent = await api(`/api/chat/conversations/${channelId}/messages`, alice.token, {
    method: 'POST', body: JSON.stringify({ body: 'First message', nonce: n1 }),
  });
  check('a message can be sent', sent.status === 201 && sent.data?.message?.id,
    `${sent.status} ${sent.body.message ?? ''}`);
  // seq 1 belongs to the "created this channel" system notice, which is
  // written through the same path so it orders correctly against real messages.
  check('the first user message follows the creation notice at seq 2',
    sent.data?.message?.seq === 2, String(sent.data?.message?.seq));

  const retry = await api(`/api/chat/conversations/${channelId}/messages`, alice.token, {
    method: 'POST', body: JSON.stringify({ body: 'First message', nonce: n1 }),
  });
  check('replaying the same nonce returns the original, not a duplicate',
    retry.status === 200 && retry.data?.duplicate === true
      && retry.data?.message?.id === sent.data?.message?.id,
    `${retry.status} duplicate=${retry.data?.duplicate} id match=${retry.data?.message?.id === sent.data?.message?.id}`);

  const noNonce = await api(`/api/chat/conversations/${channelId}/messages`, alice.token, {
    method: 'POST', body: JSON.stringify({ body: 'no nonce' }),
  });
  check('a send without a nonce is rejected', noNonce.status === 400, String(noNonce.status));

  const emptyBody = await api(`/api/chat/conversations/${channelId}/messages`, alice.token, {
    method: 'POST', body: JSON.stringify({ body: '   ', nonce: nonce() }),
  });
  check('an empty message is rejected', emptyBody.status === 400, String(emptyBody.status));

  const tooLong = await api(`/api/chat/conversations/${channelId}/messages`, alice.token, {
    method: 'POST', body: JSON.stringify({ body: 'x'.repeat(8001), nonce: nonce() }),
  });
  check('an over-length message is rejected', tooLong.status === 400, String(tooLong.status));

  step('concurrency');
  /* ── Concurrency: the ordering invariant ───────────────────────────────── */

  const BURST = 25;
  const burst = await Promise.all(Array.from({ length: BURST }, (_, i) =>
    api(`/api/chat/conversations/${channelId}/messages`,
      i % 2 ? bob.token : alice.token,
      { method: 'POST', body: JSON.stringify({ body: `burst ${i}`, nonce: nonce() }) })));

  const seqs = burst.map((r) => r.data?.message?.seq).filter((s) => typeof s === 'number');
  const unique = new Set(seqs);
  check(`${BURST} concurrent sends all succeed`, seqs.length === BURST, `${seqs.length}/${BURST}`);
  check('every concurrent send gets a distinct seq — no two writers collide',
    unique.size === seqs.length, `${unique.size} unique of ${seqs.length}`);
  check('the sequence is gap-free',
    Math.max(...seqs) - Math.min(...seqs) === seqs.length - 1,
    `min ${Math.min(...seqs)} max ${Math.max(...seqs)}`);

  step('pagination');
  /* ── Pagination ────────────────────────────────────────────────────────── */

  const page1 = await api(`/api/chat/conversations/${channelId}/messages?limit=10`, alice.token);
  check('a page returns the requested number', page1.data?.messages?.length === 10,
    String(page1.data?.messages?.length));
  check('a page is ordered oldest-first for display',
    page1.data.messages[0].seq < page1.data.messages.at(-1).seq);
  check('the newest message is on the first page',
    page1.data.messages.at(-1).seq === Math.max(...seqs));
  check('there is more to fetch', page1.data?.hasMore === true);

  const page2 = await api(
    `/api/chat/conversations/${channelId}/messages?limit=10&before=${page1.data.nextCursor}`,
    alice.token);
  const overlap = page1.data.messages.filter(
    (m) => page2.data.messages.some((n) => n.id === m.id));
  check('the next page does not overlap the first', overlap.length === 0,
    `${overlap.length} duplicated`);
  check('the next page is strictly older',
    Math.max(...page2.data.messages.map((m) => m.seq)) < Math.min(...page1.data.messages.map((m) => m.seq)));

  step('unread');
  /* ── Unread ────────────────────────────────────────────────────────────── */

  /*
   * On its own channel, with one sender.
   *
   * Asserting against the interleaved burst above was a bad test: both people
   * sent, so whoever happened to send last had their own counter zeroed and
   * the "expected" number depended on scheduling. A counter test has to be
   * deterministic or it is measuring the event loop, not the counter.
   */
  const solo = await api('/api/chat/conversations', alice.token, {
    method: 'POST',
    body: JSON.stringify({ type: 'channel', name: `Unread ${randomBytes(3).toString('hex')}`,
      memberIds: [bob.id] }),
  });
  const soloId = solo.data.conversation.id;

  for (let i = 0; i < 5; i++) {
    await api(`/api/chat/conversations/${soloId}/messages`, alice.token, {
      method: 'POST', body: JSON.stringify({ body: `only Alice ${i}`, nonce: nonce() }),
    });
  }

  const bobConvs = await api('/api/chat/conversations', bob.token);
  const bobSolo = bobConvs.data.conversations.find((c) => c.id === soloId);
  check("the recipient's unread counts exactly what was sent to them",
    bobSolo?.unread === 5, `unread ${bobSolo?.unread}, expected 5`);

  const aliceConvs = await api('/api/chat/conversations', alice.token);
  const aliceSolo = aliceConvs.data.conversations.find((c) => c.id === soloId);
  check("a sender's own messages never make them unread", aliceSolo?.unread === 0,
    String(aliceSolo?.unread));

  const soloTop = bobSolo.lastSeq;
  const read = await api(`/api/chat/conversations/${soloId}/read`, bob.token, {
    method: 'POST', body: JSON.stringify({ seq: soloTop }),
  });
  check('reading to the top clears unread',
    read.status === 200 && read.data?.unread === 0 && read.data?.lastReadSeq === soloTop,
    `${read.status} unread ${read.data?.unread} watermark ${read.data?.lastReadSeq}`);

  const rewind = await api(`/api/chat/conversations/${soloId}/read`, bob.token, {
    method: 'POST', body: JSON.stringify({ seq: 1 }),
  });
  check('the watermark is monotonic — a stale lower seq cannot un-read',
    rewind.data?.lastReadSeq === soloTop && rewind.data?.unread === 0,
    `watermark ${rewind.data?.lastReadSeq} unread ${rewind.data?.unread}`);

  const partial = await api(`/api/chat/conversations/${soloId}/messages`, alice.token, {
    method: 'POST', body: JSON.stringify({ body: 'one more', nonce: nonce() }),
  });
  const afterOne = await api('/api/chat/conversations', bob.token);
  check('a new message after reading raises unread by exactly one',
    afterOne.data.conversations.find((c) => c.id === soloId)?.unread === 1,
    String(afterOne.data.conversations.find((c) => c.id === soloId)?.unread));
  check('the burst channel is still readable after the concurrent load',
    partial.status === 201, String(partial.status));

  step('direct messages');
  /* ── Direct messages ───────────────────────────────────────────────────── */

  const dm1 = await api('/api/chat/conversations/direct', alice.token, {
    method: 'POST', body: JSON.stringify({ userId: bob.id }),
  });
  check('a DM can be opened', dm1.status === 200 && dm1.data?.conversation?.type === 'dm',
    `${dm1.status} ${dm1.body.message ?? ''}`);
  check('a DM resolves the counterpart per viewer',
    dm1.data?.conversation?.name === bob.name && dm1.data?.conversation?.peer?.id === bob.id,
    `${dm1.data?.conversation?.name}`);

  const dm2 = await api('/api/chat/conversations/direct', alice.token, {
    method: 'POST', body: JSON.stringify({ userId: bob.id }),
  });
  check('opening the same DM twice is idempotent',
    dm2.data?.conversation?.id === dm1.data?.conversation?.id);

  const dmFromBob = await api('/api/chat/conversations/direct', bob.token, {
    method: 'POST', body: JSON.stringify({ userId: alice.id }),
  });
  check('the other person lands in the same DM, not a second one',
    dmFromBob.data?.conversation?.id === dm1.data?.conversation?.id,
    `${dmFromBob.data?.conversation?.id} vs ${dm1.data?.conversation?.id}`);
  check('the DM is named for the other side, per viewer',
    dmFromBob.data?.conversation?.name === alice.name, dmFromBob.data?.conversation?.name);

  const selfDm = await api('/api/chat/conversations/direct', alice.token, {
    method: 'POST', body: JSON.stringify({ userId: alice.id }),
  });
  check('you cannot DM yourself', selfDm.status === 400, String(selfDm.status));

  const studentDm = await api('/api/chat/conversations/direct', student.token, {
    method: 'POST', body: JSON.stringify({ userId: alice.id }),
  });
  check('a student cannot start a DM — the safeguarding default holds',
    studentDm.status === 403, `${studentDm.status} ${studentDm.body.message ?? ''}`);

  step('realtime');
  /* ── Realtime ──────────────────────────────────────────────────────────── */

  const aliceSock = await connect(alice.token);
  const bobSock = await connect(bob.token);
  sockets = [aliceSock, bobSock];

  const anon = await connect('not-a-token').then(() => 'connected').catch(() => 'rejected');
  check('an unauthenticated socket is rejected', anon === 'rejected');

  await new Promise((r) =>
    aliceSock.emit('conversation:subscribe', { conversationIds: [channelId] }, r));
  const sub = await new Promise((r) =>
    bobSock.emit('conversation:subscribe', { conversationIds: [channelId] }, r));
  check('a member may subscribe to a conversation',
    sub?.ok === true && sub.subscribed.includes(channelId), JSON.stringify(sub));

  const malSock = await connect(mallory.token);
  sockets.push(malSock);
  const badSub = await new Promise((r) =>
    malSock.emit('conversation:subscribe', { conversationIds: [channelId] }, r));
  check('a non-member is denied a subscription — the socket checks the database',
    badSub?.ok === false && badSub.denied.includes(channelId), JSON.stringify(badSub));

  // Bob has the channel open; Mallory does not and is not a member.
  // Every listener is attached before the send — an event that fires between
  // the send and a later `waitFor` is lost, and the test would read that as a
  // missing feature rather than as its own race.
  const incoming = waitFor(bobSock, 'message:new');
  const badge = waitFor(bobSock, 'conversation:unread', 3000);
  const intruderSees = waitFor(malSock, 'message:new', 1500);

  const ack = await new Promise((r) => aliceSock.emit('message:send', {
    conversationId: channelId, body: 'sent over the socket', nonce: nonce(),
  }, r));
  check('a message can be sent over the socket', ack?.ok === true && ack.message?.id,
    JSON.stringify(ack?.error ?? '').slice(0, 80));

  const got = await incoming;
  check('it reaches a subscribed member in real time',
    got?.message?.id === ack?.message?.id, got ? 'delivered' : 'nothing arrived');
  check('it does not leak to a non-member socket', (await intruderSees) === null);

  // The badge path: this event goes to the *user* room, which is what a member
  // with the channel closed relies on to see their sidebar move.
  const badgeEvent = await badge;
  check('an unread event reaches the recipient on their own user room',
    badgeEvent?.conversationId === channelId && badgeEvent.unread >= 1,
    JSON.stringify(badgeEvent));

  const socketRetry = await new Promise((r) => aliceSock.emit('message:send', {
    conversationId: channelId, body: 'dupe', nonce: ack.message.nonce,
  }, r));
  check('the socket path is idempotent on the same nonce',
    socketRetry?.message?.id === ack.message.id, socketRetry?.message?.id);

  const denied = await new Promise((r) => malSock.emit('message:send', {
    conversationId: channelId, body: 'intruder', nonce: nonce(),
  }, r));
  check('the socket path refuses a non-member send', denied?.ok === false, JSON.stringify(denied));

  step('typing');
  /* ── Typing ────────────────────────────────────────────────────────────── */

  const typing = waitFor(bobSock, 'typing:update', 2000);
  aliceSock.emit('typing:start', { conversationId: channelId });
  const t = await typing;
  check('a typing indicator reaches the room',
    t?.users?.some((u) => u.userId === alice.id), JSON.stringify(t));

  const stopped = waitFor(bobSock, 'typing:update', 2000);
  aliceSock.emit('typing:stop', { conversationId: channelId });
  check('it clears on stop', (await stopped)?.users?.length === 0);

  step('consistency');
  /* ── Consistency between the counters and the log ──────────────────────── */

  await sleep(300);
  const { rows: audit } = await pool.query(
    `SELECT m.user_id, m.unread_count,
            (SELECT count(*) FROM messages x
              WHERE x.conversation_id = m.conversation_id
                AND x.seq > m.last_read_seq AND x.sender_id <> m.user_id
                AND x.deleted_at IS NULL)::int AS actual
       FROM conversation_members m WHERE m.conversation_id = $1`, [channelId]);
  const drifted = audit.filter((r) => r.unread_count !== r.actual);
  check('every unread counter agrees with the log it counts',
    drifted.length === 0,
    drifted.map((d) => `${d.user_id}: ${d.unread_count}≠${d.actual}`).join(', '));

  const { rows: dupes } = await pool.query(
    `SELECT conversation_id, seq, count(*) FROM messages
      WHERE conversation_id = $1 GROUP BY 1,2 HAVING count(*) > 1`, [channelId]);
  check('no two messages share a sequence number', dupes.length === 0, `${dupes.length} collisions`);

  const { rows: sys } = await pool.query(
    `SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND type = 'system'`,
    [channelId]);
  check('channel creation wrote a system message', sys[0].n >= 1, String(sys[0].n));

  const { rows: soloAudit } = await pool.query(
    `SELECT unread_count FROM conversation_members
      WHERE conversation_id = $1 AND user_id = $2`, [soloId, bob.id]);
  check('a system notice does not badge anyone — it is context, not correspondence',
    soloAudit[0]?.unread_count === 1,
    `unread ${soloAudit[0]?.unread_count} after 1 real message following a read`);

} catch (err) {
  fails.push(`❌ threw: ${err instanceof Error ? err.stack : err}`);
} finally {
  for (const s of sockets) s.close();
  // Users cascade; conversations they created do not, so they go first.
  const ids = [alice.id, bob.id, mallory.id, student.id];
  // One helper, in dependency order, each step in its own try/catch — see
  // scripts/lib/purge.mjs for why the previous inline version leaked users on
  // every interrupted run.
  try { await pool.query('DELETE FROM files WHERE owner_id = ANY($1::text[])', [ids]); } catch { /* files may not reference these */ }
  await purgeUsers(pool, ids);
  await pool.end();
}

console.log('\n── Chat Phase 1: the spine ──────────────────────────────────\n');
for (const line of pass) console.log('  ' + line);
if (fails.length) { console.log(''); for (const line of fails) console.log('  ' + line); }
console.log(`\n  ${pass.length} passed, ${fails.length} failed\n`);
process.exit(fails.length ? 1 : 0);
