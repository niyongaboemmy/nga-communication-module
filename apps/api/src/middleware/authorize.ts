import type { Response, NextFunction } from 'express';
import { fail } from '@tupo/shared';
import type { AuthenticatedRequest } from './auth.js';

function deny(res: Response, message = 'Forbidden. You do not have permission to perform this action.') {
  return res.status(403).json(fail(message));
}

/**
 * Authorization is enforced HERE, server-side, on every protected route.
 * The frontend's `usePermissions()` only decides what to render — it is UX,
 * never the security boundary.
 */

/** Allow the request if the user holds ANY of the given permission keys. */
export function authorizePermission(...keys: string[]) {
  return (req: unknown, res: Response, next: NextFunction) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) return res.status(401).json(fail('Unauthorized. Please sign in.'));
    if (keys.some((k) => user.permissions.has(k))) return next();
    return deny(res);
  };
}

/** Allow the request only if the user holds ALL of the given permission keys. */
export function authorizeAllPermissions(...keys: string[]) {
  return (req: unknown, res: Response, next: NextFunction) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) return res.status(401).json(fail('Unauthorized. Please sign in.'));
    if (keys.every((k) => user.permissions.has(k))) return next();
    return deny(res);
  };
}

/** The "view own vs. view any" pattern for /:userId-style routes. */
export function selfOrPermission(idParam: string, ...keysForOthers: string[]) {
  return (req: unknown, res: Response, next: NextFunction) => {
    const request = req as AuthenticatedRequest;
    const user = request.user;
    if (!user) return res.status(401).json(fail('Unauthorized. Please sign in.'));
    if (request.params[idParam] === user.id) return next();
    if (keysForOthers.some((k) => user.permissions.has(k))) return next();
    return deny(res, 'Forbidden. You can only access your own records.');
  };
}
