import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getPool, resolveUserPermissions, snowflake } from '@tupo/db';
import { fail, GUEST_PERMISSIONS } from '@tupo/shared';
import type { Role, RoleLevel, SessionClaims } from '@tupo/shared';
import { config } from '../config.js';
import type { AuthenticatedRequest } from './auth.js';

/**
 * Authentication for the Meet router, which — uniquely in Tupo — has to serve
 * two kinds of caller.
 *
 * The first is an ordinary MIS-authenticated user, handled exactly as
 * `authMiddleware` handles them: permissions re-resolved from the database on
 * every request, never read from the token.
 *
 * The second is a **guest in a public meeting**: someone with no NGA account at
 * all, who typed a name and was let into one specific meeting. This does not
 * weaken the "Tupo has no login of its own" rule, and it is worth being precise
 * about why:
 *
 *   - A guest token is not an identity. It authenticates *a participant row in
 *     one meeting*, not a person, and it grants nothing outside that meeting.
 *   - No `users` row is created, so a guest cannot appear in the directory, be
 *     added to a channel, or hold a role.
 *   - It carries exactly one permission, MEET_JOIN, and expires with the
 *     meeting.
 *   - It can only be minted for a meeting whose host set `admissionPolicy` to
 *     `public`, and the guest still lands in the lobby.
 *
 * So it is a ticket, not an account — the same distinction a cinema makes.
 */

export interface GuestClaims {
  guest: true;
  /** The participant row this ticket is bound to. */
  participantId: string;
  meetingId: string;
  name: string;
}

export interface MeetRequest extends AuthenticatedRequest {
  /** Set instead of `user` when the caller is an anonymous guest. */
  guest?: GuestClaims;
}

const GUEST_TTL = '12h';

/** Mint a ticket bound to one participant row in one meeting. */
export function issueGuestToken(claims: {
  participantId: string; meetingId: string; name: string; tokenId: string;
}): string {
  return jwt.sign(
    {
      guest: true,
      participantId: claims.participantId,
      meetingId: claims.meetingId,
      name: claims.name,
      jti: claims.tokenId,
    },
    config.jwtSecret,
    { expiresIn: GUEST_TTL },
  );
}

export const newGuestTokenId = (): string => `g_${snowflake()}`;

/**
 * Accepts a full session or a guest ticket.
 *
 * A guest is given a synthetic `user` so every downstream handler — and, more
 * importantly, every `authorizePermission` guard — keeps working unchanged.
 * The synthetic id is namespaced `guest:` so it can never collide with a
 * snowflake user id, and `roleId` is null so nothing treats it as a real role.
 */
export async function meetAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json(fail('Access denied. No authorization token provided.'));
  }

  let decoded: (SessionClaims & Partial<GuestClaims>) | GuestClaims;
  try {
    decoded = jwt.verify(header.slice(7), config.jwtSecret) as never;
  } catch {
    return res.status(401).json(fail('Invalid or expired authorization token.'));
  }

  /* ---- guest ticket ---- */
  if ((decoded as GuestClaims).guest === true) {
    const claims = decoded as GuestClaims;

    // The ticket is only as good as the row it points at. If the participant
    // was removed, or the meeting ended and was cleaned up, the ticket is dead.
    const { rows } = await getPool().query<{ state: string; display_name: string }>(
      `SELECT state, display_name FROM meeting_participants
        WHERE id = $1 AND meeting_id = $2 AND is_guest = true`,
      [claims.participantId, claims.meetingId],
    );
    const participant = rows[0];
    if (!participant) {
      return res.status(401).json(fail('This guest link is no longer valid.'));
    }
    if (participant.state === 'removed' || participant.state === 'denied') {
      return res.status(403).json(fail('You are no longer in this meeting.'));
    }

    const request = req as MeetRequest;
    request.guest = claims;
    request.user = {
      id: `guest:${claims.participantId}`,
      misUserId: `guest:${claims.participantId}`,
      name: participant.display_name || claims.name,
      email: '',
      role: 'unassigned' as Role,
      roleId: null,
      roleName: 'Guest',
      roleLevel: null as RoleLevel | null,
      permissions: new Set<string>(GUEST_PERMISSIONS),
    };
    return next();
  }

  /* ---- ordinary session ---- */
  const claims = decoded as SessionClaims;
  const pool = getPool();
  const { rows } = await pool.query<{ role: Role; status: string }>(
    'SELECT role, status FROM users WHERE id = $1', [claims.id],
  );
  const user = rows[0];

  if (!user) {
    return res.status(401).json(fail('Your session is no longer valid. Please sign in again.'));
  }
  if (user.status !== 'active') {
    return res.status(403).json(fail('This account has been suspended.'));
  }

  const resolved = await resolveUserPermissions(pool, claims.id);
  (req as MeetRequest).user = {
    ...claims,
    role: user.role,
    roleId: resolved?.roleId ?? null,
    roleName: resolved?.roleName ?? null,
    roleLevel: (resolved?.roleLevel ?? null) as RoleLevel | null,
    permissions: resolved?.permissions ?? new Set<string>(),
  };
  next();
}

/** True when this request is a guest ticket rather than a real session. */
export const isGuestRequest = (req: Request): boolean => !!(req as MeetRequest).guest;

/** Refuse a route to guests outright, whatever permissions the shim reports. */
export function denyGuests(req: Request, res: Response, next: NextFunction) {
  if (isGuestRequest(req)) {
    return res.status(403).json(fail('Guests cannot do that in this meeting.'));
  }
  next();
}
