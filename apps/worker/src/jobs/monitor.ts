import os from 'node:os';
import { statfs } from 'node:fs/promises';
import type { Redis } from 'ioredis';
import { getPool, writeSamples } from '@tupo/db';
import { runAsPlatform } from '@tupo/tenancy';
import { smtpConfigFromEnv, sendSmtp } from '@tupo/mail';
import { partitionsAhead } from './partitions.js';

/**
 * The watchman (R-03, R-04, R-07). Every minute:
 *
 *   1. writes the host's numbers (free memory, disk, load, Redis memory,
 *      partitions in hand) next to the ones each service writes itself;
 *   2. checks the alert rules against the last few minutes;
 *   3. tells people when a rule starts firing, again every few hours while it
 *      lasts, and when it stops — by email through the school's SMTP relay
 *      (ALERT_EMAILS) and by Telegram if a bot is configured
 *      (ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID).
 *
 * Hourly it also trims what it keeps: samples 14 days, settled errors 90 days.
 */

interface Rule {
  name: string;
  /** Plain words for the message: what is wrong, then the number. */
  describe: (value: number) => string;
  /** The current value, or null when there is not enough data to judge. */
  read: () => Promise<number | null>;
  firing: (value: number) => boolean;
}

/** One number over the last `minutes`, across every row of that metric. */
async function recent(metric: string, agg: 'sum' | 'max' | 'min' | 'avg', minutes: number, service?: string): Promise<number | null> {
  const { rows } = await getPool().query<{ v: number | null; n: number }>(
    `SELECT ${agg}(value) AS v, count(*)::int AS n FROM metric_samples
      WHERE metric = $1 AND at > now() - make_interval(mins => $2)
        AND ($3::text IS NULL OR service = $3 OR service LIKE $3 || '#%')`,
    [metric, minutes, service ?? null],
  );
  return rows[0]?.n ? Number(rows[0].v) : null;
}

/** Minutes since a service last wrote anything; null if it never has. */
async function silentMinutes(service: string): Promise<number | null> {
  const { rows } = await getPool().query<{ m: number | null }>(
    `SELECT EXTRACT(EPOCH FROM now() - max(at)) / 60 AS m FROM metric_samples
      WHERE (service = $1 OR service LIKE $1 || '#%') AND at > now() - interval '1 day'`,
    [service],
  );
  return rows[0]?.m === null || rows[0]?.m === undefined ? null : Number(rows[0].m);
}

const num = (env: string | undefined, fallback: number) => (env && Number.isFinite(Number(env)) ? Number(env) : fallback);

/** Thresholds are generous on purpose: an alert that cries wolf gets muted. */
export function alertRules(): Rule[] {
  const T = {
    errorRatePct: num(process.env.ALERT_ERROR_RATE_PCT, 5),
    p95Ms: num(process.env.ALERT_P95_MS, 1500),
    loopMs: num(process.env.ALERT_EVENT_LOOP_MS, 250),
    queue: num(process.env.ALERT_QUEUE_DEPTH, 500),
    freeMemMb: num(process.env.ALERT_FREE_MEM_MB, 200),
    diskPct: num(process.env.ALERT_DISK_FREE_PCT, 10),
    redisMb: num(process.env.ALERT_REDIS_MB, 512),
    errorSpike: num(process.env.ALERT_ERROR_SPIKE, 25),
  };
  const rules: Rule[] = [
    {
      name: 'api_error_rate',
      describe: (v) => `The API is failing ${v.toFixed(1)}% of requests (5xx) over the last 5 minutes.`,
      read: async () => {
        const total = await recent('http_requests', 'sum', 5, 'api');
        if (!total || total < 50) return null;
        return (((await recent('http_5xx', 'sum', 5, 'api')) ?? 0) / total) * 100;
      },
      firing: (v) => v > T.errorRatePct,
    },
    {
      name: 'api_slow',
      describe: (v) => `The API is slow: the slowest 5% of requests take ${Math.round(v)} ms.`,
      read: () => recent('http_p95_ms', 'avg', 5, 'api'),
      firing: (v) => v > T.p95Ms,
    },
    {
      name: 'event_loop_lag',
      describe: (v) => `A Tupo service is overloaded: its event loop is lagging ${Math.round(v)} ms.`,
      read: () => recent('event_loop_p95_ms', 'max', 5),
      firing: (v) => v > T.loopMs,
    },
    {
      name: 'queue_backlog',
      describe: (v) => `${Math.round(v)} background jobs are waiting (mail, scheduled messages, notifications are delayed).`,
      read: () => recent('queue_waiting', 'min', 5, 'worker'),
      firing: (v) => v > T.queue,
    },
    {
      name: 'low_memory',
      describe: (v) => `The server is low on memory: ${Math.round(v)} MB free.`,
      read: () => recent('host_free_mem_mb', 'max', 5, 'system'),
      firing: (v) => v < T.freeMemMb,
    },
    {
      name: 'low_disk',
      describe: (v) => `The server's disk is nearly full: ${v.toFixed(1)}% free.`,
      read: () => recent('host_disk_free_pct', 'min', 5, 'system'),
      firing: (v) => v < T.diskPct,
    },
    {
      name: 'partitions_running_out',
      describe: (v) => `Only ${v} month(s) of chat/meeting partitions are prepared. Check the partitions:ensure job.`,
      read: () => recent('partitions_ahead_months', 'min', 10, 'system'),
      firing: (v) => v < 2,
    },
    {
      name: 'redis_memory',
      describe: (v) => `Redis is using ${Math.round(v)} MB.`,
      read: () => recent('redis_used_mb', 'max', 5, 'system'),
      firing: (v) => v > T.redisMb,
    },
    {
      name: 'error_spike',
      describe: (v) => `${v} new errors were recorded in the last 10 minutes. See System › Errors.`,
      read: async () => {
        // Every school's errors and the process-level ones (error_events has RLS, 0047).
        const { rows } = await runAsPlatform('error spike alert', () => getPool().query<{ n: number }>(
          `SELECT COALESCE(sum(count), 0)::int AS n FROM error_events
            WHERE last_at > now() - interval '10 minutes' AND status = 'open'`));
        return rows[0]?.n ?? 0;
      },
      firing: (v) => v > T.errorSpike,
    },
  ];
  // A service that has stopped writing has stopped (or cannot reach the database).
  for (const service of ['api', 'realtime', 'files']) {
    rules.push({
      name: `${service}_silent`,
      describe: (v) => `tupo-${service} has not reported for ${Math.round(v)} minutes. It may be down.`,
      read: () => silentMinutes(service),
      firing: (v) => v > 3,
    });
  }
  return rules;
}

/* ── Host numbers ───────────────────────────────────────────────────────── */

export async function collectHostSamples(redis: Redis | null): Promise<void> {
  const rows: Array<[string, number]> = [
    // os.freemem counts page cache as used on Linux; available memory is the honest number.
    ['host_free_mem_mb', (await availableMemory()) / 1048576],
    ['host_load_1m', os.loadavg()[0] ?? 0],
  ];
  try {
    const fs = await statfs('/');
    rows.push(['host_disk_free_pct', (fs.bavail / fs.blocks) * 100]);
  } catch { /* not every platform */ }
  const ahead = await partitionsAhead();
  if (ahead !== null) rows.push(['partitions_ahead_months', ahead]);
  if (redis) {
    try {
      const info = await redis.info('memory');
      const used = Number(/used_memory:(\d+)/.exec(info)?.[1] ?? 0);
      rows.push(['redis_used_mb', used / 1048576]);
    } catch { /* reported as missing; the worker's own health covers Redis */ }
  }
  await writeSamples('system', rows);
}

async function availableMemory(): Promise<number> {
  if (process.platform === 'linux') {
    try {
      const { readFile } = await import('node:fs/promises');
      const kb = Number(/MemAvailable:\s+(\d+)/.exec(await readFile('/proc/meminfo', 'utf8'))?.[1]);
      if (kb) return kb * 1024;
    } catch { /* fall back */ }
  }
  return os.freemem();
}

/* ── Alerts ─────────────────────────────────────────────────────────────── */

const RENOTIFY_MS = 6 * 60 * 60_000;

interface Notifier { (subject: string, text: string): Promise<void> }

export function defaultNotifier(): Notifier {
  return async (subject, text) => {
    const tasks: Promise<unknown>[] = [];
    const emails = (process.env.ALERT_EMAILS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const smtp = smtpConfigFromEnv();
    if (smtp && emails.length) {
      for (const to of emails) {
        tasks.push(sendSmtp(smtp, {
          to, fromName: 'Tupo monitoring', subject: `[Tupo] ${subject}`, text,
          html: `<p>${text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!)).replace(/\n/g, '<br>')}</p>`,
        }));
      }
    }
    const bot = process.env.ALERT_TELEGRAM_BOT_TOKEN, chat = process.env.ALERT_TELEGRAM_CHAT_ID;
    if (bot && chat) {
      tasks.push(fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: `Tupo — ${subject}\n${text}` }),
        signal: AbortSignal.timeout(10_000),
      }));
    }
    if (!tasks.length) console.warn(`[monitor] ALERT (no ALERT_EMAILS / Telegram configured): ${subject} — ${text}`);
    await Promise.allSettled(tasks);
  };
}

/** Evaluate every rule and notify on changes. Returns the rules firing now. */
export async function evaluateAlerts(notify: Notifier = defaultNotifier(), rules = alertRules()): Promise<string[]> {
  const firingNow: string[] = [];
  for (const rule of rules) {
    let value: number | null;
    try { value = await rule.read(); } catch { continue; }
    const firing = value !== null && rule.firing(value);
    const detail = value !== null ? rule.describe(value) : null;
    const { rows } = await getPool().query<{ firing: boolean; last_notified_at: Date | null }>(
      'SELECT firing, last_notified_at FROM alert_state WHERE rule = $1', [rule.name]);
    const prev = rows[0];
    const now = Date.now();
    if (firing) {
      firingNow.push(rule.name);
      const due = !prev?.firing || !prev.last_notified_at || now - prev.last_notified_at.getTime() > RENOTIFY_MS;
      if (due) await notify(prev?.firing ? `Still: ${rule.name}` : `Alert: ${rule.name}`, detail ?? rule.name);
      await getPool().query(
        `INSERT INTO alert_state (rule, firing, since, last_notified_at, detail, updated_at)
         VALUES ($1, true, now(), now(), $2, now())
         ON CONFLICT (rule) DO UPDATE SET
           firing = true,
           since = CASE WHEN alert_state.firing THEN alert_state.since ELSE now() END,
           last_notified_at = CASE WHEN $3 THEN now() ELSE alert_state.last_notified_at END,
           detail = $2, updated_at = now()`,
        [rule.name, detail, due],
      );
    } else {
      if (prev?.firing) await notify(`Resolved: ${rule.name}`, detail ?? 'Back to normal.');
      // Every rule has a row with its latest reading, firing or not, so the
      // System page can show what is being watched and how it looks now.
      await getPool().query(
        `INSERT INTO alert_state (rule, firing, detail, updated_at) VALUES ($1, false, $2, now())
         ON CONFLICT (rule) DO UPDATE SET firing = false, detail = $2, updated_at = now()`,
        [rule.name, detail],
      );
    }
  }
  return firingNow;
}

/** What monitoring keeps, trimmed hourly. */
export async function pruneMonitoring(): Promise<void> {
  await getPool().query(`DELETE FROM metric_samples WHERE at < now() - interval '14 days'`);
  await runAsPlatform('monitoring prune', () =>
    getPool().query(`DELETE FROM error_events WHERE status <> 'open' AND last_at < now() - interval '90 days'`));
}
