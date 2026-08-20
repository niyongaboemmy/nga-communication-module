#!/usr/bin/env node
/**
 * Two-ended test: NGA Central MIS ↔ Tupo.
 *
 * Drives the REAL SSO chain against the running MIS —
 *   MIS /sso/authorize  →  authorization code
 *   Tupo /api/sso/exchange  →  MIS /sso/token  →  Tupo session
 * — then asserts Tupo resolved a role and a permission set from it, and that
 * those permissions actually gate the API.
 *
 * The only step not exercised is the MIS's own password form: we mint a MIS
 * session token directly with the MIS's JWT secret. That is the MIS's concern,
 * not Tupo's, and everything downstream of it is genuinely end to end.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const MIS = 'http://localhost:5001';
const TUPO = 'http://localhost:5190';
const REDIRECT = 'http://localhost:5194/sso/callback';

const readEnv = (path) => Object.fromEntries(
  readFileSync(path, 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);

const misEnv = readEnv('../nga_central_mis/backend/.env');
const tupoEnv = readEnv('apps/api/.env');

const results = [];
const check = (name, passed, detail = '') => {
  results.push({ name, passed });
  console.log(`  ${passed ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`);
};

// ── MIS end: pick a real user and mint their session ─────────────────────────
const mysql = '/Applications/MAMP/Library/bin/mysql';
const q = (sql) => execSync(
  `${mysql} -h 127.0.0.1 -P 8889 -u root -p'${misEnv.DB_PASSWORD}' nga_central_mis -sN -e "${sql}"`,
  { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
).trim();

const [misUserId, misUsername, tokenVersion] =
  q("SELECT user_id, username, COALESCE(token_version,0) FROM \\`User\\` WHERE username='superadmin' LIMIT 1").split('\t');
console.log(`\n  MIS user: ${misUsername} (#${misUserId})\n`);

const misToken = jwt.sign(
  { userId: Number(misUserId), username: misUsername, tokenVersion: Number(tokenVersion) },
  misEnv.JWT_SECRET, { expiresIn: '10m' }
);

// ── Step 1: MIS issues an authorization code for the Tupo client ─────────────
const authorizeUrl =
  `${MIS}/sso/authorize?client_id=${tupoEnv.SSO_CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=e2e`;
const authRes = await fetch(authorizeUrl, { headers: { Authorization: `Bearer ${misToken}` } });
const authBody = await authRes.json();
const code = authBody?.data?.code;
check('MIS issues an authorization code for client_id=tupo', authRes.ok && !!code,
  code ? `code ${code.slice(0, 12)}…` : JSON.stringify(authBody).slice(0, 160));
if (!code) process.exit(1);

// A redirect_uri that is not registered must be refused.
const badRes = await fetch(
  `${MIS}/sso/authorize?client_id=${tupoEnv.SSO_CLIENT_ID}&redirect_uri=${encodeURIComponent('http://evil.example/callback')}&response_type=code`,
  { headers: { Authorization: `Bearer ${misToken}` } });
check('MIS rejects an unregistered redirect_uri', !badRes.ok, `HTTP ${badRes.status}`);

// ── Step 2: Tupo exchanges the code for its own session ──────────────────────
const exRes = await fetch(`${TUPO}/api/sso/exchange`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code }),
});
const ex = await exRes.json();
check('Tupo exchanges the code with the MIS and issues a session',
  exRes.ok && ex.success === true && !!ex.data?.token,
  exRes.ok ? `user "${ex.data.user.name}"` : JSON.stringify(ex).slice(0, 200));
if (!exRes.ok) process.exit(1);

const { token: tupoToken, user, rolePermissions, roleName, permissions } = ex.data;

check('Tupo mirrors the MIS identity', user.misUserId === String(misUserId),
  `misUserId ${user.misUserId}`);
check('Tupo assigns an RBAC role from the MIS permissions', !!roleName, `role "${roleName}"`);
check('Tupo returns its own permission set, not the MIS one',
  Array.isArray(rolePermissions) && rolePermissions.length > 0 &&
  rolePermissions.every((k) => k === k.toUpperCase()),
  `${rolePermissions.length} Tupo permissions vs ${permissions.length} MIS permissions`);
check('the MIS token is never exposed to the browser', user.misToken === undefined);

// ── Step 3: the resolved permissions actually gate the API ───────────────────
const auth = { Authorization: `Bearer ${tupoToken}` };
const isAdmin = roleName === 'Admin';

const rolesRes = await fetch(`${TUPO}/api/roles-permissions/roles`, { headers: auth });
check(`role list ${isAdmin ? 'allowed for Admin' : 'refused without permission'}`,
  isAdmin ? rolesRes.ok : rolesRes.status === 403, `HTTP ${rolesRes.status}`);

const meRes = await fetch(`${TUPO}/api/roles-permissions/me`, { headers: auth });
const me = await meRes.json();
check('every signed-in user can read their own permissions',
  meRes.ok && me.data.roleName === roleName, `roleName ${me.data?.roleName}`);

// ── Step 4: an authorization code is single-use ──────────────────────────────
const replay = await fetch(`${TUPO}/api/sso/exchange`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code }),
});
check('a replayed authorization code is rejected', !replay.ok, `HTTP ${replay.status}`);

// ── Step 5: a permission change is felt immediately, with no re-login ────────
if (isAdmin) {
  const pool = new pg.Pool({ connectionString: tupoEnv.DATABASE_URL });
  const { rows } = await pool.query("SELECT id FROM roles WHERE name = 'Student'");
  const studentRoleId = rows[0].id;

  const before = await fetch(`${TUPO}/api/audit`, { headers: auth });
  await pool.query('UPDATE users SET role_id = $2 WHERE id = $1', [user.id, studentRoleId]);
  const after = await fetch(`${TUPO}/api/audit`, { headers: auth });
  await pool.query(
    "UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'Admin') WHERE id = $1", [user.id]
  );
  const restored = await fetch(`${TUPO}/api/audit`, { headers: auth });
  await pool.end();

  check('demoting a user takes effect on the very next request (same token)',
    before.ok && after.status === 403 && restored.ok,
    `${before.status} → ${after.status} → ${restored.status}`);
}

// ── Step 6: the MIS-session poll and the app switcher ────────────────────────
const verify = await fetch(`${TUPO}/api/sso/verify-mis`, { headers: auth });
check('Tupo can verify the MIS session is still alive', verify.ok, `HTTP ${verify.status}`);

const systems = await fetch(`${TUPO}/api/sso/systems`, { headers: auth });
const sysBody = await systems.json();
const names = (sysBody.data?.systems ?? []).map((s) => s.name);
check('the app switcher lists sibling systems from the MIS',
  systems.ok && names.length > 0, names.join(', ') || 'empty');
check('Tupo appears in the MIS systems list', names.includes('Tupo'), names.join(', '));

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} end-to-end checks passed`);
process.exit(failed.length ? 1 : 0);
