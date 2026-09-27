import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { getPool, resolveUserPermissions } from '@tupo/db';
import { fail } from '@tupo/shared';
import type { Role, RoleLevel } from '@tupo/shared';
import { verifyMisToken } from '../services/misClient.js';
import { attachAccess } from '../access/gate.js';
import { noteAccessVersion } from '../access/snapshot.js';
import type { AuthenticatedRequest } from './auth.js';

/**
 * Authentication for `/api/integration/*` — server-to-server calls the MIS
 * makes on a user's behalf (the Home summary), carrying that user's OWN MIS
 * token rather than a Tupo session.
 *
 *   1. The token is verified against MIS `/auth/verify`, which names the user.
 *   2. The MIS user id is mapped to the local row by `users.mis_user_id` —
 *      the same key the SSO exchange writes. Nobody is ever created here: a
 *      person who has never signed in to Tupo has no row, and the route
 *      answers `provisioned: false`.
 *   3. `req.user` is built exactly as authMiddleware builds it (role and
 *      permissions resolved fresh, v2 access attached, the MIS token carried
 *      in `misToken`), so every existing check works unchanged.
 *
 * Verification is cached for a minute keyed by a hash of the token — the MIS
 * Home page fans out to several apps on every load. The token itself is never
 * stored or logged.
 */

export interface MisBearerRequest extends AuthenticatedRequest {
  /** The MIS user id the token belongs to, set even when there is no local user. */
  misUserId?: string;
}

const VERIFY_TTL_MS = 60_000;
const MAX_CACHED = 5_000;
/** Longer than any real MIS JWT. */
const MAX_TOKEN_LENGTH = 4096;
const verified = new Map<string, { misUserId: string; expiresAt: number }>();

/** Sliding-window limit per MIS user, like the SSO exchange limiter. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const calls = new Map<string, number[]>();

function rateLimited(misUserId: string): boolean {
  const now = Date.now();
  const recent = (calls.get(misUserId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  // Only the newest RATE_MAX + 1 matter to the verdict; keeping more would let
  // one client hammering past the limit grow the array without bound.
  calls.set(misUserId, recent.length > RATE_MAX + 1 ? recent.slice(-(RATE_MAX + 1)) : recent);
  if (calls.size > 10_000) {
    for (const [key, times] of calls) {
      if (times.every((t) => now - t >= RATE_WINDOW_MS)) calls.delete(key);
    }
  }
  return recent.length > RATE_MAX;
}

/** Exposed for tests so one case's cache and rate window don't leak into the next. */
export function __resetMisBearerAuth(): void {
  verified.clear();
  calls.clear();
}

/** Exposed for tests: the size of the internal tables, never their contents. */
export function __misBearerState() {
  return {
    cacheSize: verified.size,
    rateEntries: (misUserId: string) => calls.get(misUserId)?.length ?? 0,
  };
}

const invalid = (res: Response) =>
  res.status(401).json({ ...fail('The MIS session token is missing, invalid or expired.'), code: 'MIS_TOKEN_INVALID' });

async function misUserIdFor(token: string): Promise<string | 'invalid' | 'unreachable'> {
  const key = createHash('sha256').update(token).digest('hex');
  const hit = verified.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.misUserId;
  if (hit) verified.delete(key);

  const { state, userId, accessVersion } = await verifyMisToken(token);
  if (state !== 'valid' || !userId) return state === 'unreachable' ? 'unreachable' : 'invalid';

  // Map order is insertion order, so the first key is the oldest entry.
  if (verified.size >= MAX_CACHED) verified.delete(verified.keys().next().value!);
  verified.set(key, { misUserId: userId, expiresAt: Date.now() + VERIFY_TTL_MS });
  // Same as the /verify-mis poll: a new access_version drops the cached snapshot.
  if (accessVersion !== null) noteAccessVersion(userId, accessVersion);
  return userId;
}

export async function misBearerAuth(req: Request, res: Response, next: NextFunction) {
  // Same reading as TM and D&A: scheme in any case, surrounding spaces
  // ignored, and nothing longer than a real MIS JWT is sent to MIS at all.
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  const misToken = match?.[1] ?? '';
  if (!misToken || misToken.length > MAX_TOKEN_LENGTH) return invalid(res);

  try {
    const misUserId = await misUserIdFor(misToken);
    if (misUserId === 'invalid') return invalid(res);
    if (misUserId === 'unreachable') {
      return res.status(503).json({ ...fail('Could not reach the NGA MIS to verify this session.'), code: 'MIS_UNREACHABLE' });
    }
    if (rateLimited(misUserId)) {
      return res.status(429).json({ ...fail('Too many requests. Please wait a minute.'), code: 'RATE_LIMITED' });
    }

    const request = req as MisBearerRequest;
    request.misUserId = misUserId;

    const pool = getPool();
    const { rows } = await pool.query<{
      id: string; mis_user_id: string; name: string; email: string; role: Role; status: string;
      avatar_url: string | null; preferred_theme: 'light' | 'dark' | null;
    }>(
      `SELECT id, mis_user_id, name, email, role, status, avatar_url, preferred_theme
         FROM users WHERE mis_user_id = $1`,
      [misUserId],
    );
    const user = rows[0];
    // Never signed in to Tupo: no req.user, and the route says provisioned:false.
    if (!user) return next();
    if (user.status !== 'active') {
      return res.status(403).json({ ...fail('This account has been suspended.'), code: 'ACCOUNT_SUSPENDED' });
    }

    const resolved = await resolveUserPermissions(pool, user.id);
    const authed: NonNullable<AuthenticatedRequest['user']> = {
      id: user.id,
      misUserId: user.mis_user_id,
      name: user.name,
      email: user.email,
      role: user.role,
      avatarUrl: user.avatar_url ?? undefined,
      preferredTheme: user.preferred_theme ?? undefined,
      misToken,
      roleId: resolved?.roleId ?? null,
      roleName: resolved?.roleName ?? null,
      roleLevel: (resolved?.roleLevel ?? null) as RoleLevel | null,
      permissions: resolved?.permissions ?? new Set<string>(),
    };
    await attachAccess(authed);
    request.user = authed;
    next();
  } catch (err) {
    next(err);
  }
}
