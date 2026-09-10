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

/** Ticket → PUT bytes → file id, straight at the files service. */
async function upload(who, name, bytes, mime) {
  const t = await fetch(`${FILES}/api/files/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` },
    body: JSON.stringify({ name, size: bytes.length, mime }),
  }).then((r) => r.json());
  if (!t.data?.fileId) throw new Error(`ticket failed: ${JSON.stringify(t)}`);
  const put = await fetch(`${FILES}${t.data.uploadUrl}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': mime },
    body: bytes,
  });
  if (!put.ok) throw new Error(`upload failed: ${put.status}`);
  return t.data.fileId;
}

const fileStatus = async (fileId, token) => {
  const r = await fetch(`${FILES}/api/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return r.status;
};

/* ══════════════════════════════════════════════════════════════════════════ */

const admin = await makeUser('Oversight Admin', 'Admin');
const teacher = await makeUser('Oversight Teacher');
const pupilA = await makeUser('Oversight Pupil A', 'Student');
const pupilB = await makeUser('Oversight Pupil B', 'Student');
const reviewer = await makeUser('Oversight Reviewer');   // gets a custom view-only role
const stranger = await makeUser('Oversight Stranger');   // plain staff, no oversight, in nothing
const ids = [admin.id, teacher.id, pupilA.id, pupilB.id, reviewer.id, stranger.id];

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

  const { rows: gone } = await pool.query(
    'SELECT body, deleted_by, deleted_body FROM messages WHERE id = $1', [targetMsg.id]);
  check('the live body column is blanked and the remover recorded',
    gone[0].body === null && gone[0].deleted_by === admin.id);
  check('but the original text is preserved out of ordinary reach',
    gone[0].deleted_body === 'lets copy the answers in the exam', String(gone[0].deleted_body));

  const memberView = await api(`/api/chat/conversations/${groupId}/messages`, pupilB.token);
  check('an ordinary member sees a tombstone, not the text',
    memberView.data.messages.find((m) => m.id === targetMsg.id)?.body === null
      && memberView.data.messages.find((m) => m.id === targetMsg.id)?.deletedAt !== null);

  const afterView = await api(`/api/oversight/conversations/${groupId}/messages`, admin.token);
  const revealed = afterView.data.messages.find((m) => m.id === targetMsg.id);
  check('oversight can still read what a removed message said',
    revealed?.body === 'lets copy the answers in the exam'
      && revealed?.deletedAt !== null && revealed?.deletedBy === admin.id,
    JSON.stringify({ body: revealed?.body, deletedBy: revealed?.deletedBy }));

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

  /* ── Attachments: preview and removal ────────────────────────────────── */
  step('attachments');

  const fileId = await upload(pupilA, 'answers.pdf', Buffer.from('%PDF-1.4 leaked exam answers'), 'application/pdf');
  const withFile = await api(`/api/chat/conversations/${dmId}/messages`, teacher.token, {
    method: 'POST', body: JSON.stringify({ body: 'the file', nonce: nonce(), attachments: [fileId] }) });
  // teacher is a member of the DM; pupilA owns the file. Attach via a message
  // the pupil sends instead so ownership lines up.
  let attMsgId = withFile.data?.message?.id;
  if (withFile.status !== 201) {
    const byPupil = await api(`/api/chat/conversations/${dmId}/messages`, pupilA.token, {
      method: 'POST', body: JSON.stringify({ body: 'the file', nonce: nonce(), attachments: [fileId] }) });
    attMsgId = byPupil.data.message.id;
  }
  check('a message with an attachment exists', Boolean(attMsgId), String(withFile.status));

  const outsiderFile = await fileStatus(fileId, stranger.token);
  check('a plain staff outsider cannot open the attachment', outsiderFile === 404, String(outsiderFile));

  const adminFile = await fileStatus(fileId, admin.token);
  check('an oversight admin CAN open the attachment for preview', adminFile === 200, String(adminFile));

  const noReasonAtt = await api(
    `/api/oversight/conversations/${dmId}/messages/${attMsgId}/attachments/${fileId}/remove`, admin.token, {
      method: 'POST', body: JSON.stringify({}) });
  check('removing an attachment needs a reason', noReasonAtt.status === 400, String(noReasonAtt.status));

  const revAtt = await api(
    `/api/oversight/conversations/${dmId}/messages/${attMsgId}/attachments/${fileId}/remove`, reviewer.token, {
      method: 'POST', body: JSON.stringify({ reason: 'Academic dishonesty' }) });
  check('a view-only reviewer cannot remove an attachment', revAtt.status === 403, String(revAtt.status));

  const rmAtt = await api(
    `/api/oversight/conversations/${dmId}/messages/${attMsgId}/attachments/${fileId}/remove`, admin.token, {
      method: 'POST', body: JSON.stringify({ reason: 'Academic dishonesty — leaked exam answers' }) });
  check('an oversight admin can remove the attachment', rmAtt.status === 200, String(rmAtt.status));

  const { rows: msgAfter } = await pool.query('SELECT body, attachments, deleted_at FROM messages WHERE id = $1', [attMsgId]);
  check('the message text stays, the attachment is gone from it',
    msgAfter[0].body === 'the file' && msgAfter[0].deleted_at === null
      && Array.isArray(msgAfter[0].attachments) && msgAfter[0].attachments.length === 0,
    JSON.stringify(msgAfter[0]));

  const { rows: fileAfter } = await pool.query('SELECT deleted_at FROM files WHERE id = $1', [fileId]);
  check('and the file itself is soft-deleted so it can no longer be served', fileAfter[0].deleted_at !== null);

  const goneFile = await fileStatus(fileId, admin.token);
  check('the attachment no longer opens for anyone', goneFile === 404, String(goneFile));

  await sleep(150);
  const { rows: attLog } = await pool.query(
    `SELECT metadata FROM audit_log WHERE action = 'chat.oversight.attachment.remove' AND target_id = $1`, [attMsgId]);
  check('the attachment removal is audit-logged with the reason and file name',
    attLog.length === 1 && attLog[0].metadata.fileName === 'answers.pdf'
      && attLog[0].metadata.reason.startsWith('Academic dishonesty'),
    JSON.stringify(attLog[0]?.metadata));

  /* ── No back door to participation ───────────────────────────────────── */
  step('read-and-redact only');

  const post = await api(`/api/oversight/conversations/${groupId}/messages`, admin.token, {
    method: 'POST', body: JSON.stringify({ body: 'hello', nonce: nonce() }) });
  check('there is no oversight endpoint to post a message', post.status === 404, String(post.status));

  const stats = await api('/api/oversight/stats', admin.token);
  check('the overview counts are available',
    stats.status === 200 && typeof stats.data.stats.conversations === 'number'
      && stats.data.stats.redactions >= 1 && stats.data.stats.attachmentsRemoved >= 1,
    JSON.stringify(stats.data?.stats));

} catch (err) {
  fails.push(`❌ threw: ${err instanceof Error ? err.stack : err}`);
} finally {
  try { await pool.query('DELETE FROM files WHERE owner_id = ANY($1::text[])', [ids]); } catch { /* may not exist */ }
  await purgeUsers(pool, ids);
  await pool.query('DELETE FROM roles WHERE is_system = false AND name LIKE \'Reviewer %\'').catch(() => {});
  await pool.query('DELETE FROM roles WHERE is_system = false AND name = \'Viewer Only\'').catch(() => {});
  await pool.end();
}

console.log('\n── Oversight: read any conversation, redact what breaks the rules ──\n');
for (const line of pass) console.log('  ' + line);
if (fails.length) { console.log(''); for (const line of fails) console.log('  ' + line); }
console.log(`\n  ${pass.length} passed, ${fails.length} failed\n`);
process.exit(fails.length ? 1 : 0);
