import { Router, type Request, type Response } from 'express';
import { getPool, recordError } from '@tupo/db';
import { ok, fail } from '@tupo/shared';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';

/**
 * Monitoring for the System page (R-04, R-05).
 *
 *   POST  /api/system/client-errors     any signed-in person's browser reports a crash
 *   GET   /api/system/metrics           per-minute series for the charts
 *   GET   /api/system/errors            grouped errors, newest first
 *   PATCH /api/system/errors/:fp        resolve or ignore one
 *   GET   /api/system/alerts            alert rules and whether they are firing
 */
const router = Router();
router.use(authMiddleware);

const str = (v: unknown, max: number): string | null =>
  (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);

router.post('/client-errors', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message = str(body.message, 1000);
  if (!message) return res.status(400).json(fail('message is required.'));
  // Not awaited for the answer: the browser is reporting a crash and should not wait on us.
  void recordError({
    source: 'web',
    message,
    stack: str(body.stack, 4000),
    route: str(body.route, 300),
    release: str(body.release, 60),
    userId: (req as AuthenticatedRequest).user?.id ?? null,
    userAgent: str(req.headers['user-agent'], 300),
  });
  return res.status(202).json(ok({ recorded: true }));
});

const VIEW = authorizePermission('SYSTEM_HEALTH_VIEW');

/**
 * Series for the charts. API numbers are summed across instances (requests,
 * errors) or taken as the worst instance (latency, lag); the rest are per service.
 */
router.get('/metrics', VIEW, async (req: Request, res: Response) => {
  const minutes = Math.min(Math.max(Number(req.query.minutes) || 60, 5), 24 * 60);
  const { rows } = await getPool().query<{ minute: string; service: string; metric: string; value: number }>(
    `SELECT date_trunc('minute', at) AS minute,
            CASE WHEN service LIKE 'api#%' THEN 'api' ELSE service END AS service,
            metric,
            CASE WHEN metric IN ('http_requests', 'http_4xx', 'http_5xx', 'http_429') THEN sum(value)
                 ELSE max(value) END AS value
       FROM metric_samples
      WHERE at > now() - make_interval(mins => $1)
      GROUP BY 1, 2, 3
      ORDER BY 1`,
    [minutes],
  );
  const series: Record<string, Array<[string, number]>> = {};
  for (const r of rows) {
    const key = `${r.service}.${r.metric}`;
    (series[key] ??= []).push([new Date(r.minute).toISOString(), Number(r.value)]);
  }
  return res.json(ok({ minutes, series }));
});

router.get('/errors', VIEW, async (req: Request, res: Response) => {
  const status = ['open', 'resolved', 'ignored', 'all'].includes(String(req.query.status)) ? String(req.query.status) : 'open';
  const { rows } = await getPool().query(
    `SELECT fingerprint, source, message, stack, route, release, count, first_at, last_at, last_user_agent, status
       FROM error_events
      WHERE $1 = 'all' OR status = $1
      ORDER BY last_at DESC
      LIMIT 100`,
    [status],
  );
  return res.json(ok({ errors: rows }));
});

router.patch('/errors/:fingerprint', VIEW, async (req: Request, res: Response) => {
  const status = String((req.body ?? {}).status);
  if (!['open', 'resolved', 'ignored'].includes(status)) {
    return res.status(400).json(fail("status must be 'open', 'resolved' or 'ignored'."));
  }
  const { rowCount } = await getPool().query(
    'UPDATE error_events SET status = $2 WHERE fingerprint = $1', [req.params.fingerprint, status]);
  if (!rowCount) return res.status(404).json(fail('No such error.'));
  return res.json(ok({ status }));
});

router.get('/alerts', VIEW, async (_req: Request, res: Response) => {
  const { rows } = await getPool().query(
    'SELECT rule, firing, since, last_notified_at, detail, updated_at FROM alert_state ORDER BY firing DESC, rule');
  return res.json(ok({ alerts: rows }));
});

export default router;
