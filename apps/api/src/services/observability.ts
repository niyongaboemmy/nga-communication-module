import type { NextFunction, Request, Response } from 'express';
import { startProcessMetrics, type ProcessMetrics } from '@tupo/db';

/**
 * The API's own numbers (R-04): requests, 4xx/5xx and latency per minute,
 * written by each pm2 instance as `api#<n>`. Started by index.ts only, so the
 * test suite — which imports `app` without starting a server — writes nothing.
 */
let metrics: ProcessMetrics | null = null;

export function startApiMetrics(): ProcessMetrics {
  metrics ??= startProcessMetrics(`api#${process.env.NODE_APP_INSTANCE ?? '0'}`);
  return metrics;
}

export async function stopApiMetrics(): Promise<void> {
  await metrics?.stop().catch(() => {});
  metrics = null;
}

/** Counts and times every request once it has been answered. */
export function requestMetrics(req: Request, res: Response, next: NextFunction): void {
  if (!metrics) return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const m = metrics;
    if (!m) return;
    m.count('http_requests');
    if (res.statusCode >= 500) m.count('http_5xx');
    else if (res.statusCode >= 400) m.count('http_4xx');
    if (res.statusCode === 429) m.count('http_429');
    // Health probes are fast and frequent; they would flatter the latency.
    if (!req.path.endsWith('/health')) m.time('http', Number(process.hrtime.bigint() - started) / 1e6);
  });
  next();
}
