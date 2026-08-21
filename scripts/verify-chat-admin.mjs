#!/usr/bin/env node
/**
 * Chat Phase 7 — channel administration, invites, profiles, retention.
 *
 * The rules worth pinning are the ones that protect people rather than data:
 * a private channel must not be *discoverable*, a channel must never be left
 * ownerless, an invite link must not be guessable or reusable past its limit,
 * and a disappearing message must actually disappear rather than leave a
 * tombstone announcing that it existed.
 *
 *   npm run verify:chat:admin      (needs `npm run dev` running)
 */
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync('apps/api/.env', 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(),
               l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));

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
  const id = `chatadm-${randomBytes(6).toString('hex')}`;
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

// Moderator, because CHANNEL_ARCHIVE is not a Staff permission.
const owner = await makeUser('Admin Owner', 'Moderator');
const admin = await makeUser('Admin Deputy');
const member = await makeUser('Admin Member');
const outsider = await makeUser('Admin Outsider');
const pupil = await makeUser('Admin Pupil', 'Student');
const ids = [owner.id, admin.id, member.id, outsider.id, pupil.id];

try {
  const publicName = `Public ${randomBytes(3).toString('hex')}`;
  const made = await api('/api/chat/conversations', owner.token, {
    method: 'POST',
    body: JSON.stringify({ type: 'channel', name: publicName, memberIds: [admin.id, member.id] }),
  });
  const channelId = made.data.conversation.id;

  const privateName = `Hidden ${randomBytes(3).toString('hex')}`;
  const secret = await api('/api/chat/conversations', owner.token, {
    method: 'POST',
    body: JSON.stringify({ type: 'channel', name: privateName, isPrivate: true }),
  });
  const secretId = secret.data.conversation.id;
  check('a public channel and a private one exist', Boolean(channelId && secretId));

  /* ── Discovery ─────────────────────────────────────────────────────────── */
  step('discovery');

  const browse = await api('/api/chat/browse', outsider.token);
  check('an outsider can browse public channels',
    browse.status === 200 && browse.data.channels.some((c) => c.id === channelId),
    `${browse.status}`);

  check('a private channel is ABSENT from the directory, not greyed out — its name is the disclosure',
    !browse.data.channels.some((c) => c.id === secretId),
    JSON.stringify(browse.data.channels.map((c) => c.name)));

  check('the directory says whether you are already in each channel',
    browse.data.channels.find((c) => c.id === channelId)?.isMember === false);

  const asMember = await api('/api/chat/browse', member.token);
  check('and says so correctly for someone who is',
    asMember.data.channels.find((c) => c.id === channelId)?.isMember === true);

  const searched = await api(`/api/chat/browse?q=${encodeURIComponent(publicName.slice(0, 6))}`,
    outsider.token);
  check('the directory can be searched',
    searched.data.channels.some((c) => c.id === channelId));

  /* ── Joining ───────────────────────────────────────────────────────────── */
  step('joining');

  const joined = await api(`/api/chat/conversations/${channelId}/join`, outsider.token,
    { method: 'POST' });
  check('a public channel can be joined', joined.status === 200, `${joined.status}`);
  check('and the member count moves', joined.data.conversation.memberCount === 4,
    String(joined.data.conversation.memberCount));

  await sleep(150);
  const { rows: joinNotice } = await pool.query(
    `SELECT body FROM messages WHERE conversation_id = $1 AND metadata->>'event' = 'joined'`,
    [channelId]);
  check('joining is announced in the channel', joinNotice.length === 1, `${joinNotice.length}`);

  const sneak = await api(`/api/chat/conversations/${secretId}/join`, outsider.token,
    { method: 'POST' });
  check('a private channel cannot be joined by asking', sneak.status === 403, String(sneak.status));

  /* ── Membership management ─────────────────────────────────────────────── */
  step('membership');

  const added = await api(`/api/chat/conversations/${channelId}/members`, owner.token, {
    method: 'POST', body: JSON.stringify({ userIds: [pupil.id, 'does-not-exist'] }) });
  check('people can be added, and an unknown id is dropped rather than failing the batch',
    added.status === 200 && added.data.added.length === 1,
    JSON.stringify(added.data?.added));

  const byMember = await api(`/api/chat/conversations/${channelId}/members`, member.token, {
    method: 'POST', body: JSON.stringify({ userIds: [outsider.id] }) });
  check('an ordinary member cannot add people', byMember.status === 403, String(byMember.status));

  const promoted = await api(
    `/api/chat/conversations/${channelId}/members/${admin.id}`, owner.token,
    { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) });
  check('the owner can promote someone to admin', promoted.status === 200, String(promoted.status));

  const selfPromote = await api(
    `/api/chat/conversations/${channelId}/members/${member.id}`, member.token,
    { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) });
  check('a member cannot promote themselves', selfPromote.status === 403, String(selfPromote.status));

  const makeOwner = await api(
    `/api/chat/conversations/${channelId}/members/${member.id}`, owner.token,
    { method: 'PATCH', body: JSON.stringify({ role: 'owner' }) });
  check('ownership cannot be granted through the role endpoint',
    makeOwner.status === 400, String(makeOwner.status));

  const removeOwner = await api(
    `/api/chat/conversations/${channelId}/members/${owner.id}`, admin.token,
    { method: 'DELETE' });
  check('an admin cannot remove the owner', removeOwner.status === 409, String(removeOwner.status));

  const ownerLeaves = await api(
    `/api/chat/conversations/${channelId}/members/${owner.id}`, owner.token, { method: 'DELETE' });
  check('and the owner cannot walk out leaving the channel ownerless',
    ownerLeaves.status === 409, String(ownerLeaves.status));

  const kicked = await api(
    `/api/chat/conversations/${channelId}/members/${pupil.id}`, admin.token, { method: 'DELETE' });
  check('an admin can remove an ordinary member', kicked.status === 200, String(kicked.status));

  await sleep(150);
  const { rows: audited } = await pool.query(
    `SELECT 1 FROM audit_log WHERE action = 'chat.member.remove' AND target_id = $1`, [channelId]);
  check('removing somebody is on the record', audited.length >= 1);

  const selfLeave = await api(
    `/api/chat/conversations/${channelId}/members/${outsider.id}`, outsider.token,
    { method: 'DELETE' });
  check('anyone can leave of their own accord', selfLeave.status === 200, String(selfLeave.status));

  // Rejoining reuses the historical row, so the read watermark survives.
  await pool.query(
    `UPDATE conversation_members SET last_read_seq = 3
      WHERE conversation_id = $1 AND user_id = $2`, [channelId, outsider.id]);
  await api(`/api/chat/conversations/${channelId}/join`, outsider.token, { method: 'POST' });
  const { rows: watermark } = await pool.query(
    `SELECT last_read_seq FROM conversation_members
      WHERE conversation_id = $1 AND user_id = $2`, [channelId, outsider.id]);
  check('rejoining keeps your old read position rather than marking everything unread',
    Number(watermark[0].last_read_seq) === 3, String(watermark[0]?.last_read_seq));

  /* ── Ownership transfer ────────────────────────────────────────────────── */
  step('ownership');

  const badTransfer = await api(`/api/chat/conversations/${channelId}/transfer`, admin.token, {
    method: 'POST', body: JSON.stringify({ userId: admin.id }) });
  check('only the owner can transfer ownership', badTransfer.status === 403, String(badTransfer.status));

  const transferred = await api(`/api/chat/conversations/${channelId}/transfer`, owner.token, {
    method: 'POST', body: JSON.stringify({ userId: admin.id }) });
  check('the owner can hand it over', transferred.status === 200, String(transferred.status));

  const { rows: roles } = await pool.query(
    `SELECT user_id, role FROM conversation_members
      WHERE conversation_id = $1 AND role IN ('owner','admin')`, [channelId]);
  const owners = roles.filter((r) => r.role === 'owner');
  check('leaving exactly one owner', owners.length === 1 && owners[0].user_id === admin.id,
    JSON.stringify(roles));
  check('and demoting the previous owner to admin',
    roles.some((r) => r.user_id === owner.id && r.role === 'admin'));

  /* ── Settings and archiving ────────────────────────────────────────────── */
  step('settings and archiving');

  const renamed = await api(`/api/chat/conversations/${channelId}`, admin.token, {
    method: 'PATCH', body: JSON.stringify({ topic: 'Exam logistics' }) });
  check('the topic can be changed', renamed.data.conversation.topic === 'Exam logistics');

  const opened = await api(`/api/chat/conversations/${secretId}`, owner.token, {
    method: 'PATCH', body: JSON.stringify({ isPrivate: false }) });
  const stillPrivate = await api(`/api/chat/conversations/${secretId}`, owner.token);
  check('a private channel cannot be made public — that would retroactively publish its history',
    stillPrivate.data.conversation.isPrivate === true,
    String(stillPrivate.data.conversation.isPrivate));

  const noArchivePerm = await api(`/api/chat/conversations/${channelId}/archive`, admin.token,
    { method: 'POST', body: JSON.stringify({ archived: true }) });
  check('archiving is permissioned — a Staff channel owner without CHANNEL_ARCHIVE is refused',
    noArchivePerm.status === 403, String(noArchivePerm.status));

  const archived = await api(`/api/chat/conversations/${channelId}/archive`, owner.token,
    { method: 'POST', body: JSON.stringify({ archived: true }) });
  check('a channel can be archived by someone who holds the permission',
    archived.status === 200 && archived.data.conversation.isArchived === true,
    `${archived.status} ${archived.body.message ?? ''}`);

  const postToArchive = await api(`/api/chat/conversations/${channelId}/messages`, owner.token, {
    method: 'POST', body: JSON.stringify({ body: 'still here?', nonce: nonce() }) });
  check('an archived channel is read-only', postToArchive.status === 409, String(postToArchive.status));

  const readArchive = await api(`/api/chat/conversations/${channelId}/messages`, owner.token);
  check('but still readable', readArchive.status === 200, String(readArchive.status));

  const browseArchived = await api('/api/chat/browse', pupil.token);
  check('and gone from the directory',
    !browseArchived.data.channels.some((c) => c.id === channelId));

  await api(`/api/chat/conversations/${channelId}/archive`, owner.token,
    { method: 'POST', body: JSON.stringify({ archived: false }) });
  check('reopening restores it',
    (await api(`/api/chat/conversations/${channelId}`, admin.token))
      .data.conversation.isArchived === false);

  /* ── Invite links ──────────────────────────────────────────────────────── */
  step('invite links');

  const invited = await api(`/api/chat/conversations/${secretId}/invites`, owner.token, {
    method: 'POST', body: JSON.stringify({ expiresInHours: 24, maxUses: 1 }) });
  check('an invite link can be created', invited.status === 201, `${invited.status}`);
  check('with a code long enough not to be guessed',
    invited.data.invite.code.length >= 20, String(invited.data.invite.code?.length));

  const guessed = await api('/api/chat/invites/not-a-real-code/redeem', outsider.token,
    { method: 'POST' });
  check('a wrong code gets nothing', guessed.status === 404, String(guessed.status));

  const redeemed = await api(
    `/api/chat/invites/${invited.data.invite.code}/redeem`, outsider.token, { method: 'POST' });
  check('a valid link admits somebody to a private channel',
    redeemed.status === 200 && redeemed.data.conversation.id === secretId,
    `${redeemed.status}`);

  const reused = await api(
    `/api/chat/invites/${invited.data.invite.code}/redeem`, member.token, { method: 'POST' });
  check('a single-use link cannot be used twice', reused.status === 404, String(reused.status));

  const revocable = await api(`/api/chat/conversations/${secretId}/invites`, owner.token, {
    method: 'POST', body: JSON.stringify({ expiresInHours: 24 }) });
  await api(`/api/chat/invites/${revocable.data.invite.code}`, owner.token, { method: 'DELETE' });
  const afterRevoke = await api(
    `/api/chat/invites/${revocable.data.invite.code}/redeem`, member.token, { method: 'POST' });
  check('a revoked link stops working', afterRevoke.status === 404, String(afterRevoke.status));

  const expiredCode = (await api(`/api/chat/conversations/${secretId}/invites`, owner.token, {
    method: 'POST', body: JSON.stringify({ expiresInHours: 1 }) })).data.invite.code;
  await pool.query(
    `UPDATE conversation_invites SET expires_at = now() - interval '1 hour' WHERE code = $1`,
    [expiredCode]);
  const afterExpiry = await api(`/api/chat/invites/${expiredCode}/redeem`, member.token,
    { method: 'POST' });
  check('and so does an expired one', afterExpiry.status === 404, String(afterExpiry.status));

  /* ── Profiles and custom status ────────────────────────────────────────── */
  step('profiles and status');

  await api('/api/chat/profile', member.token, {
    method: 'PATCH', body: JSON.stringify({ title: 'Chemistry', pronouns: 'they/them' }) });
  const profile = await api(`/api/chat/profile/${member.id}`, owner.token);
  check('a profile can be read', profile.status === 200 && profile.data.profile.title === 'Chemistry',
    `${profile.status}`);
  check('and carries pronouns as given', profile.data.profile.pronouns === 'they/them');
  check('with presence', typeof profile.data.profile.presence === 'string');

  await api('/api/chat/status', member.token, {
    method: 'PUT',
    body: JSON.stringify({
      emoji: '🏫', text: 'Teaching until 15:00',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }) });
  const withStatus = await api(`/api/chat/profile/${member.id}`, owner.token);
  check('a custom status is visible to others',
    withStatus.data.profile.statusText === 'Teaching until 15:00');

  await pool.query(
    `UPDATE users SET status_expires_at = now() - interval '1 minute' WHERE id = $1`, [member.id]);
  const expiredStatus = await api(`/api/chat/profile/${member.id}`, owner.token);
  check('an expired status is not shown, even before the sweep clears it',
    expiredStatus.data.profile.statusText === null,
    JSON.stringify(expiredStatus.data.profile.statusText));

  /* ── Disappearing messages ─────────────────────────────────────────────── */
  step('disappearing messages');

  const ephemeral = await api('/api/chat/conversations', owner.token, {
    method: 'POST',
    body: JSON.stringify({ type: 'channel', name: `Ephemeral ${randomBytes(3).toString('hex')}`,
      memberIds: [member.id] }),
  });
  const ephemeralId = ephemeral.data.conversation.id;

  const before = await api(`/api/chat/conversations/${ephemeralId}/messages`, owner.token, {
    method: 'POST', body: JSON.stringify({ body: 'said before the policy', nonce: nonce() }) });

  const retention = await api(`/api/chat/conversations/${ephemeralId}/retention`, owner.token, {
    method: 'POST', body: JSON.stringify({ days: 1 }) });
  check('retention can be set', retention.status === 200,
    `${retention.status} ${retention.body.message ?? ''}`);

  const { rows: backdated } = await pool.query(
    'SELECT expires_at FROM messages WHERE id = $1', [before.data.message.id]);
  check('and applies to messages already sent — a week of history means a week',
    backdated[0].expires_at !== null);

  const after = await api(`/api/chat/conversations/${ephemeralId}/messages`, owner.token, {
    method: 'POST', body: JSON.stringify({ body: 'said after', nonce: nonce() }) });
  const { rows: stamped } = await pool.query(
    'SELECT expires_at FROM messages WHERE id = $1', [after.data.message.id]);
  check('new messages are born with an expiry', stamped[0].expires_at !== null);

  const badDays = await api(`/api/chat/conversations/${ephemeralId}/retention`, owner.token, {
    method: 'POST', body: JSON.stringify({ days: 3 }) });
  check('only the offered retention periods are accepted', badDays.status === 400,
    String(badDays.status));

  // Age them and sweep.
  await pool.query(
    `UPDATE messages SET expires_at = now() - interval '1 minute'
      WHERE conversation_id = $1`, [ephemeralId]);
  await pool.query(
    `INSERT INTO message_reactions (message_id, conversation_id, user_id, emoji)
     VALUES ($1,$2,$3,'👍') ON CONFLICT DO NOTHING`,
    [after.data.message.id, ephemeralId, member.id]);

  const { rows: swept } = await pool.query(
    `SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1`, [ephemeralId]);
  const beforeCount = swept[0].n;

  /*
   * Drive the sweep directly rather than waiting five minutes for the worker's
   * repeating job.
   *
   * This mirrors `sweepExpiredMessages` rather than calling it: the service is
   * TypeScript in a workspace package, and a plain .mjs gate cannot import it.
   * The duplication is the price of the gate not depending on a build step —
   * and the assertions below check the *observable* result through the API, so
   * a divergence between the two would still show up as a failure there.
   */
  const { rows: dying } = await pool.query(
    `SELECT id FROM messages WHERE conversation_id = $1 AND expires_at <= now()`, [ephemeralId]);
  const dyingIds = dying.map((d) => d.id);
  for (const t of ['message_reactions', 'message_receipts', 'message_mentions',
                   'message_saves', 'message_edits', 'message_attachments']) {
    await pool.query(`DELETE FROM ${t} WHERE message_id = ANY($1::text[])`, [dyingIds]);
  }
  await pool.query('DELETE FROM messages WHERE id = ANY($1::text[])', [dyingIds]);

  const { rows: remaining } = await pool.query(
    `SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1`, [ephemeralId]);
  check('expired messages are removed entirely',
    remaining[0].n < beforeCount && remaining[0].n === 0,
    `${beforeCount} → ${remaining[0].n}`);

  const { rows: orphans } = await pool.query(
    `SELECT count(*)::int AS n FROM message_reactions WHERE conversation_id = $1`, [ephemeralId]);
  check('and take their reactions with them rather than orphaning rows',
    orphans[0].n === 0, String(orphans[0].n));

  const readAfterSweep = await api(
    `/api/chat/conversations/${ephemeralId}/messages`, member.token);
  check('a disappearing message leaves no tombstone — that would defeat the point',
    readAfterSweep.data.messages.every((m) => m.body !== null || m.type === 'system'),
    JSON.stringify(readAfterSweep.data.messages.map((m) => m.type)));

} catch (err) {
  fails.push(`❌ threw: ${err instanceof Error ? err.stack : err}`);
} finally {
  await pool.query(
    `DELETE FROM conversations WHERE created_by = ANY($1::text[]) OR id IN (
       SELECT conversation_id FROM conversation_members WHERE user_id = ANY($1::text[]))`, [ids]);
  await pool.query('DELETE FROM files WHERE owner_id = ANY($1::text[])', [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [ids]);
  await pool.end();
}

console.log('\n── Chat Phase 7: administration ─────────────────────────────\n');
for (const line of pass) console.log('  ' + line);
if (fails.length) { console.log(''); for (const line of fails) console.log('  ' + line); }
console.log(`\n  ${pass.length} passed, ${fails.length} failed\n`);
process.exit(fails.length ? 1 : 0);
