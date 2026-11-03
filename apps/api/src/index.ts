import { pingDb, closeDb } from '@tupo/db';
import { config } from './config.js';
import { app } from './app.js';
import { installProcessGuards } from './utils/asyncErrors.js';
import { startMeetSweep } from './services/meetLifecycle.js';
import { activity } from './activity/relay.js';
import { startApiMetrics, stopApiMetrics } from './services/observability.js';
import activityCatalog from './activity/catalog.json' with { type: 'json' };

installProcessGuards('api');

/**
 * Which pm2 instance this is (R-01). The API runs as a pm2 cluster so a deploy
 * replaces one process at a time and nobody sees it; work that must happen
 * once per deployment rather than once per process runs on instance 0 only.
 * Outside pm2 (dev, tests) there is one process and it is instance 0.
 */
const isPrimaryInstance = (process.env.NODE_APP_INSTANCE ?? '0') === '0';

async function start(): Promise<void> {
  startApiMetrics();
  try {
    await pingDb();
    console.log('[api] database connection ok');
  } catch (err) {
    console.error('[api] cannot reach the database:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const server = app.listen(config.port, () => {
    console.log(`🚀 tupo-api listening on http://localhost:${config.port}  (env: ${config.env})`);
    console.log(`   MIS: ${config.misBaseUrl}  ·  client_id: ${config.ssoClientId}`);
    // Publish the feature catalog (route patterns → named features) so the MIS
    // usage console can label Tupo's pages. Non-fatal: it only logs.
    if (isPrimaryInstance && activity().enabled) void activity().pushCatalog(activityCatalog);
    // Abandoned meetings close themselves (MEET-RT2).
    if (isPrimaryInstance && process.env.MEET_SWEEP !== 'off') startMeetSweep();
    // pm2 (wait_ready) starts sending traffic here, and only then stops the
    // old process: the reload never has zero instances listening.
    process.send?.('ready');
  });
  // Longer than nginx's upstream keep-alive (60 s), so nginx always closes an
  // idle connection first and never reuses one this process just dropped (502).
  server.keepAliveTimeout = 65_000;

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[api] port ${config.port} is already in use. Stop whatever is on it, or set PORT in apps/api/.env`);
      process.exit(1);
    }
    throw err;
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[api] ${signal} received — draining connections`);
    // In-flight requests finish; idle keep-alive sockets close now. Anything
    // still running after 10 s is cut (pm2's kill_timeout is 12 s).
    setTimeout(() => { console.warn('[api] drain timed out — exiting'); process.exit(0); }, 10_000).unref();
    server.closeIdleConnections();
    server.close(async () => {
      // Forward whatever analytics is still queued; bounded by the relay's own timeout.
      await activity().stop().catch(() => {});
      await stopApiMetrics();
      await closeDb();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void start();
