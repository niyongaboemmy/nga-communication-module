#!/usr/bin/env node
/**
 * Realtime gateway robustness (A-09):
 *   - long-lived sockets are cut off when the session is revoked, the token
 *     expires, or the account is suspended — with a `session:ended` reason;
 *   - presence:query is bounded and tolerates junk;
 *   - two gateway instances do not deliver the same relay message twice;
 *   - a gateway that boots while Redis is down attaches once Redis comes up.
 *
 *   npm run verify:realtime      (needs `npm run dev`; takes ~90 s — the access sweep runs once a minute)
 */
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { Redis } from 'ioredis';
import { io } from 'socket.io-client';
import { purgeUsers } from './lib/purge.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const ids = []; const cleanup = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };

async function makeUser(name, expiresIn = '60m') {
  const id = `vrr-${randomBytes(5).toString('hex')}`;
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = 'Staff'`);
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`,
    [id, name, `${id}@amashuri.com`, rows[0].id]);
  ids.push(id);
  const user = { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' };
  return { id, token: jwt.sign(user, env.JWT_SECRET, { expiresIn }) };
}
const connect = (u, url = 'http://localhost:5191') => new Promise((res, rej) => {
  const s = io(url, { auth: { token: u.token }, transports: ['websocket'], reconnection: false });
  s.ended = null; s.on('session:ended', (p) => { s.ended = p.reason; });
  s.on('connect', () => res(s)); s.on('connect_error', rej);
  cleanup.push(() => s.close());
});
const health = async (port) => { try { return await (await fetch(`http://localhost:${port}/health`)).json(); } catch { return null; } };
async function waitFor(fn, ms, step = 500) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; }
function gateway(port, redisUrl) {
  const p = spawn(`${ROOT}/node_modules/.bin/tsx`, ['src/index.ts'], {
    cwd: `${ROOT}/apps/realtime`, env: { ...process.env, PORT: String(port), REDIS_URL: redisUrl, NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  cleanup.push(() => p.kill('SIGKILL'));
  return p;
}

try {
  console.log('\nSessions end on the server side');
  const revoked = await makeUser('Revoked');
  const expiring = await makeUser('Expiring', '4s');
  const suspended = await makeUser('Suspended');
  const control = await makeUser('Control');
  const [sr, se, ss, sc] = await Promise.all([revoked, expiring, suspended, control].map((u) => connect(u)));
  await sleep(1100);  // revoked_at must fall after the token's iat (seconds)
  await pool.query(`INSERT INTO session_revocations (user_id, revoked_at) VALUES ($1, now())
                    ON CONFLICT (user_id) DO UPDATE SET revoked_at = now()`, [revoked.id]);
  await pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [suspended.id]);
  const allEnded = await waitFor(() => sr.disconnected && se.disconnected && ss.disconnected, 75_000, 1000);
  check('revoked, expired and suspended sockets are all dropped within one sweep', allEnded,
    `revoked=${sr.disconnected} expired=${se.disconnected} suspended=${ss.disconnected}`);
  check('each is told why (session:ended)', sr.ended === 'signed_out' && se.ended === 'expired' && ss.ended === 'suspended',
    `${sr.ended}/${se.ended}/${ss.ended}`);
  check('an unaffected socket stays connected', sc.connected);

  console.log('\nPresence lookups are bounded');
  const many = Array.from({ length: 500 }, (_, i) => `u${i}`);
  const r1 = await sc.timeout(3000).emitWithAck('presence:query', { userIds: many }).catch(() => null);
  check('at most 200 ids are looked up', r1 && Object.keys(r1.presence).length <= 200, `${r1 && Object.keys(r1.presence).length}`);
  const r2 = await sc.timeout(3000).emitWithAck('presence:query', { userIds: [{}, null, 'x'.repeat(200), control.id] }).catch(() => null);
  check('junk ids are ignored, not a crash', r2 && Object.keys(r2.presence).length === 1, JSON.stringify(r2?.presence ?? null).slice(0, 80));
  let refused = 0;
  for (let i = 0; i < 32; i++) {
    const r = await sc.timeout(3000).emitWithAck('presence:query', { userIds: [control.id] }).catch(() => null);
    if (r && r.ok === false) refused++;
  }
  check('a flood of lookups is rate limited', refused > 0, `${refused} refused`);

  console.log('\nTwo gateway instances, one delivery');
  const second = gateway(5292, 'redis://127.0.0.1:6379/0');
  const up2 = await waitFor(async () => (await health(5292))?.checks?.redis === 'ok', 30_000);
  check('a second instance attaches to the same Redis', up2, second.log.split('\n').filter(Boolean).slice(-1)[0] ?? '');
  const listener = await makeUser('Listener');
  const sl = await connect(listener);
  let got = 0; sl.on('notification:new', () => { got++; });
  const pub = new Redis('redis://127.0.0.1:6379/0'); cleanup.push(() => pub.disconnect());
  await sleep(500);
  await pub.publish('tupo:notify', JSON.stringify({ userIds: [listener.id], notification: { id: 'x', kind: 'test', title: 't', body: null, link: null, subjectType: null, subjectId: null, readAt: null, createdAt: new Date().toISOString() } }));
  await pub.publish('tupo:chat', JSON.stringify({ rooms: [`user:${listener.id}`], event: 'notification:new', payload: { id: 'y' } }));
  await sleep(1500);
  check('each relay message reaches the socket exactly once', got === 2, `${got} deliveries for 2 messages`);
  second.kill('SIGKILL');

  console.log('\nBooting while Redis is down');
  const port = 6391;
  const third = gateway(5293, `redis://127.0.0.1:${port}/0`);
  const upNoRedis = await waitFor(async () => Boolean(await health(5293)), 30_000);
  const h1 = await health(5293);
  check('the gateway serves without Redis', upNoRedis && /unavailable/.test(h1?.checks?.redis ?? ''), h1?.checks?.redis);
  const redis = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  cleanup.push(() => redis.kill('SIGKILL'));
  const attached = await waitFor(async () => (await health(5293))?.checks?.redis === 'ok', 40_000, 1000);
  check('and attaches by itself once Redis comes up', attached, (await health(5293))?.checks?.redis);
  const late = await makeUser('Late');
  const s3 = await connect(late, 'http://localhost:5293');
  let lateGot = 0; s3.on('notification:new', () => { lateGot++; });
  const pub3 = new Redis(`redis://127.0.0.1:${port}/0`); cleanup.push(() => pub3.disconnect());
  await sleep(500);
  await pub3.publish('tupo:notify', JSON.stringify({ userIds: [late.id], notification: { id: 'z', kind: 'test', title: 't', createdAt: new Date().toISOString() } }));
  await sleep(1000);
  check('the late-attached relay delivers', lateGot === 1, `${lateGot}`);
} catch (err) {
  check('suite ran to completion', false, err?.stack ?? String(err));
} finally {
  for (const c of cleanup.reverse()) { try { c(); } catch { /* gone */ } }
  await pool.query('DELETE FROM session_revocations WHERE user_id = ANY($1::text[])', [ids]).catch(() => {});
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:realtime: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
