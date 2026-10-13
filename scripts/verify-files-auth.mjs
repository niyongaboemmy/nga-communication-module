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

  await pool.query('DELETE FROM files WHERE owner_id = ANY($1::text[])', [ids]);
} catch (e) { console.error('suite crashed:', e); results.push({ n: 'crash', ok: false }); }
finally {
  try { await purgeUsers(pool, ids, { quiet: true }); } catch { /* best effort */ }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  await pool.end(); process.exit(failed ? 1 : 0);
}
