#!/usr/bin/env node
/**
 * Phase 0 acceptance checks V6-V8: the paths that only show up at runtime —
 * socket authentication, the Redis job rail, and a file upload round-trip.
 *
 * Mints a session token directly (rather than going through the MIS) so the
 * stack can be verified before SSO credentials are issued.
 */
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { io } from 'socket.io-client';

const env = Object.fromEntries(
  readFileSync('apps/api/.env', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const results = [];
const check = (name, passed, detail = '') => {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`);
};

// A throwaway user so the auth middleware's DB lookup succeeds.
const userId = `verify-${randomBytes(4).toString('hex')}`;
await pool.query(
  `INSERT INTO users (id, mis_user_id, name, email, role) VALUES ($1, $1, 'Verify Bot', 'verify@amashuri.com', 'staff')`,
  [userId]
);
const token = jwt.sign(
  { id: userId, misUserId: userId, name: 'Verify Bot', email: 'verify@amashuri.com', role: 'staff' },
  env.JWT_SECRET, { expiresIn: '10m' }
);

try {
  // ---- V6: realtime accepts an authenticated socket, rejects an anonymous one
  const connected = await new Promise((resolve) => {
    const socket = io('http://localhost:5191', { auth: { token }, transports: ['websocket'], timeout: 5000 });
    socket.on('connection:ready', (p) => { socket.close(); resolve(p); });
    socket.on('connect_error', (e) => { socket.close(); resolve({ error: e.message }); });
  });
  check('realtime accepts an authenticated socket', connected.userId === userId,
    connected.error ?? `socketId ${connected.socketId}`);

  const rejected = await new Promise((resolve) => {
    const socket = io('http://localhost:5191', { transports: ['websocket'], timeout: 5000 });
    socket.on('connection:ready', () => { socket.close(); resolve({ connected: true }); });
    socket.on('connect_error', (e) => { socket.close(); resolve({ error: e.message }); });
  });
  check('realtime rejects an unauthenticated socket', !!rejected.error, rejected.error);

  // ---- V7: Redis → BullMQ → worker
  const before = (await (await fetch('http://localhost:5193/health')).json()).processed;
  await fetch('http://localhost:5193/dev/heartbeat', { method: 'POST' });
  let after = before;
  for (let i = 0; i < 20 && after === before; i++) {
    await new Promise((r) => setTimeout(r, 250));
    after = (await (await fetch('http://localhost:5193/health')).json()).processed;
  }
  check('worker processes a queued job', after > before, `processed ${before} → ${after}`);

  // ---- V8: file upload round-trip with checksum comparison
  const payload = Buffer.from(`tupo phase 0 verification ${new Date().toISOString()}\n`.repeat(64));
  const expected = createHash('sha256').update(payload).digest('hex');
  const auth = { Authorization: `Bearer ${token}` };

  const ticket = await (await fetch('http://localhost:5192/api/files/tickets', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'verify.txt', size: payload.length, mime: 'text/plain' }),
  })).json();
  check('files issues an upload ticket', ticket.success === true, ticket.data?.fileId ?? ticket.message);

  const uploaded = await (await fetch(`http://localhost:5192${ticket.data.uploadUrl}`, {
    method: 'PUT', headers: auth, body: payload, duplex: 'half',
  })).json();
  const storedOk = uploaded.data?.checksum === expected && uploaded.data?.sizeBytes === payload.length;
  check('files stores the upload and checksums it', storedOk,
    storedOk ? `${uploaded.data.sizeBytes} bytes, sha256 matches (${expected.slice(0, 12)}…)`
             : `expected ${payload.length} bytes / ${expected.slice(0, 12)}…, got ${JSON.stringify(uploaded.data ?? uploaded)}`);

  const downloadRes = await fetch(`http://localhost:5192/api/files/${ticket.data.fileId}/content`, { headers: auth });
  const downloaded = Buffer.from(await downloadRes.arrayBuffer());
  check('files serves the bytes back unchanged', downloaded.equals(payload),
    `${downloaded.length} bytes, disposition="${downloadRes.headers.get('content-disposition')}"`);

  const unauth = await fetch(`http://localhost:5192/api/files/${ticket.data.fileId}/content`);
  check('files refuses an unauthenticated download', unauth.status === 401, `HTTP ${unauth.status}`);

  // Ticket reuse must not silently overwrite a stored file.
  const replay = await fetch(`http://localhost:5192${ticket.data.uploadUrl}`, {
    method: 'PUT', headers: auth, body: payload, duplex: 'half',
  });
  check('files rejects reuse of a spent upload ticket', replay.status === 409, `HTTP ${replay.status}`);
} finally {
  await pool.query('DELETE FROM files WHERE owner_id = $1', [userId]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} runtime checks passed`);
process.exit(failed.length ? 1 : 0);
