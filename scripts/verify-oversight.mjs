#!/usr/bin/env node
/**
 * Academic-conduct oversight.
 *
 * A school runs on this chat tool, so someone accountable has to be able to see
 * what is being said in it — including in private groups and one-to-one DMs
 * they are not part of — and take down a message that breaks the rules. The
 * rules worth pinning:
 *
 *   • the window is permissioned — OVERSIGHT_VIEW_ALL to read, a *separate*
 *     OVERSIGHT_MESSAGE_DELETE to redact — and a plain staff member has neither;
 *   • reading a private conversation's messages is written to the audit log;
 *   • a redaction needs a stated reason, blanks the message for everyone, and
 *     records the reason and the original text;
 *   • oversight is read-and-redact only — there is no way to post or join.
 *
 *   npm run verify:oversight      (needs `npm run dev` running)
 */
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { purgeUsers } from './lib/purge.mjs';

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
  const id = `oversight-${randomBytes(6).toString('hex')}`;
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

const admin = await makeUser('Oversight Admin', 'Admin');
const teacher = await makeUser('Oversight Teacher');
const pupilA = await makeUser('Oversight Pupil A', 'Student');
const pupilB = await makeUser('Oversight Pupil B', 'Student');
const reviewer = await makeUser('Oversight Reviewer');   // gets a custom view-only role
const ids = [admin.id, teacher.id, pupilA.id, pupilB.id, reviewer.id];

try {
  /* ── A private group and a peer DM the admin is not in ─────────────────── */
  step('conversations the reviewer is not a member of');

  const group = await api('/api/chat/conversations', teacher.token, {
    method: 'POST',
    body: JSON.stringify({ type: 'group', name: `Project ${randomBytes(3).toString('hex')}`,
      isPrivate: true, memberIds: [pupilA.id, pupilB.id] }),
  });
  const groupId = group.data.conversation.id;

  await api(`/api/chat/conversations/${groupId}/messages`, pupilA.token, {
    method: 'POST', body: JSON.stringify({ body: 'lets copy the answers in the exam', nonce: nonce() }) });

  // Students cannot DM by default; grant this one pupil DM_START via a role bump
  // is overkill — use the teacher as the second party instead.
  const dm = await api('/api/chat/conversations/direct', teacher.token, {
    method: 'POST', body: JSON.stringify({ userId: pupilA.id }) });
  const dmId = dm.data.conversation.id;
  await api(`/api/chat/conversations/${dmId}/messages`, teacher.token, {
    method: 'POST', body: JSON.stringify({ body: 'come to my office alone after class', nonce: nonce() }) });

  check('a private group and a direct message exist', Boolean(groupId && dmId));

  /* ── Permission gate ──────────────────────────────────────────────────── */
  step('permission gate');

  const staffList = await api('/api/oversight/conversations', teacher.token);
  check('a plain staff member cannot list conversations', staffList.status === 403, String(staffList.status));

  const staffRead = await api(`/api/oversight/conversations/${groupId}/messages`, teacher.token);
  check('nor read a conversation they are not in', staffRead.status === 403, String(staffRead.status));

  // `reviewer` is a plain staff member here — the custom view-only role is not
  // assigned until later in the script.
  const nonMemberChat = await api(`/api/chat/conversations/${groupId}/messages`, reviewer.token);
  check('and the ordinary chat route still 404s a non-member',
    nonMemberChat.status === 404, String(nonMemberChat.status));

  /* ── Reading with oversight ───────────────────────────────────────────── */
  step('reading with OVERSIGHT_VIEW_ALL');

  const list = await api('/api/oversight/conversations?q=' + encodeURIComponent('Oversight Pupil A'), admin.token);
  check('the admin can find a conversation by a participant\'s name',
    list.status === 200 && list.data.conversations.some((c) => c.id === dmId),
    String(list.status));

  const groupMsgs = await api(`/api/oversight/conversations/${groupId}/messages`, admin.token);
  check('the admin can read a private group they never joined',
    groupMsgs.status === 200
      && groupMsgs.data.messages.some((m) => m.body === 'lets copy the answers in the exam'),
    String(groupMsgs.status));

  const dmMsgs = await api(`/api/oversight/conversations/${dmId}/messages`, admin.token);
  check('and a one-to-one DM between two other people',
    dmMsgs.data.messages.some((m) => m.body === 'come to my office alone after class'));

  await sleep(150);
  const { rows: readLog } = await pool.query(
    `SELECT actor_id FROM audit_log
      WHERE action = 'chat.oversight.conversation.read' AND target_id = $1`, [groupId]);
  check('reading a conversation is written to the audit log', readLog.length >= 1 && readLog[0].actor_id === admin.id);

  const meta = await api(`/api/oversight/conversations/${dmId}`, admin.token);
  check('a metadata-only fetch returns the roster', meta.status === 200 && meta.data.conversation.members.length === 2);

  /* ── View-only role cannot redact ─────────────────────────────────────── */
  step('view-only oversight');

  const role = await api('/api/roles-permissions/roles', admin.token, {
    method: 'POST',
    body: JSON.stringify({ name: `Reviewer ${randomBytes(3).toString('hex')}`, level: 'STAFF',
      permissionKeys: ['MESSAGE_READ', 'OVERSIGHT_VIEW_ALL'] }),
  });
  await pool.query('UPDATE users SET role_id = $1 WHERE id = $2', [role.data.id, reviewer.id]);

  const revRead = await api(`/api/oversight/conversations/${groupId}/messages`, reviewer.token);
  check('a view-only reviewer can read', revRead.status === 200, String(revRead.status));

  const targetMsg = revRead.data.messages.find((m) => m.body === 'lets copy the answers in the exam');
  const revDelete = await api(
    `/api/oversight/conversations/${groupId}/messages/${targetMsg.id}/remove`, reviewer.token, {
      method: 'POST', body: JSON.stringify({ reason: 'Academic dishonesty' }) });
  check('but cannot remove a message', revDelete.status === 403, String(revDelete.status));

  /* ── Redaction ───────────────────────────────────────────────────────── */
  step('redaction');

  const noReason = await api(
    `/api/oversight/conversations/${groupId}/messages/${targetMsg.id}/remove`, admin.token, {
      method: 'POST', body: JSON.stringify({}) });
  check('a removal needs a reason', noReason.status === 400, String(noReason.status));

  const removed = await api(
    `/api/oversight/conversations/${groupId}/messages/${targetMsg.id}/remove`, admin.token, {
      method: 'POST', body: JSON.stringify({ reason: 'Academic dishonesty — plan to cheat in an exam' }) });
  check('a message can be removed with a reason', removed.status === 200, String(removed.status));

  const { rows: gone } = await pool.query('SELECT body, deleted_by FROM messages WHERE id = $1', [targetMsg.id]);
  check('the body is blanked and the remover recorded',
    gone[0].body === null && gone[0].deleted_by === admin.id);

  const afterView = await api(`/api/oversight/conversations/${groupId}/messages`, admin.token);
  check('everyone now sees a tombstone, not the text',
    afterView.data.messages.find((m) => m.id === targetMsg.id)?.body === null
      && afterView.data.messages.find((m) => m.id === targetMsg.id)?.deletedAt !== null);

  await sleep(150);
  const { rows: redactLog } = await pool.query(
    `SELECT metadata FROM audit_log
      WHERE action = 'chat.oversight.message.remove' AND target_id = $1`, [targetMsg.id]);
  check('the redaction is audit-logged with the reason and the original text',
    redactLog.length === 1
      && redactLog[0].metadata.reason.startsWith('Academic dishonesty')
      && redactLog[0].metadata.removedText === 'lets copy the answers in the exam',
    JSON.stringify(redactLog[0]?.metadata));

  const twice = await api(
    `/api/oversight/conversations/${groupId}/messages/${targetMsg.id}/remove`, admin.token, {
      method: 'POST', body: JSON.stringify({ reason: 'Academic dishonesty' }) });
  check('a message cannot be removed twice', twice.status === 409, String(twice.status));

  /* ── No back door to participation ───────────────────────────────────── */
  step('read-and-redact only');

  const post = await api(`/api/oversight/conversations/${groupId}/messages`, admin.token, {
    method: 'POST', body: JSON.stringify({ body: 'hello', nonce: nonce() }) });
  check('there is no oversight endpoint to post a message', post.status === 404, String(post.status));

  const stats = await api('/api/oversight/stats', admin.token);
  check('the overview counts are available',
    stats.status === 200 && typeof stats.data.stats.conversations === 'number'
      && stats.data.stats.redactions >= 1,
    JSON.stringify(stats.data?.stats));

} catch (err) {
  fails.push(`❌ threw: ${err instanceof Error ? err.stack : err}`);
} finally {
  await purgeUsers(pool, ids);
  await pool.query('DELETE FROM roles WHERE is_system = false AND name LIKE \'Reviewer %\'').catch(() => {});
  await pool.end();
}

console.log('\n── Oversight: read any conversation, redact what breaks the rules ──\n');
for (const line of pass) console.log('  ' + line);
if (fails.length) { console.log(''); for (const line of fails) console.log('  ' + line); }
console.log(`\n  ${pass.length} passed, ${fails.length} failed\n`);
process.exit(fails.length ? 1 : 0);
