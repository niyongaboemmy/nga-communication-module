import { Router, type Request, type Response } from 'express';
import { getPool, recordError } from '@tupo/db';
import { ok, fail } from '@tupo/shared';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { effectiveTenant, runAsPlatform } from '@tupo/tenancy';

/**
 * Monitoring for the System page (R-04, R-05).
 *
 *   POST  /api/system/client-errors     any signed-in person's browser reports a crash
 *   GET   /api/system/metrics           per-minute series for the charts
 *   GET   /api/system/errors            grouped errors, newest first
 *   PATCH /api/system/errors/:fp        resolve or ignore one
 *   GET   /api/system/alerts            alert rules and whether they are firing
 *
 * Tenancy (security review, migration 0047): SYSTEM_HEALTH_VIEW is in every
 * school's default Admin role, so what a school sees must be its own.
 *  - Errors carry tenant_id (RLS): a school's admin sees and triages only the
 *    errors its own requests and jobs raised.
 *  - Process-level errors (tenant_id NULL), host/process metrics and alert
 *    state describe the shared servers. They are for the primary tenant (the
 *    platform operator, NGA) only; other schools get empty answers, so their
 *    System page still loads.
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

/** The primary tenant runs the shared servers; only it sees process-level data. */
function isPlatformOperator(): boolean {
  return effectiveTenant('system health').isPrimary === true;
}

/**
 * Series for the charts. API numbers are summed across instances (requests,
 * errors) or taken as the worst instance (latency, lag); the rest are per service.
 */
router.get('/metrics', VIEW, async (req: Request, res: Response) => {
  const minutes = Math.min(Math.max(Number(req.query.minutes) || 60, 5), 24 * 60);
  // Host and process numbers span every school: primary tenant only.
  if (!isPlatformOperator()) return res.json(ok({ minutes, series: {}, platformOnly: true }));
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

/**
 * Run an error_events statement for the caller: a school sees its own rows
 * (RLS on its tenant, plus the explicit filter as a second lock); the primary
 * tenant additionally sees the process-level rows, read as the platform with
 * a filter that never reaches another school's rows.
 * `$1` in `where` is the caller's tid.
 */
async function errorsQuery(sql: (where: string) => string, params: unknown[]) {
  const tenant = effectiveTenant('system errors');
  if (tenant.isPrimary) {
    return runAsPlatform('system errors (primary tenant)', () =>
      getPool().query(sql('(tenant_id = $1 OR tenant_id IS NULL)'), [tenant.tid, ...params]));
  }
  return getPool().query(sql('tenant_id = $1'), [tenant.tid, ...params]);
}

router.get('/errors', VIEW, async (req: Request, res: Response) => {
  const status = ['open', 'resolved', 'ignored', 'all'].includes(String(req.query.status)) ? String(req.query.status) : 'open';
  const { rows } = await errorsQuery((where) =>
    `SELECT fingerprint, source, message, stack, route, release, count, first_at, last_at, last_user_agent, status,
            CASE WHEN tenant_id IS NULL THEN 'process' ELSE 'tenant' END AS scope
       FROM error_events
      WHERE ${where} AND ($2 = 'all' OR status = $2)
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
  const { rowCount } = await errorsQuery((where) =>
    `UPDATE error_events SET status = $3 WHERE ${where} AND fingerprint = $2`, [req.params.fingerprint, status]);
  if (!rowCount) return res.status(404).json(fail('No such error.'));
  return res.json(ok({ status }));
});

router.get('/alerts', VIEW, async (_req: Request, res: Response) => {
  // Alert rules watch the shared servers: primary tenant only.
  if (!isPlatformOperator()) return res.json(ok({ alerts: [], platformOnly: true }));
  const { rows } = await getPool().query(
    'SELECT rule, firing, since, last_notified_at, detail, updated_at FROM alert_state ORDER BY firing DESC, rule');
  return res.json(ok({ alerts: rows }));
});

export default router;
