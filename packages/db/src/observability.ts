import { createHash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getPool } from './pool.js';

/**
 * Monitoring without paid tools (R-04, R-05).
 *
 * Every Tupo process keeps a few numbers in memory and writes them to
 * `metric_samples` once a minute; the worker turns them into alerts and the
 * System page into charts. Errors go to `error_events`, grouped by
 * fingerprint. Both are best effort: monitoring that can take the service
 * down with it would be worse than none, so every write swallows its failure.
 */

/* ── Metrics ────────────────────────────────────────────────────────────── */

export interface ProcessMetrics {
  /** Add to a counter for this minute. */
  count(name: string, by?: number): void;
  /** Record a duration (ms) for this minute's p50/p95. */
  time(name: string, ms: number): void;
  /** A value read when the minute is written (sockets, queue depth). */
  gauge(name: string, read: () => number | Promise<number>): void;
  /** Write now and stop. */
  stop(): Promise<void>;
}

const FLUSH_MS = 60_000;
/** Durations kept per name per minute; enough for a stable p95 at our traffic. */
const RESERVOIR = 2_000;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/**
 * Start this process's metrics. `service` names the row ('api#0', 'realtime');
 * every process also reports event-loop lag (p95, ms), resident memory (MB)
 * and heap (MB), the three numbers that say a Node process is struggling.
 */
export function startProcessMetrics(service: string, opts: { flushMs?: number } = {}): ProcessMetrics {
  const counters = new Map<string, number>();
  const timings = new Map<string, number[]>();
  const gauges = new Map<string, () => number | Promise<number>>();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();

  const flush = async () => {
    const rows: Array<[string, number]> = [];
    for (const [k, v] of counters) rows.push([k, v]);
    counters.clear();
    for (const [k, list] of timings) {
      const sorted = [...list].sort((a, b) => a - b);
      rows.push([`${k}_p50_ms`, percentile(sorted, 50)], [`${k}_p95_ms`, percentile(sorted, 95)]);
    }
    timings.clear();
    for (const [k, read] of gauges) {
      try { rows.push([k, Number(await read()) || 0]); } catch { /* a gauge that cannot be read is skipped */ }
    }
    rows.push(['event_loop_p95_ms', loop.percentile(95) / 1e6]);
    loop.reset();
    const mem = process.memoryUsage();
    rows.push(['rss_mb', mem.rss / 1048576], ['heap_mb', mem.heapUsed / 1048576]);
    await writeSamples(service, rows);
  };

  const timer = setInterval(() => void flush(), opts.flushMs ?? FLUSH_MS);
  timer.unref();

  return {
    count(name, by = 1) { counters.set(name, (counters.get(name) ?? 0) + by); },
    time(name, ms) {
      const list = timings.get(name) ?? [];
      // Reservoir: past the cap, replace a random entry so the sample stays fair.
      if (list.length < RESERVOIR) list.push(ms);
      else list[Math.floor(Math.random() * RESERVOIR)] = ms;
      timings.set(name, list);
    },
    gauge(name, read) { gauges.set(name, read); },
    async stop() { clearInterval(timer); loop.disable(); await flush(); },
  };
}

/** Write one minute's numbers. Also used by the worker for host-level gauges. */
export async function writeSamples(service: string, rows: Array<[string, number]>): Promise<void> {
  if (!rows.length) return;
  const params: unknown[] = [];
  const values = rows.map(([metric, value], i) => {
    params.push(service, metric, Number.isFinite(value) ? value : 0);
    return `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`;
  });
  try {
    await getPool().query(`INSERT INTO metric_samples (service, metric, value) VALUES ${values.join(', ')}`, params);
  } catch { /* the table may not exist yet (before the migration), or the DB is down */ }
}

/* ── Errors ─────────────────────────────────────────────────────────────── */

export type ErrorSource = 'web' | 'api' | 'realtime' | 'worker' | 'files';

export interface ErrorReport {
  source: ErrorSource;
  message: string;
  stack?: string | null;
  route?: string | null;
  release?: string | null;
  userId?: string | null;
  userAgent?: string | null;
}

/**
 * The same error from the same place is one row. Numbers, ids and quoted
 * values are taken out of the message, and only the first stack frame that
 * is ours counts, so "Cannot read 'x' of undefined at MessageThread" groups
 * however many times and with whatever ids it happens.
 */
export function errorFingerprint(r: Pick<ErrorReport, 'source' | 'message' | 'stack'>): string {
  const message = r.message
    .replace(/(["'`]).*?\1/g, '?')
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/\d+/g, '#')
    .slice(0, 200);
  const frame = (r.stack ?? '').split('\n').map((l) => l.trim())
    .find((l) => l.startsWith('at ') && !l.includes('node_modules') && !l.includes('node:'))
    ?.replace(/:\d+:\d+\)?$/, '')
    .replace(/\?[^)]*$/, '') ?? '';
  return createHash('sha1').update(`${r.source}|${message}|${frame}`).digest('hex').slice(0, 20);
}

/** Per process: the same fingerprint is written at most this often. */
const RECORD_EVERY_MS = 10_000;
const lastRecorded = new Map<string, number>();
const pendingCounts = new Map<string, number>();

/** Record an error. Never throws, never awaits anything the caller depends on. */
export async function recordError(r: ErrorReport): Promise<void> {
  const message = (r.message || 'Unknown error').slice(0, 1000);
  const fingerprint = errorFingerprint({ ...r, message });
  const now = Date.now();
  // A crash loop on one route must not become a write storm on the database.
  if (now - (lastRecorded.get(fingerprint) ?? 0) < RECORD_EVERY_MS) {
    pendingCounts.set(fingerprint, (pendingCounts.get(fingerprint) ?? 0) + 1);
    return;
  }
  lastRecorded.set(fingerprint, now);
  if (lastRecorded.size > 5_000) lastRecorded.clear();
  const extra = pendingCounts.get(fingerprint) ?? 0;
  pendingCounts.delete(fingerprint);
  try {
    await getPool().query(
      `INSERT INTO error_events (fingerprint, source, message, stack, route, release, count, last_user_id, last_user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (fingerprint) DO UPDATE SET
         count = error_events.count + EXCLUDED.count,
         last_at = now(),
         message = EXCLUDED.message,
         stack = COALESCE(EXCLUDED.stack, error_events.stack),
         route = COALESCE(EXCLUDED.route, error_events.route),
         release = COALESCE(EXCLUDED.release, error_events.release),
         last_user_id = COALESCE(EXCLUDED.last_user_id, error_events.last_user_id),
         last_user_agent = COALESCE(EXCLUDED.last_user_agent, error_events.last_user_agent),
         -- A resolved error that comes back is open again; an ignored one stays ignored.
         status = CASE WHEN error_events.status = 'resolved' THEN 'open' ELSE error_events.status END`,
      [fingerprint, r.source, message, r.stack?.slice(0, 4000) ?? null, r.route?.slice(0, 300) ?? null,
        r.release?.slice(0, 60) ?? null, 1 + extra, r.userId ?? null, r.userAgent?.slice(0, 300) ?? null],
    );
  } catch { /* monitoring must never take the service down */ }
}

/** The release this process runs (set by the deploy), for error rows. */
export const RELEASE = process.env.TUPO_RELEASE ?? process.env.npm_package_version ?? null;

/**
 * Last-resort process guards, the same for every Tupo service (A-02, R-05).
 * A stray rejection is logged, recorded and the process keeps serving; a
 * synchronous exception that escaped every handler is logged, recorded and
 * the process exits so pm2 restarts it from a known state — never more than a
 * second later, however slow the database is.
 */
export function installProcessGuards(service: ErrorSource): void {
  process.on('unhandledRejection', (reason) => {
    console.error(`[${service}] unhandled rejection (kept running):`, reason);
    const err = reason instanceof Error ? reason : new Error(String(reason));
    void recordError({ source: service, message: `Unhandled rejection: ${err.message}`, stack: err.stack, release: RELEASE });
  });
  process.on('uncaughtException', (err) => {
    console.error(`[${service}] uncaught exception — exiting for a clean restart:`, err);
    void Promise.race([
      recordError({ source: service, message: `Uncaught exception: ${err.message}`, stack: err.stack, release: RELEASE }),
      new Promise((r) => setTimeout(r, 1_000)),
    ]).finally(() => process.exit(1));
  });
}
