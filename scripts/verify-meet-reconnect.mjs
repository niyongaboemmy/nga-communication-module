#!/usr/bin/env node
/**
 * Meet reconnect (E-03 / MEET-RT1): a dropped connection returns an admitted
 * participant to the call — not to a lobby the host never sees — on a new
 * attendance leg, and media tokens keep working.
 *
 *   npm run verify:meet:reconnect      (needs `npm run dev`)
 */
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { io } from 'socket.io-client';
import { purgeUsers } from './lib/purge.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const API = 'http://localhost:5190';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const ids = []; const meetings = []; const sockets = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };

async function makeUser(name) {
  const id = `vmr-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = 'Staff'`);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`, [id, name, `${id}@amashuri.com`, rows[0].id]);
  ids.push(id);
  const u = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' };
  return { id, token: jwt.sign(u, env.JWT_SECRET, { expiresIn: '30m' }) };
}
const call = async (u, method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
function joinSocket(u, meetingId, participantId) {
  return new Promise((resolve, reject) => {
    const s = io('http://localhost:5191/meet', { auth: { token: u.token }, transports: ['websocket'], reconnection: false });
    sockets.push(s);
    const t = setTimeout(() => reject(new Error('no meet:state')), 8000);
    s.on('meet:state', (st) => { clearTimeout(t); resolve({ s, st }); });
    s.on('connect', () => s.emit('meet:join', { meetingId, participantId }, (res) => { if (!res?.ok) { clearTimeout(t); reject(new Error(res?.message)); } }));
    s.on('connect_error', reject);
  });
}
const rowOf = async (pid) => (await pool.query('SELECT state, duration_seconds FROM meeting_participants WHERE id = $1', [pid])).rows[0];

try {
  const host = await makeUser('Host');
  const pupil = await makeUser('Pupil');
  const m = await call(host, 'POST', '/api/meet/instant', { title: 'Reconnect probe', settings: { admissionPolicy: 'authenticated', lobbyEnabled: false } });
  const meetingId = (m.body?.data?.meeting ?? m.body?.data)?.id; meetings.push(meetingId);
  const hj = await call(host, 'POST', `/api/meet/${meetingId}/join`, {});
  await joinSocket(host, meetingId, hj.body.data.participantId);

  const j = await call(pupil, 'POST', `/api/meet/${meetingId}/join`, {});
  const pid = j.body?.data?.participantId;
  check('the pupil is admitted', j.body?.data?.state === 'active', j.body?.data?.state);
  const first = await joinSocket(pupil, meetingId, pid);
  check('in the call over the socket', first.st.you.state === 'active');

  first.s.disconnect();
  await sleep(800);
  check('a dropped socket closes the leg', (await rowOf(pid))?.state === 'left');

  const again = await joinSocket(pupil, meetingId, pid);
  check('reconnecting puts them straight back in the call, not the lobby', again.st.you.state === 'active', again.st.you.state);
  await sleep(300);
  check('the row is active again', (await rowOf(pid))?.state === 'active');
  const tok = await call(pupil, 'POST', `/api/meet/${meetingId}/token`, {});
  check('media tokens work after the reconnect', tok.status === 200, String(tok.status));
  const legs = (await pool.query('SELECT count(*)::int AS n FROM meeting_attendance_segments WHERE participant_id = $1', [pid])).rows[0].n;
  check('the first leg was banked as its own segment', legs === 1, `${legs}`);
} catch (err) {
  check('suite ran to completion', false, err?.stack ?? String(err));
} finally {
  for (const s of sockets) s.close();
  await pool.query('DELETE FROM meeting_attendance_segments WHERE meeting_id = ANY($1::text[])', [meetings]).catch(() => {});
  for (const t of ['meeting_events', 'meeting_participants']) await pool.query(`DELETE FROM ${t} WHERE meeting_id = ANY($1::text[])`, [meetings]).catch(() => {});
  await pool.query('DELETE FROM meetings WHERE id = ANY($1::text[])', [meetings]).catch(() => {});
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:meet:reconnect: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
