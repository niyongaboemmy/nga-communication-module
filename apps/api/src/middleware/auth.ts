import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getPool, resolveUserPermissions } from '@tupo/db';
import { fail } from '@tupo/shared';
import type { Role, RoleLevel, SessionClaims } from '@tupo/shared';
import { config } from '../config.js';

export interface AuthenticatedRequest extends Request {
  user?: SessionClaims & {
    role: Role;
    /** RBAC fields, resolved fresh from the database on every request — never
     *  read from the token. A role change therefore takes effect on the very
     *  next request instead of at the user's next login. */
    roleId: number | null;
    roleName: string | null;
    roleLevel: RoleLevel | null;
    permissions: Set<string>;
  };
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json(fail('Access denied. No authorization token provided.'));
  }

  let decoded: SessionClaims;
  try {
    decoded = jwt.verify(header.slice(7), config.jwtSecret) as SessionClaims;
  } catch {
    return res.status(401).json(fail('Invalid or expired authorization token.'));
  }

  const pool = getPool();
  const { rows } = await pool.query<{ role: Role; status: string }>(
    'SELECT role, status FROM users WHERE id = $1',
    [decoded.id]
  );
  const user = rows[0];

  // A cryptographically valid token whose subject no longer exists is a dead
  // session, not a permissions problem — 401 tells the client to clear it and
  // start over, whereas 403 would strand them on every route with no way out.
  if (!user) {
    return res.status(401).json(fail('Your session is no longer valid. Please sign in again.'));
  }
  if (user.status !== 'active') {
    return res.status(403).json(fail('This account has been suspended.'));
  }

  const resolved = await resolveUserPermissions(pool, decoded.id);

  (req as AuthenticatedRequest).user = {
    ...decoded,
    role: user.role,
    roleId: resolved?.roleId ?? null,
    roleName: resolved?.roleName ?? null,
    roleLevel: (resolved?.roleLevel ?? null) as RoleLevel | null,
    permissions: resolved?.permissions ?? new Set<string>(),
  };
  next();
}
