#!/usr/bin/env node
/**
 * Notifications, against the running stack.
 *
 * The behaviour worth pinning is not "a row was written" — it is the set of
 * rules that decide whether a notification is useful or noise: that the
 * audience is exactly whoever may join, that the host is not told about their
 * own meeting, that one person cannot dismiss another's, and that a meeting
 * which has ended stops inviting people into it.
 *
 *   npm run verify:notifications      (needs `npm run dev` running)
 */
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync('apps/api/.env','utf8').split('\n')
  .filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
  .map(l => [l.slice(0,l.indexOf('=')).trim(), l.slice(l.indexOf('=')+1).trim()]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

async function makeUser(name, roleName) {
  const id = `ntest-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query('SELECT id FROM roles WHERE name = $1', [roleName]);
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id)
     VALUES ($1,$1,$2,$3,'staff',$4)`,
    [id, name, `${id}@amashuri.com`, rows[0]?.id ?? null]);
  const token = jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' },
    env.JWT_SECRET, { expiresIn: '15m' });
  return { id, name, token };
}
const api = async (path, token, init = {}) => {
  const res = await fetch(`http://localhost:5190${path}`, {
    ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers||{}) }});
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};

const pass = [], fail = [];
const check = (n, ok, d='') => (ok ? pass : fail).push(`${ok?'✅':'❌'} ${n}${d?`  — ${d}`:''}`);

const host = await makeUser('Notif Host', 'Staff');
const other = await makeUser('Notif Watcher', 'Staff');

// A meeting anyone signed in may join.
const created = await api('/api/meet/instant', host.token, { method: 'POST', body: JSON.stringify({
  title: 'Notification test meeting', category: 'loggedIn' })});
check('meeting created', created.status === 200 || created.status === 201, `${created.status} ${created.body.message ?? ''}`);
const meetingId = created.body.data?.id;

// Host joins → meeting goes live → audience is notified.
const joined = await api(`/api/meet/${meetingId}/join`, host.token, { method: 'POST', body: '{}' });
check('host joined and started it', joined.status === 200, `${joined.status} ${joined.body.message ?? ''}`);

await new Promise(r => setTimeout(r, 1200));   // announce runs off the request

const inbox = await api('/api/notifications', other.token);
const list = inbox.body.data?.notifications ?? [];
check('a joinable meeting notifies the audience', list.some(n => n.subjectId === meetingId),
  `${list.length} notification(s): ${list.map(n=>n.title).join(' | ')}`);
check('the notification links into the meeting',
  list.find(n => n.subjectId === meetingId)?.link === `/app/meet/${meetingId}`);
check('unread count reflects it', (inbox.body.data?.unread ?? 0) >= 1, `unread=${inbox.body.data?.unread}`);

const hostInbox = await api('/api/notifications', host.token);
check('the host is not notified about their own meeting',
  !(hostInbox.body.data?.notifications ?? []).some(n => n.subjectId === meetingId));

// Live list: visible to someone never invited.
const live = await api('/api/meet/live', other.token);
const mine = (live.body.data ?? []).find(m => m.id === meetingId);
check('it appears in the live list for anyone allowed to join', !!mine,
  `${(live.body.data ?? []).length} live`);
check('the live entry summarises who is present',
  Array.isArray(mine?.present) && mine.present.length >= 1,
  `${mine?.activeCount} present: ${(mine?.present ?? []).map(p=>p.name).join(', ')}`);

// Read semantics.
const first = list.find(n => n.subjectId === meetingId);
if (!first) { console.log([...pass, ...fail].join('\n')); console.log('\nSTOPPED: no notification was created'); process.exit(1); }
const read = await api(`/api/notifications/${first.id}/read`, other.token, { method: 'POST' });
check('marking read works and is scoped', read.status === 200, `unread now ${read.body.data?.unread}`);
const stolen = await api(`/api/notifications/${first.id}/read`, host.token, { method: 'POST' });
check('another user cannot mark it read', stolen.status === 404);

// Ending revokes.
await api(`/api/meet/${meetingId}/end`, host.token, { method: 'POST' });
await new Promise(r => setTimeout(r, 600));
const after = await api('/api/notifications', other.token);
check('ending the meeting withdraws the invitation',
  !(after.body.data?.notifications ?? []).some(n => n.subjectId === meetingId));

await pool.query(`DELETE FROM meetings WHERE host_id LIKE 'ntest-%'`).catch(()=>{});
await pool.query(`DELETE FROM users WHERE id LIKE 'ntest-%'`).catch(()=>{});
await pool.end();
console.log([...pass, ...fail].join('\n'));
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
