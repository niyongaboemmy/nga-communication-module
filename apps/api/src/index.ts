import { pingDb, closeDb } from '@tupo/db';
import { config } from './config.js';
import { app } from './app.js';
import { activity } from './activity/relay.js';
import activityCatalog from './activity/catalog.json' with { type: 'json' };

async function start(): Promise<void> {
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
    if (activity().enabled) void activity().pushCatalog(activityCatalog);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[api] port ${config.port} is already in use. Stop whatever is on it, or set PORT in apps/api/.env`);
      process.exit(1);
    }
    throw err;
  });

const shutdown = async (signal: string) => {
    console.log(`\n[api] ${signal} received — draining connections`);
    server.close(async () => {
      // Forward whatever analytics is still queued; bounded by the relay's own timeout.
      await activity().stop().catch(() => {});
      await closeDb();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void start();
