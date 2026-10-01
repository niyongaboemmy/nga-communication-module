import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getPool } from '@tupo/db';
import {
  createActivityRelay, type ActivityRelay, type RelayOptions,
} from '../vendor/nga-activity-relay/relay.js';
import { config } from '../config.js';
import { issuedBeforeRevocation } from '../utils/ssoLogout.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';

/**
 * Platform usage analytics: Tupo's half (USAGE_ANALYTICS_IMPLEMENTATION_PLAN.md §5.2).
 *
 * The browser posts its activity batches to `POST /api/activity` on this API;
 * the vendored relay stamps them with the MIS user id behind the Tupo session
 * (or null for a public visitor), the real client IP and the user agent, and
 * forwards them to the MIS every few seconds with Tupo's SSO client
 * credentials. Analytics must never be able to hurt the app: with any of the
 * MIS settings missing the relay is a no-op, and every route answers at once.
 *
 * One relay per process. The realtime gateway, a separate process, has its own
 * (apps/realtime/src/activity.ts) for chat messages sent over the socket.
 */

export interface ActivityEnv {
  misBaseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  /** Comma-separated SPA origins allowed to send anonymous (public-page) batches. */
  origins?: string;
}

/** tupo.amashuri.com in production, plus the Vite dev server. */
export const DEFAULT_ACTIVITY_ORIGINS = 'https://tupo.amashuri.com,http://localhost:5194,http://127.0.0.1:5194';

/** A MIS user id is a positive integer; anything else (a guest, a snowflake) is not one. */
export const toMisUserId = (value: unknown): number | null => {
  const s = String(value ?? '').trim();
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * The MIS user id behind this request's Tupo session, or null.
 *
 * Validates exactly what `authMiddleware` validates -- the JWT signature and
 * expiry, that the user still exists and is active, and that they have not
 * signed out of NGA since the token was issued (single sign-out) -- but never
 * rejects: a missing, invalid, suspended or revoked session is simply a public
 * visitor. A guest meeting ticket is a visitor too; it is not an account.
 */
export async function misUserIdFromSession(req: Request): Promise<number | null> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    const decoded = jwt.verify(header.slice(7), config.jwtSecret) as {
      id?: string; misUserId?: string; iat?: number; guest?: boolean;
    };
    if (decoded.guest === true || !decoded.id) return null;
    const { rows } = await getPool().query<{ status: string; mis_user_id: string | null; revoked_at: Date | null }>(
      `SELECT u.status, u.mis_user_id, r.revoked_at
         FROM users u LEFT JOIN session_revocations r ON r.user_id = u.id
        WHERE u.id = $1`,
      [decoded.id],
    );
    const user = rows[0];
    if (!user || user.status !== 'active') return null;
    if (issuedBeforeRevocation(decoded.iat, user.revoked_at)) return null;
    return toMisUserId(user.mis_user_id ?? decoded.misUserId);
  } catch {
    return null;
  }
}

export interface TupoActivity {
  /** False when the MIS settings are missing: every call below is then a no-op. */
  enabled: boolean;
  handler: (req: Request, res: Response) => unknown;
  configHandler: (req: Request, res: Response) => unknown;
  /** A server-side key event for an authenticated request (`req.user` set by authMiddleware). */
  trackFor: (req: Request, name: string, params?: Record<string, unknown>) => void;
  /** A server-side key event with an explicit (possibly null) MIS user id, e.g. a guest. */
  track: (misUserId: number | null, req: Request | null, name: string, params?: Record<string, unknown>) => void;
  pushCatalog: (catalog: { version?: string; features: unknown[] }) => Promise<boolean>;
  flush: () => Promise<void>;
  stop: () => Promise<void>;
  /** The underlying relay (tests inspect its queue). Null when disabled. */
  relay: ActivityRelay | null;
}

const disabled = (): TupoActivity => ({
  enabled: false,
  handler: (_req, res) => res.status(204).end(),
  configHandler: (_req, res) => res.status(200).json({ enabled: false, v: 1 }),
  trackFor: () => undefined,
  track: () => undefined,
  pushCatalog: async () => false,
  flush: async () => undefined,
  stop: async () => undefined,
  relay: null,
});

export function buildActivity(env: ActivityEnv, overrides: Partial<RelayOptions> = {}): TupoActivity {
  const misBaseUrl = env.misBaseUrl?.trim();
  const clientId = env.clientId?.trim();
  const clientSecret = env.clientSecret?.trim();
  if (!misBaseUrl || !clientId || !clientSecret) return disabled();

  const relay = createActivityRelay({
    app: 'tupo',
    misBaseUrl,
    clientId,
    clientSecret,
    origins: (env.origins?.trim() || DEFAULT_ACTIVITY_ORIGINS).split(',').map((o) => o.trim()).filter(Boolean),
    getUserId: misUserIdFromSession,
    ...overrides,
  });
  const track: TupoActivity['track'] = (misUserId, req, name, params) => {
    try {
      relay.track(misUserId, req ? relay.deviceIdOf(req) : null, name, params, req ? (req.ip ?? null) : null);
    } catch {
      /* analytics never breaks a request */
    }
  };
  return {
    enabled: true,
    handler: relay.handler,
    configHandler: relay.configHandler,
    track,
    trackFor: (req, name, params) =>
      track(toMisUserId((req as AuthenticatedRequest).user?.misUserId), req, name, params),
    pushCatalog: relay.pushCatalog,
    flush: relay.flush,
    stop: relay.stop,
    relay,
  };
}

/** Read from the environment directly, not from `config`: config falls back to
 *  placeholders (a dummy client secret) that must not switch the relay on. The
 *  test run never forwards anything, whatever a developer's .env says. */
export const activityEnvFromProcess = (): ActivityEnv => (config.env === 'test' ? {} : {
  misBaseUrl: process.env.NGA_MIS_BASE_URL,
  clientId: process.env.SSO_CLIENT_ID,
  clientSecret: process.env.SSO_CLIENT_SECRET,
  origins: process.env.ACTIVITY_ORIGINS,
});

let current: TupoActivity = buildActivity(activityEnvFromProcess());
if (!current.enabled && config.env !== 'test') {
  console.warn('[activity] NGA_MIS_BASE_URL / SSO_CLIENT_ID / SSO_CLIENT_SECRET not all set: usage analytics is off');
}

/** The process's relay. Routes call through this so tests can swap it. */
export const activity = (): TupoActivity => current;

/** Tests only: install another relay, returning the previous one. */
export const _setActivityForTests = (next: TupoActivity): TupoActivity => {
  const prev = current;
  current = next;
  return prev;
};
