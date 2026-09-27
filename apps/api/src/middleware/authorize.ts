import type { Response, NextFunction } from 'express';
import { fail } from '@tupo/shared';
import type { AuthenticatedRequest } from './auth.js';
import { accessUnavailable, shadowCompareHeld } from '../access/gate.js';

function deny(res: Response, message = 'Forbidden. You do not have permission to perform this action.') {
  return res.status(403).json(fail(message));
}

/**
 * Enforce mode with no snapshot at all (MIS unreachable past the 24 h
 * last-good window): say so, rather than a misleading "no permission".
 */
function denyOrUnavailable(req: AuthenticatedRequest, res: Response, message?: string) {
  if (accessUnavailable(req.user)) {
    return res.status(503).json(fail('Access check unavailable. Please try again shortly.'));
  }
  return deny(res, message);
}

/**
 * Authorization is enforced HERE, server-side, on every protected route.
 * The frontend's `usePermissions()` only decides what to render — it is UX,
 * never the security boundary.
 *
 * Access control v2 (ACCESS_V2_MODE, see access/mode.ts): `user.permissions`
 * is the local RBAC set in off/shadow and the v2 "held anywhere" set in
 * enforce (swapped in by authMiddleware). In shadow the v2 answer is computed
 * after the response is decided and only disagreements are recorded.
 */

/** Allow the request if the user holds ANY of the given permission keys. */
export function authorizePermission(...keys: string[]) {
  return (req: unknown, res: Response, next: NextFunction) => {
    const request = req as AuthenticatedRequest;
    const user = request.user;
    if (!user) return res.status(401).json(fail('Unauthorized. Please sign in.'));
    const allowed = keys.some((k) => user.permissions.has(k));
    shadowCompareHeld(req, keys, 'any', allowed);
    if (allowed) return next();
    return denyOrUnavailable(request, res);
  };
}

/** Allow the request only if the user holds ALL of the given permission keys. */
export function authorizeAllPermissions(...keys: string[]) {
  return (req: unknown, res: Response, next: NextFunction) => {
    const request = req as AuthenticatedRequest;
    const user = request.user;
    if (!user) return res.status(401).json(fail('Unauthorized. Please sign in.'));
    const allowed = keys.every((k) => user.permissions.has(k));
    shadowCompareHeld(req, keys, 'all', allowed);
    if (allowed) return next();
    return denyOrUnavailable(request, res);
  };
}

/** The "view own vs. view any" pattern for /:userId-style routes. */
export function selfOrPermission(idParam: string, ...keysForOthers: string[]) {
  return (req: unknown, res: Response, next: NextFunction) => {
    const request = req as AuthenticatedRequest;
    const user = request.user;
    if (!user) return res.status(401).json(fail('Unauthorized. Please sign in.'));
    if (request.params[idParam] === user.id) return next();
    const allowed = keysForOthers.some((k) => user.permissions.has(k));
    shadowCompareHeld(req, keysForOthers, 'any', allowed);
    if (allowed) return next();
    return denyOrUnavailable(request, res, 'Forbidden. You can only access your own records.');
  };
}
