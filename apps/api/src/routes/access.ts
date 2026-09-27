import { Router, type Request, type Response } from 'express';
import { ok, fail } from '@tupo/shared';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { accessMode } from '../access/mode.js';
import { getAccessSnapshot } from '../access/snapshot.js';

/**
 * Access control v2 — the signed-in user's MIS snapshot for Tupo
 * (packages/access/README.md §4). Informational in off/shadow; the web client
 * may read it through `useAccess()` but does not gate anything on it yet.
 *
 * 200 { mode, status, snapshot }   (status: fresh | cached | stale)
 * 503 when MIS has no snapshot for this user and none is cached.
 */
const router = Router();
router.use(authMiddleware);

router.get('/me', async (req: Request, res: Response) => {
  const user = (req as AuthenticatedRequest).user!;
  const { snapshot, status } = user.access?.snapshot
    ? { snapshot: user.access.snapshot, status: user.access.status }
    : await getAccessSnapshot({ misUserId: user.misUserId, misToken: user.misToken });
  if (!snapshot) {
    return res.status(503).json(fail('Your access profile is unavailable right now.'));
  }
  return res.json(ok({ mode: accessMode(), status, snapshot }));
});

export default router;
