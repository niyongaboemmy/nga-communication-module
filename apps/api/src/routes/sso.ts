import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { ok, fail, resolveMisRole, ssoExchangeSchema } from '@tupo/shared';
import type { SessionClaims } from '@tupo/shared';
import { getPool, resolveUserPermissions } from '@tupo/db';
import { config } from '../config.js';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { exchangeCode, fetchMe, verifyMisSession } from '../services/misClient.js';
import { upsertMisUser, audit } from '../services/userService.js';

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
    // breaking it (SRS FR-AUTH-2).
    const me = await fetchMe(misToken);
    const profile = (me?.profile ?? {}) as Record<string, unknown>;
    const effectivePermissions = (me?.permissions as string[] | undefined) ?? permissions;

    const misUserId = String(
      misUser.user_id ?? misUser.id ?? misUser.uuid ?? misUser.email ?? 'unknown'
    );
    const name = String(profile.name ?? misUser.name ?? misUser.username ?? 'Tupo User');
    const email = String(profile.email ?? misUser.email ?? '');
    const avatarUrl = (profile.avatar_url ?? misUser.avatar_url) as string | undefined;

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

    const user = await upsertMisUser({
      misUserId, name, email, avatarUrl,
      derivedRole: resolveMisRole(misUser, effectivePermissions),
      preferredTheme,
      forceAdmin,
    });

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
router.get('/verify-mis', authMiddleware, async (req: Request, res: Response) => {
  const misToken = (req as AuthenticatedRequest).user?.misToken;
  if (!misToken) return res.status(401).json(fail('No MIS session on this token.'));

  const state = await verifyMisSession(misToken);
  if (state === 'invalid') return res.status(401).json(fail('Your MIS session has ended.'));
  // 'unreachable' is a network blip, not a logout — don't sign everyone out
  // over it; the next poll settles the question.
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
  const { misToken: _misToken, permissions, ...safe } = user;
  return res.json(ok({
    user: safe,
    rolePermissions: Array.from(permissions).sort(),
  }));
});

export default router;
