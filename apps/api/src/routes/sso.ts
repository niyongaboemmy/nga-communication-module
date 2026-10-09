import express, { Router, type Request, type Response } from 'express';
import { LogoutTokenError, verifyLogoutToken } from '../utils/ssoLogout.js';
import { publishSessionEnd } from '../services/chatRealtime.js';
import jwt from 'jsonwebtoken';
import { ok, fail, resolveMisRole, ssoExchangeSchema } from '@tupo/shared';
import type { SessionClaims } from '@tupo/shared';
import { getPool, resolveUserPermissions } from '@tupo/db';
import { config } from '../config.js';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { exchangeCode, fetchMe, misAvatarUrl, misCoverUrl, verifyMisSessionDetailed } from '../services/misClient.js';
import { accessMode } from '../access/mode.js';
import { getAccessSnapshot, noteAccessVersion } from '../access/snapshot.js';
import { academicFromSnapshot, placementDiffers, syncAccessProfile } from '../access/profileSync.js';
import { recordShadowDiff } from '../access/shadow.js';
import { upsertMisUser, audit, setUserAvatar, setUserCover, type MisAcademic } from '../services/userService.js';

/**
 * Fold the MIS `/users/me` payload into the academic placement Tupo stores.
 *
 * `assignedPrograms` is a programme lead's scope; `assignedGrades` a class
 * teacher's (grade + specific class group). A student's own class group is not
 * on this payload, so a plain student comes back with `student` and no ids —
 * the dashboard counts them via the leads/teachers who *do* carry the grade.
 */
export function readAcademic(me: Record<string, unknown> | null, forceAdmin: boolean): MisAcademic {
  const empty: MisAcademic = {
    level: 'none', programIds: [], gradeIds: [], classGroupIds: [],
    programNames: [], gradeNames: [], classGroupNames: [],
  };
  if (!me) return forceAdmin ? { ...empty, level: 'super_admin' } : empty;

  const roles = Array.isArray(me.roles) ? me.roles : [];
  const roleNames = roles.map((r) => String((r as Record<string, unknown>)?.name ?? '').toUpperCase());
  const programs = Array.isArray(me.assignedPrograms) ? me.assignedPrograms as Record<string, unknown>[] : [];
  const grades = Array.isArray(me.assignedGrades) ? me.assignedGrades as Record<string, unknown>[] : [];
  const profile = (me.profile ?? {}) as Record<string, unknown>;
  const userType = String(profile.user_type ?? '').toUpperCase();

  const str = (v: unknown) => (v == null ? '' : String(v));
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

  // What the placement alone says, before the SUPER_ADMIN override — kept so a
  // person pinned to a non-admin Tupo role still gets their real placement.
  let placementLevel: MisAcademic['level'] = 'none';
  if (programs.length) placementLevel = 'program_lead';
  else if (grades.length) placementLevel = 'class_teacher';
  else if (userType === 'STUDENT') placementLevel = 'student';
  else if (userType === 'PARENT') placementLevel = 'parent';
  else if (userType === 'TEACHER' || userType === 'STAFF' || userType === 'ADMIN') placementLevel = 'staff';

  const level: MisAcademic['level'] =
    forceAdmin || roleNames.includes('SUPER_ADMIN') ? 'super_admin' : placementLevel;

  return {
    level,
    placementLevel,
    // Membership: a class teacher belongs to the programme of their grade, so
    // a programme lead's dashboard counts them. This is NOT the viewer's own
    // scope — that is `leadProgramIds` below. Using the merged list as scope
    // let a class teacher see their whole programme (privacy fix, Phase 7).
    programIds: uniq([
      ...programs.map((p) => str(p.program_id)),
      ...grades.map((g) => str(g.program_id)),
    ]),
    leadProgramIds: uniq(programs.map((p) => str(p.program_id))),
    gradeIds: uniq(grades.map((g) => str(g.grade_id))),
    classGroupIds: uniq(grades.map((g) => str(g.class_group_id))),
    programNames: uniq([
      ...programs.map((p) => str(p.name)),
      ...grades.map((g) => str(g.program_name)),
    ]),
    gradeNames: uniq(grades.map((g) => str(g.name))),
    classGroupNames: uniq(grades.map((g) => str(g.class_group_name))),
  };
}

const router = Router();

/**
 * Sliding-window rate limiter on the token exchange, so authorization codes
 * cannot be brute-forced. In-memory is adequate because a code is only ever
 * valid at the one instance the user was redirected to; Redis-backed limiting
 * arrives with the rest of the rate-limit work in Phase 5.
 */
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  attempts.set(ip, recent);
  if (attempts.size > 10_000) {
    for (const [key, times] of attempts) {
      if (times.every((t) => now - t >= WINDOW_MS)) attempts.delete(key);
    }
  }
  return recent.length > MAX_ATTEMPTS;
}

/** Exposed for tests so one suite's attempts don't leak into the next. */
export function __resetRateLimiter(): void {
  attempts.clear();
}

/**
 * THE ONLY WAY INTO THIS APPLICATION.
 *
 * There is no password endpoint, no registration and no local credential
 * check anywhere in Tupo — identity always originates in the NGA Central MIS,
 * exactly as it does for TaskMentor and Discipline & Attendance.
 */
router.post('/exchange', async (req: Request, res: Response) => {
  if (rateLimited(req.ip ?? 'unknown')) {
    return res.status(429).json(fail('Too many sign-in attempts. Please wait a minute and try again.'));
  }

  const parsed = ssoExchangeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail(parsed.error.issues[0]?.message ?? 'Authorization code is required'));
  }

  try {
    const { status, body } = await exchangeCode(parsed.data.code);

    if (status >= 400 || !body.success || !body.data) {
      return res.status(status >= 400 ? status : 400).json(
        fail(body.message ?? 'Token exchange failed. The code may have expired or already been used.')
      );
    }

    const { token: misToken, user: misUser, permissions = [] } = body.data;

    // Hydrate the full profile; a failure here degrades the login rather than
    // breaking it (SRS FR-AUTH-2). The access v2 snapshot is fetched alongside
    // (shadow/enforce only; short timeout, never fails the login) — it primes
    // the snapshot cache for this session's permission checks.
    const mode = accessMode();
    const earlyMisId = String(misUser.user_id ?? misUser.id ?? misUser.uuid ?? misUser.email ?? 'unknown');
    // Sign-in is a natural refresh point: drop a cached access snapshot if
    // MIS says this user's access changed since it was fetched.
    const signInVersion = (body.data as { access_version?: unknown }).access_version;
    if (typeof signInVersion === 'number') noteAccessVersion(earlyMisId, signInVersion);
    const [me, snapResult] = await Promise.all([
      fetchMe(misToken),
      mode === 'off'
        ? Promise.resolve(null)
        : getAccessSnapshot({ misUserId: earlyMisId, misToken }).catch(() => null),
    ]);
    const snapshot = snapResult?.snapshot ?? null;
    const profile = (me?.profile ?? {}) as Record<string, unknown>;
    const effectivePermissions = (me?.permissions as string[] | undefined) ?? permissions;

    const misUserId = String(
      misUser.user_id ?? misUser.id ?? misUser.uuid ?? misUser.email ?? 'unknown'
    );
    const name = String(profile.name ?? misUser.name ?? misUser.username ?? 'Tupo User');
    const email = String(profile.email ?? misUser.email ?? '');
    // The central NGA MIS picture: the live /users/me read wins over the exchange
    // payload; null (MIS has none) clears ours.
    const fromMe = misAvatarUrl(me);
    const avatarUrl = fromMe !== undefined ? fromMe : misAvatarUrl(body.data);
    const coverFromMe = misCoverUrl(me);
    const coverUrl = coverFromMe !== undefined ? coverFromMe : misCoverUrl(body.data);

    // Appearance follows the MIS. The hydrated `/users/me` copy is preferred
    // over the one baked into the exchange payload because it is read live,
    // so a theme the user changed in the MIS (or in a sibling app) since their
    // last visit is already correct on the first paint here.
    const rawTheme = (me?.user as Record<string, unknown> | undefined)?.preferred_theme
      ?? misUser.preferred_theme;
    const preferredTheme =
      rawTheme === 'light' || rawTheme === 'dark' ? (rawTheme as 'light' | 'dark') : undefined;

    const forceAdmin =
      config.adminUsernames.includes(String(misUser.username ?? name).toLowerCase()) ||
      config.adminEmails.includes(email.toLowerCase());

    // Placement cache (users.mis_*): derived from the v2 snapshot when v2 is
    // enforcing and MIS supplied one; otherwise from /users/me as before. In
    // shadow the /users/me placement still wins and a difference is recorded.
    const legacyAcademic = readAcademic(me, forceAdmin);
    const snapAcademic = snapshot ? academicFromSnapshot(snapshot, legacyAcademic, forceAdmin) : null;
    const academic = mode === 'enforce' && snapAcademic ? snapAcademic : legacyAcademic;

    const user = await upsertMisUser({
      misUserId, name, email, avatarUrl,
      derivedRole: resolveMisRole(misUser, effectivePermissions),
      preferredTheme,
      forceAdmin,
      academic,
    });

    if (coverUrl !== undefined) {
      await setUserCover(user.id, coverUrl).catch((err) => console.error('[sso] cover sync failed:', err));
    }

    if (snapshot) {
      // Contact-policy inputs (new columns only; nothing legacy reads them).
      await syncAccessProfile(user.id, snapshot);
      if (mode === 'shadow' && snapAcademic && placementDiffers(legacyAcademic, snapAcademic)) {
        void recordShadowDiff({
          userId: user.id, misUserId,
          capability: 'PLACEMENT', route: 'sso:placement',
          legacyAllowed: true, v2: { allowed: false, depth: null },
          target: {
            legacy: { level: legacyAcademic.level, programs: legacyAcademic.leadProgramIds, grades: legacyAcademic.gradeIds, classGroups: legacyAcademic.classGroupIds },
            v2: { level: snapAcademic.level, programs: snapAcademic.leadProgramIds, grades: snapAcademic.gradeIds, classGroups: snapAcademic.classGroupIds },
          },
        });
      }
    }

    // Tupo's own session, with the MIS token nested inside so this app can act
    // on the user's behalf against MIS APIs. Note for ops: this makes the
    // Authorization header large — see the nginx buffer settings in infra/.
    const claims: SessionClaims = { ...user, misToken };
    const token = jwt.sign(claims, config.jwtSecret, { expiresIn: config.sessionTtl } as jwt.SignOptions);

    // Tupo's OWN permission set for this user — distinct from the MIS
    // permission strings passed through alongside it. The frontend gates UI on
    // `rolePermissions`; the MIS `permissions` array is informational only.
    const resolved = await resolveUserPermissions(getPool(), user.id);

    await audit({
      actorId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id,
      metadata: { role: user.role, roleName: resolved?.roleName ?? null, via: 'mis_sso' },
      ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });

    return res.json(ok({
      token,
      user,
      permissions: effectivePermissions,
      rolePermissions: Array.from(resolved?.permissions ?? []).sort(),
      roleName: resolved?.roleName ?? null,
      roleLevel: resolved?.roleLevel ?? null,
    }));
  } catch (err) {
    console.error('[sso] exchange error:', err);
    return res.status(502).json(fail('Could not reach the NGA MIS authentication server. Please try again.'));
  }
});

/**
 * Polled by the client every few minutes so that logging out of the MIS — or
 * an administrator disabling the account there — ends this session too.
 * Fails CLOSED: a MIS rejection kills the local session.
 */
/**
 * POST /api/sso/backchannel-logout -- OpenID Connect Back-Channel Logout.
 * NGA MIS calls this (server to server) when a user signs out there; we end
 * that user's Tupo sessions and drop their open sockets
 * (nga_central_mis/docs/SINGLE_SIGN_OUT.md).
 */
router.post('/backchannel-logout', express.urlencoded({ extended: false, limit: '20kb' }), async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    const misUserId = await verifyLogoutToken((req.body || {}).logout_token, {
      misBaseUrl: config.misBaseUrl,
      clientId: config.ssoClientId,
    });
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO session_revocations (user_id, revoked_at)
         SELECT id, now() FROM users WHERE mis_user_id = $1
       ON CONFLICT (user_id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at
       RETURNING user_id AS id`,
      [String(misUserId)],
    );
    publishSessionEnd(rows.map((r) => r.id));
    return res.status(200).json({ success: true });
  } catch (error) {
    if (error instanceof LogoutTokenError) {
      return res.status(400).json({ error: 'invalid_request', error_description: error.message });
    }
    return res.status(500).json({ error: 'server_error' });
  }
});

router.get('/verify-mis', authMiddleware, async (req: Request, res: Response) => {
  const misToken = (req as AuthenticatedRequest).user?.misToken;
  if (!misToken) return res.status(401).json(fail('No MIS session on this token.'));

  const { state, accessVersion, avatarUrl, coverUrl } = await verifyMisSessionDetailed(misToken);
  if (state === 'invalid') return res.status(401).json(fail('Your MIS session has ended.'));
  // Access control v2: a new access_version means the user's grants changed —
  // drop the cached snapshot so the next check re-fetches it.
  const misUserId = (req as AuthenticatedRequest).user?.misUserId;
  if (misUserId && accessVersion !== null) noteAccessVersion(misUserId, accessVersion);
  // 'unreachable' is a network blip, not a logout — don't sign everyone out
  // over it; the next poll settles the question.
  // The poll carries the current NGA profile picture: store it, and hand it to the
  // browser so the shell follows a change made in MIS within a minute.
  if (state === 'valid' && coverUrl !== undefined) {
    await setUserCover((req as AuthenticatedRequest).user!.id, coverUrl)
      .catch((err) => console.error('[sso] cover sync failed:', err));
  }
  if (state === 'valid' && avatarUrl !== undefined) {
    const userId = (req as AuthenticatedRequest).user!.id;
    await setUserAvatar(userId, avatarUrl).catch((err) => console.error('[sso] avatar sync failed:', err));
    return res.json(ok({ valid: true, degraded: false, avatarUrl }));
  }
  return res.json(ok({ valid: true, degraded: state === 'unreachable' }));
});

/**
 * Feeds the cross-app "waffle" switcher. Fails OPEN (empty list) — a brief MIS
 * outage should not break the navbar of an otherwise working app.
 */
router.get('/systems', authMiddleware, async (req: Request, res: Response) => {
  const misToken = (req as AuthenticatedRequest).user?.misToken;
  if (!misToken) return res.json(ok({ systems: [] }));

  const me = await fetchMe(misToken);
  return res.json(ok({ systems: (me?.systems as unknown[]) ?? [] }));
});

/**
 * Proxies an SSO authorization request to the MIS on behalf of the signed-in
 * user, so hopping to a sibling app doesn't ask them to log in again.
 */
router.get('/authorize', authMiddleware, async (req: Request, res: Response) => {
  const misToken = (req as AuthenticatedRequest).user?.misToken;
  if (!misToken) return res.status(401).json(fail('MIS session expired'));

  try {
    const url = new URL(`${config.misBaseUrl}/sso/authorize`);
    for (const key of ['client_id', 'redirect_uri', 'response_type', 'state'] as const) {
      const value = req.query[key];
      if (value) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, { headers: { Authorization: `Bearer ${misToken}` } });
    return res.status(response.status).json(await response.json());
  } catch (err) {
    console.error('[sso] authorize proxy error:', err);
    return res.status(502).json(fail('Could not reach the MIS authorization server.'));
  }
});

/** The signed-in user, re-read from the database. */
router.get('/me', authMiddleware, (req: Request, res: Response) => {
  const user = (req as AuthenticatedRequest).user!;
  // `access` (v2 request state) is internal and never serialised. The UI keeps
  // gating on the local RBAC set until it moves to useAccess(); in enforce
  // mode that is `access.legacyPermissions`.
  const { misToken: _misToken, permissions, access, ...safe } = user;
  return res.json(ok({
    user: safe,
    rolePermissions: Array.from(access?.legacyPermissions ?? permissions).sort(),
  }));
});

export default router;
