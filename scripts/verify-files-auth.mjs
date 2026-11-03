#!/usr/bin/env node
/**
 * Files service authorisation (A-06): the account behind a token is checked on
 * every request — suspended, signed-out (single sign-out) or role-less callers
 * cannot upload, mint media tickets or download, even with a valid signature.
 *
 *   npm run verify:files:auth      (needs `npm run dev`)
 */
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { purgeUsers } from './lib/purge.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const FILES = 'http://localhost:5192';
const results = []; const ids = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? `  — ${d}` : ''}`); };

async function user(roleName) {
  const id = `vfa-${randomBytes(4).toString('hex')}`;
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id)
    VALUES ($1,$1,'Files Probe',$2,'staff',(SELECT id FROM roles WHERE name = $3))`, [id, `${id}@amashuri.com`, roleName]);
  ids.push(id);
  return { id, token: jwt.sign({ id, misUserId: id, name: 'Files Probe', email: `${id}@amashuri.com`, role: 'staff' }, env.JWT_SECRET) };
}
const ticket = (u) => fetch(`${FILES}/api/files/tickets`, {
  method: 'POST', headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'note.txt', mimeType: 'text/plain', size: 5, purpose: 'attachment' }),
});
async function uploadReady(u) {
  const t = await (await ticket(u)).json();
  const put = await fetch(`${FILES}${t.data.uploadUrl}`, { method: 'PUT', headers: { authorization: `Bearer ${u.token}`, 'content-type': 'text/plain' }, body: 'hello' });
  return { fileId: t.data.fileId ?? t.data.id, ok: put.ok };
}

try {
  const a = await user('Staff');
  const up = await uploadReady(a);
  check('an active staff member can upload', up.ok);
  const content = (u) => fetch(`${FILES}/api/files/${up.fileId}/content`, { headers: { authorization: `Bearer ${u.token}` } });
  check('…and download their file', (await content(a)).status === 200);

  await pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [a.id]);
  check('a suspended account cannot get an upload ticket', (await ticket(a)).status === 403);
  check('…or download', [401, 403].includes((await content(a)).status));
  await pool.query(`UPDATE users SET status = 'active' WHERE id = $1`, [a.id]);

  await pool.query(`INSERT INTO session_revocations (user_id, revoked_at) VALUES ($1, now() + interval '1 second')
    ON CONFLICT (user_id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at`, [a.id]);
  check('a session signed out of NGA (single sign-out) is refused', (await ticket(a)).status === 401);
  check('…including downloads', (await content(a)).status === 401);
  await pool.query('DELETE FROM session_revocations WHERE user_id = $1', [a.id]);

  const roleless = { id: `vfa-${randomBytes(4).toString('hex')}` };
  await pool.query(`INSERT INTO users (id, mis_user_id, name, email, role) VALUES ($1,$1,'No Role',$2,'staff')`, [roleless.id, `${roleless.id}@amashuri.com`]);
  ids.push(roleless.id);
  roleless.token = jwt.sign({ id: roleless.id, misUserId: roleless.id, name: 'No Role', email: 'x', role: 'staff' }, env.JWT_SECRET);
  check('an account with no role (no FILE_UPLOAD) cannot upload', (await ticket(roleless)).status === 403);

  console.log('\n── Upload limits (A-07)');
  const b = await user('Staff');
  const t1 = await (await ticket(b)).json();          // declares 5 bytes
  const big = await fetch(`${FILES}${t1.data.uploadUrl}`, { method: 'PUT', headers: { authorization: `Bearer ${b.token}`, 'content-type': 'text/plain' }, body: 'x'.repeat(5000) });
  check('an upload larger than it declared is refused', big.status === 413, `status ${big.status}`);
  const { rows: st } = await pool.query('SELECT status FROM files WHERE id = $1', [t1.data.fileId]);
  check('…and nothing of it is kept as ready', st[0]?.status === 'failed', st[0]?.status);

  const t2 = await (await ticket(b)).json();
  await pool.query(`UPDATE files SET created_at = now() - interval '2 hours' WHERE id = $1`, [t2.data.fileId]);
  const late = await fetch(`${FILES}${t2.data.uploadUrl}`, { method: 'PUT', headers: { authorization: `Bearer ${b.token}`, 'content-type': 'text/plain' }, body: 'hello' });
  check('an expired upload ticket is refused', late.status === 410, `status ${late.status}`);

  await pool.query(`INSERT INTO files (id, owner_id, storage_driver, storage_key, original_name, mime_type, size_bytes, status)
    VALUES ($1, $2, 'local', $3, 'huge.bin', 'application/octet-stream', $4, 'ready')`,
    [`vfa-big-${randomBytes(3).toString('hex')}`, b.id, `vfa/${randomBytes(3).toString('hex')}`, 11 * 1024 ** 3]);
  const over = await ticket(b);
  check('a new upload over the storage allowance is refused', over.status === 413, `status ${over.status}`);

  await pool.query('DELETE FROM files WHERE owner_id = ANY($1::text[])', [ids]);
} catch (e) { console.error('suite crashed:', e); results.push({ n: 'crash', ok: false }); }
finally {
  try { await purgeUsers(pool, ids, { quiet: true }); } catch { /* best effort */ }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  await pool.end(); process.exit(failed ? 1 : 0);
}
