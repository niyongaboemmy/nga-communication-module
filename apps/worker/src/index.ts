import 'dotenv/config';
import express from 'express';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { pingDb } from '@tupo/db';

const port = parseInt(process.env.PORT ?? '5193', 10);
// Queues live in Redis db 1, away from the realtime gateway's pub/sub in db 0,
// so a `FLUSHDB` while debugging one cannot destroy the other.
const redisUrl = process.env.REDIS_QUEUE_URL ?? 'redis://127.0.0.1:6379/1';

const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

// BullMQ reserves ':' as its internal Redis key separator and rejects it in names.
export const QUEUE_NAME = 'tupo-jobs';
export const queue = new Queue(QUEUE_NAME, { connection });

let processed = 0;
let lastJobAt: string | null = null;

/**
 * Phase 0 registers a single `heartbeat` job. It exists to prove the whole
 * Redis → BullMQ → worker path is wired correctly before any real job depends
 * on it — the message fan-out, notification, scanning, thumbnail and retention
 * processors from the SRS all land on this same rail in later phases.
 */
const worker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    switch (job.name) {
      case 'heartbeat':
        processed++;
        lastJobAt = new Date().toISOString();
        return { ok: true, at: lastJobAt, echo: job.data };
      default:
        // Fail loudly rather than silently dropping work we don't recognise.
        throw new Error(`Unknown job type: ${job.name}`);
    }
  },
  { connection, concurrency: 5 }
);

worker.on('failed', (job, err) => console.error(`[worker] job ${job?.id} (${job?.name}) failed:`, err.message));
worker.on('ready', () => console.log('[worker] connected to redis, waiting for jobs'));

const app = express();

app.get('/health', async (_req, res) => {
  const checks: Record<string, string> = {};
  let healthy = true;

  try { await connection.ping(); checks.redis = 'ok'; }
  catch (err) { checks.redis = err instanceof Error ? `error: ${err.message}` : 'error'; healthy = false; }

  try { await pingDb(); checks.database = 'ok'; }
  catch (err) { checks.database = err instanceof Error ? `error: ${err.message}` : 'error'; healthy = false; }

  try { checks.queueDepth = String(await queue.getWaitingCount()); }
  catch { checks.queueDepth = 'unknown'; }

  res.status(healthy ? 200 : 503).json({
    service: 'tupo-worker',
    status: healthy ? 'healthy' : 'degraded',
    checks,
    processed,
    lastJobAt,
    uptime: Math.round(process.uptime()),
    date: new Date().toISOString(),
  });
});

/** Dev-only: enqueue a heartbeat so the Redis wiring can be verified by curl. */
app.post('/dev/heartbeat', async (_req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ success: false });
  const job = await queue.add('heartbeat', { at: new Date().toISOString() });
  res.json({ success: true, data: { jobId: job.id } });
});

const server = app.listen(port, () => {
  console.log(`⚙️  tupo-worker listening on http://localhost:${port}  (queue: ${QUEUE_NAME})`);
});

const shutdown = async () => {
  console.log('\n[worker] draining — finishing in-flight jobs');
  await worker.close();
  await queue.close();
  await connection.quit();
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
