#!/usr/bin/env node
/**
 * A gateway restart is painless (R-02, target T8).
 *
 * Runs its own built gateway on a spare port (never the one `npm run dev`
 * uses), connects a crowd of clients, stops it the way pm2 does (SIGINT), and
 * checks that:
 *   - every client is told "restarting" before its socket closes,
 *   - the process exits promptly,
 *   - a new gateway takes them all back, and the reconnects are spread out
 *     rather than arriving in one instant (the web client's rule, reproduced).
 *
 *   npm run build -w @tupo/realtime && npm run verify:realtime:restart
 *   (needs Postgres and Redis; not the dev servers)
 */
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { purgeUsers } from './lib/purge.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const readEnv = (f) => Object.fromEntries(readFileSync(f, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const env = readEnv(join(ROOT, 'apps/realtime/.env'));
const PORT = 5391;
const CLIENTS = 30;
const results = []; const ids = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const entry = join(ROOT, 'apps/realtime/dist/index.js');
if (!existsSync(entry)) { console.error('Build the gateway first: npm run build -w @tupo/realtime'); process.exit(2); }

function startGateway() {
  const child = spawn(process.execPath, [entry], {
    cwd: join(ROOT, 'apps/realtime'),
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('gateway did not start')), 15_000);
    child.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
    child.on('exit', (code) => reject(new Error(`gateway exited (${code}) before listening`)));
  });
  return { child, ready };
}

const pool = new pg.Pool({ connectionString: readEnv(join(ROOT, 'apps/api/.env')).DATABASE_URL });
let gateway; const sockets = [];
try {
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = 'Staff'`);
  const tokens = [];
  for (let i = 0; i < 3; i++) {
    const id = `vrr-${randomBytes(5).toString('hex')}`;
    await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`,
      [id, `Restart ${i}`, `${id}@amashuri.com`, rows[0].id]);
    ids.push(id);
    tokens.push(jwt.sign({ id, misUserId: id, name: `Restart ${i}`, email: `${id}@amashuri.com`, role: 'staff' }, env.JWT_SECRET, { expiresIn: '10m' }));
  }

  console.log('\nGateway restart');
  gateway = startGateway();
  await gateway.ready;

  const state = [];
  for (let i = 0; i < CLIENTS; i++) {
    const s = io(`http://127.0.0.1:${PORT}`, {
      auth: { token: tokens[i % tokens.length] }, transports: ['websocket'],
      reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 5_000,
    });
    const st = { notified: false, notifiedBeforeClose: false, reason: null, reconnectedAt: 0 };
    s.on('system:reconnect_required', () => { st.notified = true; });
    // The web client's rule (apps/web/src/lib/socket.ts): a planned restart
    // reconnects after a random 0.5-4 s instead of re-checking the session.
    s.on('disconnect', (reason) => {
      st.reason = reason;
      st.notifiedBeforeClose = st.notified;
      if (reason === 'io server disconnect' && st.notified) {
        setTimeout(() => { if (s.disconnected) s.connect(); }, 500 + Math.random() * 3_500);
      }
    });
    state.push(st); sockets.push(s);
  }
  await Promise.all(sockets.map((s) => new Promise((r) => (s.connected ? r() : s.once('connect', r)))));
  check(`${CLIENTS} clients connected`, sockets.every((s) => s.connected));

  const stoppedAt = Date.now();
  const exited = new Promise((r) => gateway.child.once('exit', () => r(Date.now() - stoppedAt)));
  gateway.child.kill('SIGINT');
  const exitMs = await Promise.race([exited, sleep(12_000).then(() => -1)]);
  check('the gateway exits promptly on SIGINT', exitMs >= 0 && exitMs < 9_000, `${exitMs} ms`);
  await sleep(300);
  check('every client was told it is a restart before its socket closed',
    state.every((st) => st.notifiedBeforeClose), `${state.filter((st) => st.notifiedBeforeClose).length}/${CLIENTS}`);
  check('the close is a server disconnect, which the client handles itself',
    state.every((st) => st.reason === 'io server disconnect'), [...new Set(state.map((st) => st.reason))].join(', '));

  const restartAt = Date.now();
  sockets.forEach((s, i) => s.once('connect', () => { state[i].reconnectedAt = Date.now(); }));
  gateway = startGateway();
  await gateway.ready;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !sockets.every((s) => s.connected)) await sleep(200);
  check('every client is back on the new gateway', sockets.every((s) => s.connected),
    `${sockets.filter((s) => s.connected).length}/${CLIENTS}`);
  const times = state.map((st) => st.reconnectedAt - restartAt).filter((t) => t > 0).sort((a, b) => a - b);
  const spreadMs = times.length ? times[times.length - 1] - times[0] : 0;
  check('the reconnects are spread out, not one stampede', spreadMs >= 1_000, `first→last ${spreadMs} ms`);
} catch (err) {
  check('suite ran to completion', false, err?.message ?? String(err));
} finally {
  sockets.forEach((s) => s.close());
  if (gateway?.child && gateway.child.exitCode === null) {
    gateway.child.kill('SIGINT');
    await new Promise((r) => { gateway.child.once('exit', r); setTimeout(r, 9_000); });
  }
  await purgeUsers(pool, ids).catch((e) => console.warn('purge:', e.message));
  await pool.end();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nverify:realtime:restart: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
