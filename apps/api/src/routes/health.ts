import { Router, type Request, type Response } from 'express';
import { pingDb } from '@tupo/db';

const router = Router();

/**
 * Liveness + dependency check. The load balancer uses the status code; the
 * body is for humans and for the web app's /system page.
 */
router.get('/health', async (_req: Request, res: Response) => {
  const checks: Record<string, string> = {};
  let healthy = true;

  try {
    await pingDb();
    checks.database = 'ok';
  } catch (err) {
    checks.database = err instanceof Error ? `error: ${err.message}` : 'error';
    healthy = false;
  }

  res.status(healthy ? 200 : 503).json({
    service: 'tupo-api',
    status: healthy ? 'healthy' : 'degraded',
    checks,
    uptime: Math.round(process.uptime()),
    date: new Date().toISOString(),
  });
});

export default router;
