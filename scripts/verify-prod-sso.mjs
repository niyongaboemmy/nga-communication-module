#!/usr/bin/env node
/**
 * Production SSO acceptance check — NGA Central MIS ↔ Tupo, over the real
 * public URLs.
 *
 * `scripts/e2e-sso.mjs` is the developer-machine version of this: it assumes
 * MAMP's mysql binary, localhost ports and a local MIS. This one runs ON the
 * deployment host, drives https://api.amashuri.com and https://tupo.amashuri.com,
 * and is what proves a deploy actually authenticates people.
 *
 * As in the dev script, the one step not exercised is the MIS's own password
 * form — we mint a MIS session token directly with the MIS's JWT secret. That
 * form is the MIS's concern; everything downstream of it is genuinely end to
 * end, including the real HTTPS hops and the real client secret.
 *
 * Nothing identifying is printed: the test user's name is masked, because this
 * output is meant to be safe to paste into a deploy log.
 *
 *   node scripts/verify-prod-sso.mjs
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import jwt from 'jsonwebtoken';

const MIS_API = process.env.MIS_API ?? 'https://api.amashuri.com';
const TUPO_API = process.env.TUPO_API ?? 'https://tupo.amashuri.com';
const REDIRECT = process.env.TUPO_REDIRECT ?? 'https://tupo.amashuri.com/sso/callback';
const MIS_ENV = process.env.MIS_ENV_PATH ?? '/opt/apps/nga_central_mis/backend/.env';
const TUPO_ENV = process.env.TUPO_ENV_PATH ?? '/opt/apps/nga-communication-module/apps/api/.env';

/** dotenv-ish reader: first '=' splits, surrounding quotes stripped. */
const readEnv = (path) => Object.fromEntries(
  readFileSync(path, 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      const v = l.slice(i + 1).trim();
      return [l.slice(0, i).trim(), v.replace(/^["']|["']$/g, '')];
    })
);

const misEnv = readEnv(MIS_ENV);
const tupoEnv = readEnv(TUPO_ENV);

const results = [];
const check = (name, passed, detail = '') => {
  results.push({ name, passed });
  console.log(`  ${passed ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`);
};

const mask = (s) => (s ? `${String(s).slice(0, 2)}***` : '(none)');

const q = (sql) => execSync(
  `mysql -h ${misEnv.DB_HOST} -u ${misEnv.DB_USERNAME} -p'${misEnv.DB_PASSWORD}' ${misEnv.DB_NAME} -sN -e "${sql}"`,
  { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
).trim();

console.log('\nTupo — production SSO acceptance\n');

// ── 0. The client registration the MIS holds for Tupo ────────────────────────
const [regClientId, regRedirects, regStatus] = q(
  "SELECT client_id, allowed_redirect_uris, status FROM \\`System\\` WHERE client_id='tupo' LIMIT 1",
).split('\t');

check('MIS has an ACTIVE registration for client_id=tupo', regStatus === 'ACTIVE', `status=${regStatus}`);
check('Registered redirect URI matches this deployment',
  (regRedirects ?? '').split(',').map((s) => s.trim()).includes(REDIRECT), REDIRECT);
check('Tupo API is configured with the same client_id', tupoEnv.SSO_CLIENT_ID === regClientId,
  `${tupoEnv.SSO_CLIENT_ID} vs ${regClientId}`);
check('Tupo API points at the MIS API host (not the SPA host)',
  tupoEnv.NGA_MIS_BASE_URL === MIS_API, tupoEnv.NGA_MIS_BASE_URL);

// ── 1. Mint a MIS session for a real privileged user ─────────────────────────
const [misUserId, misUsername, tokenVersion] = q(
  "SELECT u.user_id, u.username, COALESCE(u.token_version,0) FROM \\`User\\` u " +
  "JOIN UserRole ur ON ur.user_id=u.user_id JOIN Role r ON r.role_id=ur.role_id " +
  "WHERE r.name='SUPER_ADMIN' ORDER BY u.user_id LIMIT 1",
).split('\t');
check('Found a MIS SUPER_ADMIN to test with', Boolean(misUserId), `user ${mask(misUsername)}`);

const misToken = jwt.sign(
  { userId: Number(misUserId), username: misUsername, tokenVersion: Number(tokenVersion) },
  misEnv.JWT_SECRET, { expiresIn: '10m' },
);

// ── 2. MIS issues an authorization code for the Tupo client ──────────────────
const authorizeUrl = `${MIS_API}/sso/authorize?client_id=${encodeURIComponent(tupoEnv.SSO_CLIENT_ID)}`
  + `&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=prodcheck`;
const authRes = await fetch(authorizeUrl, { headers: { Authorization: `Bearer ${misToken}` } });
const authBody = await authRes.json().catch(() => ({}));
const code = authBody?.data?.code ?? authBody?.code
  ?? (authBody?.data?.redirect_uri ? new URL(authBody.data.redirect_uri).searchParams.get('code') : null);
check('MIS /sso/authorize returned an authorization code', Boolean(code), `HTTP ${authRes.status}`);

// ── 3. Tupo exchanges it — this is the hop that uses the real client secret ──
let session = null;
if (code) {
  const exRes = await fetch(`${TUPO_API}/api/sso/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const exBody = await exRes.json().catch(() => ({}));
  session = exBody?.data ?? null;
  check('Tupo /api/sso/exchange minted a session', Boolean(session?.token),
    `HTTP ${exRes.status}${session?.token ? '' : ` ${JSON.stringify(exBody).slice(0, 160)}`}`);
  check('Session carries a Tupo role', Boolean(session?.roleName ?? session?.user?.role),
    `role=${session?.roleName ?? session?.user?.role ?? 'unassigned'}`);
  check('Role resolved a non-empty permission set',
    Array.isArray(session?.rolePermissions) && session.rolePermissions.length > 0,
    `${session?.rolePermissions?.length ?? 0} permissions`);
}

// ── 4. The session actually works against a protected endpoint ───────────────
if (session?.token) {
  const meRes = await fetch(`${TUPO_API}/api/sso/me`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  check('Tupo session authenticates a protected route (/api/sso/me)', meRes.status === 200,
    `HTTP ${meRes.status}`);

  // Authorization must be enforced server-side, not merely reflected back.
  const noAuth = await fetch(`${TUPO_API}/api/sso/me`);
  check('Same route refuses an unauthenticated caller', noAuth.status === 401, `HTTP ${noAuth.status}`);
}

// ── 5. There is still no local login path ────────────────────────────────────
const loginProbe = await fetch(`${TUPO_API}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'x', password: 'y' }),
});
check('No local login endpoint exists', loginProbe.status === 404, `HTTP ${loginProbe.status}`);

const failed = results.filter((r) => !r.passed);
console.log(`\n  ${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length ? 1 : 0);
