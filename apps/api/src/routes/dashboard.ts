import { Router, type Request, type Response, type NextFunction } from 'express';
import { ok, fail } from '@tupo/shared';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import {
  resolveScope, overview, onlineRoster, type ScopeFilter,
} from '../services/dashboardService.js';

/**
 * The realtime admin dashboard.
 *
 * `DASHBOARD_VIEW` gets you in; what you then *see* is decided entirely by
 * `dashboardService.resolveScope` from your MIS placement. A Tupo admin / MIS
 * super admin sees the whole institution and may filter by any programme or
 * grade; a programme lead is pinned to their programmes, a class teacher to
 * their class groups, and anyone else to their own row.
 *
 * There is no websocket here — the page polls `/overview` on a short interval
 * and folds in the `presence:update` events it already receives on the shared
 * socket for between-poll liveness. A poll is a single round trip against
 * indexed aggregates; a bespoke dashboard room would be more moving parts for
 * the same refresh rate.
 */
const router = Router();
router.use(authMiddleware);

const actor = (req: Request) => (req as AuthenticatedRequest).user!;

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try { await fn(req, res); } catch (err) { next(err); }
  };

const filterOf = (req: Request): ScopeFilter => ({
  programId: typeof req.query.program === 'string' ? req.query.program : undefined,
  gradeId: typeof req.query.grade === 'string' ? req.query.grade : undefined,
  classGroupId: typeof req.query.classGroup === 'string' ? req.query.classGroup : undefined,
});

const WINDOWS = new Set(['1h', '24h', '7d', '30d']);

/** What the viewer may filter by, and which admin tier they are. */
router.get('/scope', authorizePermission('DASHBOARD_VIEW'), wrap(async (req, res) => {
  res.json(ok({ scope: await resolveScope(actor(req)) }));
}));

/** The whole dashboard in one payload — the poll target. */
router.get('/overview', authorizePermission('DASHBOARD_VIEW'), wrap(async (req, res) => {
  const windowKey = typeof req.query.window === 'string' && WINDOWS.has(req.query.window)
    ? req.query.window : '24h';
  res.json(ok(await overview(actor(req), filterOf(req), windowKey)));
}));

/** Who is online right now, in scope — the live roster panel. */
router.get('/online', authorizePermission('DASHBOARD_VIEW'), wrap(async (req, res) => {
  res.json(ok(await onlineRoster(actor(req), filterOf(req))));
}));

router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[dashboard] error:', err);
  res.status(500).json(fail('The dashboard could not be assembled.'));
});

export default router;
