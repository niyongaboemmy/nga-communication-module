#!/usr/bin/env node
/** Gap-analysis security probe (temporary). Needs `npm run dev`. Crash probes run last. */
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { purgeUsers } from './lib/purge.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const API = 'http://localhost:5190', RT = 'http://localhost:5191';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const ids = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
async function makeUser(name, roleName) {
  const id = `gaps-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = $1`, [roleName]);
  const role = roleName.toLowerCase();
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`, [id, name, `${id}@amashuri.com`, role, rows[0].id]);
  ids.push(id);
  return { id, name, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role }, env.JWT_SECRET, { expiresIn: '30m' }) };
}
const call = async (u, method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).catch((e) => ({ status: 0, json: async () => ({ err: e.message }) }));
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const nonce = () => randomBytes(8).toString('hex');
const alive = async (url) => fetch(url).then((r) => r.ok).catch(() => false);

let socks = [];
try {
  const A = await makeUser('Sec Ada', 'Staff');
  const B = await makeUser('Sec Ben', 'Staff');
  const C = await makeUser('Sec Cleo', 'Student');
  const S = await makeUser('Sec Sam', 'Student');

  console.log('\n── Chat integrity');
  const grp = await call(A, 'POST', '/api/chat/conversations', { type: 'group', name: `sec-${nonce()}`, memberIds: [B.id, C.id], visibility: 'private' });
  const gid = grp.body?.data?.conversation?.id;
  check('A creates private group with B and C', !!gid, `status ${grp.status} ${JSON.stringify(grp.body).slice(0, 100)}`);
  const sys = await call(C, 'POST', `/api/chat/conversations/${gid}/messages`, { body: 'OFFICIAL: exams cancelled', type: 'system', nonce: nonce() });
  const stored = sys.body?.data?.message?.type;
  check('client cannot post a message with type "system"', stored !== 'system', `status ${sys.status}, stored type=${stored}`);
  if (sys.body?.data?.message?.id) {
    const del = await call(A, 'DELETE', `/api/chat/conversations/${gid}/messages/${sys.body.data.message.id}`);
    check('group owner can remove a spoofed system notice', del.status === 200, `status ${del.status} ${JSON.stringify(del.body).slice(0, 80)}`);
  }

  // edit-history IDOR: A–B DM with an edited message; S reads it via their own DM id
  const dm = await call(A, 'POST', '/api/chat/conversations/direct', { userId: B.id });
  const dmId = dm.body?.data?.conversation?.id;
  const m = await call(A, 'POST', `/api/chat/conversations/${dmId}/messages`, { body: 'PRIVATE ORIGINAL', nonce: nonce() });
  const mid = m.body?.data?.message?.id;
  await call(A, 'PATCH', `/api/chat/conversations/${dmId}/messages/${mid}`, { body: 'cleaned up' });
  const sdm = await call(S, 'POST', '/api/chat/conversations/direct', { userId: C.id });
  let sConv = sdm.body?.data?.conversation?.id;
  if (!sConv) { const g2 = await call(A, 'POST', '/api/chat/conversations', { type: 'group', name: `s-${nonce()}`, memberIds: [S.id] }); sConv = g2.body?.data?.conversation?.id; }
  const hist = await call(S, 'GET', `/api/chat/conversations/${sConv}/messages/${mid}/history`);
  check('edit history of a foreign DM message is NOT readable via own conversation id (IDOR)', !JSON.stringify(hist.body).includes('PRIVATE ORIGINAL'), `status ${hist.status} ${JSON.stringify(hist.body).slice(0, 120)}`);
  const reac = await call(B, 'POST', `/api/chat/conversations/${dmId}/messages/${mid}/reactions`, { emoji: '👍' });
  const who = await call(S, 'GET', `/api/chat/conversations/${sConv}/messages/${mid}/reactions`);
  check('reactor list of a foreign message is NOT readable (IDOR)', !JSON.stringify(who.body).includes('Sec Ben'), `react ${reac.status}; status ${who.status} ${JSON.stringify(who.body).slice(0, 100)}`);

  // announcement channel bypass
  const ann = await call(A, 'POST', '/api/chat/conversations', { type: 'announcement', name: `ann-${nonce()}`, memberIds: [C.id], visibility: 'private' });
  const aid = ann.body?.data?.conversation?.id;
  if (aid) {
    const root = await call(A, 'POST', `/api/chat/conversations/${aid}/messages`, { body: 'Announcement', nonce: nonce() });
    const direct = await call(C, 'POST', `/api/chat/conversations/${aid}/messages`, { body: 'student post', nonce: nonce() });
    check('student cannot post directly in announcement channel', direct.status === 403, `status ${direct.status}`);
    const rep = await call(C, 'POST', `/api/chat/conversations/${aid}/messages/${root.body?.data?.message?.id}/replies`, { body: 'BYPASS via thread', alsoSendToChannel: true, nonce: nonce() });
    check('student cannot post into announcement channel via thread reply + alsoSendToChannel', rep.status >= 400, `status ${rep.status}`);
    const sch = await call(C, 'POST', `/api/chat/conversations/${aid}/scheduled`, { body: 'BYPASS via schedule', sendAt: new Date(Date.now() + 60_000).toISOString(), scheduledAt: new Date(Date.now() + 60_000).toISOString() });
    check('student cannot schedule a post into announcement channel', sch.status >= 400, `status ${sch.status} ${JSON.stringify(sch.body).slice(0, 80)}`);
  } else check('announcement channel created', false, `status ${ann.status} ${JSON.stringify(ann.body).slice(0, 100)}`);

  // removed member keeps socket stream
  const cs = io(RT, { auth: { token: C.token }, transports: ['websocket'], reconnection: false }); socks.push(cs);
  await new Promise((r) => cs.on('connect', r));
  cs.log = []; cs.onAny((ev, p) => cs.log.push({ ev, p }));
  await new Promise((r) => cs.emit('conversation:subscribe', { conversationIds: [gid] }, r));
  const rm = await call(A, 'DELETE', `/api/chat/conversations/${gid}/members/${C.id}`);
  await sleep(700); cs.log = [];
  await call(A, 'POST', `/api/chat/conversations/${gid}/messages`, { body: 'AFTER-REMOVAL secret', nonce: nonce() });
  await sleep(900);
  const leaked = cs.log.some((e) => e.ev === 'message:new' && JSON.stringify(e.p).includes('AFTER-REMOVAL'));
  check('removed member stops receiving the group over an open socket', !leaked, `remove ${rm.status}; leaked=${leaked}`);

  console.log('\n── Meet access');
  const mt = await call(A, 'POST', '/api/meet', { title: 'Private staff meeting', admissionPolicy: 'invited', settings: { admissionPolicy: 'invited' } });
  const meet = mt.body?.data?.meeting ?? mt.body?.data;
  check('A schedules an invite-only meeting', !!meet?.id, `status ${mt.status} ${JSON.stringify(mt.body).slice(0, 100)}`);
  if (meet?.id) {
    const g = await call(S, 'GET', `/api/meet/${meet.id}`);
    check('uninvited student cannot read meeting details', g.status >= 400, `status ${g.status}`);
    const rec = await call(S, 'GET', `/api/meet/${meet.id}/recordings`);
    check('uninvited student cannot list recordings', rec.status >= 400, `status ${rec.status}`);
    const ics = await call(S, 'GET', `/api/meet/${meet.id}/ics`);
    check('uninvited student cannot download the ICS', ics.status >= 400, `status ${ics.status}`);
    const ai = await call(B, 'GET', `/api/meet/${meet.id}/ai`);
    check('uninvited staff cannot read the meeting AI artifacts', ai.status >= 400, `status ${ai.status}`);
  }

  console.log('\n── Crash resilience (destructive to local dev processes)');
  const r1 = process.env.SKIP_API_CRASH ? { status: 'skipped' } : await call(S, 'GET', '/api/meet?limit=x');
  await sleep(1500);
  const apiUp = await alive(`${API}/api/health`);
  check('GET /api/meet?limit=x does not crash the API', apiUp, `response status ${r1.status}; api alive after = ${apiUp}`);
  if (meet?.id) {
    const j = await call(A, 'POST', `/api/meet/${meet.id}/join`, {});
    const pid = j.body?.data?.participant?.id ?? j.body?.data?.participantId;
    const ms = io(`${RT}/meet`, { auth: { token: A.token }, transports: ['websocket'], reconnection: false }); socks.push(ms);
    await new Promise((r) => { ms.on('connect', r); setTimeout(r, 3000); });
    ms.emit('meet:join', { meetingId: meet.id, participantId: pid }, () => {});
    await sleep(800);
    ms.emit('meet:question_upvote', { questionId: '1' });
    await sleep(2000);
    const rtUp = await alive('http://localhost:5191/health') || await alive('http://localhost:5191/healthz');
    check('bogus meet:question_upvote does not crash the realtime gateway', rtUp, `join ${j.status}; realtime alive after = ${rtUp}`);
  }
} catch (e) { console.error('probe crashed:', e); }
finally {
  socks.forEach((s) => s.disconnect());
  try { await purgeUsers(pool, ids, { quiet: true }); } catch (e) { console.error('cleanup:', e.message); }
  console.log(`\n${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
  await pool.end(); process.exit(0);
}
