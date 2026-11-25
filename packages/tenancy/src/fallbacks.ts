/**
 * Fallback counters and the automatic strict mode (TENANT_SWITCHING_PLAN.md
 * §7.5, Appendix A.6).
 *
 * Every time Tupo quietly uses school 1 because something did not name a
 * school, it counts it here:
 *
 *   no_context      data access / a room / a MIS call with no tenant context
 *   legacy_tid      a session token (or the MIS token inside it) without `tid`
 *   payload_no_tid  a queue job, pub/sub relay or logout token without `tid`
 *
 * Counts are per UTC day. Each process keeps its own and, when it has Redis,
 * adds them to one shared hash every minute, so the API (which reports) sees
 * the realtime gateway's and the worker's too. The API reports the day's
 * cumulative counts to MIS `POST /platform/tenancy/fallbacks` at start-up and
 * every hour; the report doubles as Tupo's heartbeat, so it is sent with zero
 * counts too. MIS turns `tenancy.strict.tupo` on after seven clean days, and
 * the registry response carries the flag back (see strictActive()).
 *
 * Nothing here may throw into the code that counts: a broken Redis or an MIS
 * that does not know the endpoint yet only costs the report.
 */

export const FALLBACK_KINDS = ['no_context', 'legacy_tid', 'payload_no_tid'] as const;
export type FallbackKind = (typeof FALLBACK_KINDS)[number];
export type FallbackCounts = Record<FallbackKind, number>;

/** The app name MIS knows Tupo by (contract A.6). */
export const FALLBACK_APP = 'tupo';
/** At most this many call sites travel with a report (contract: ≤ 10). */
export const MAX_REPORTED_SITES = 10;

const zero = (): FallbackCounts => ({ no_context: 0, legacy_tid: 0, payload_no_tid: 0 });

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

interface DayTally {
  /** Everything counted in this process today. */
  total: FallbackCounts;
  /** Counted but not yet added to the shared Redis hash. */
  unflushed: FallbackCounts;
  sites: Set<string>;
  /** Sites not yet added to the shared Redis set. */
  newSites: Set<string>;
}
const days = new Map<string, DayTally>();
let clock: () => number = () => Date.now();

function tally(day: string): DayTally {
  let t = days.get(day);
  if (!t) {
    t = { total: zero(), unflushed: zero(), sites: new Set(), newSites: new Set() };
    days.set(day, t);
    // Only today and yesterday matter; older days have been reported.
    const keep = new Set([day, utcDay(clock() - 86_400_000)]);
    for (const d of days.keys()) if (!keep.has(d)) days.delete(d);
  }
  return t;
}

/** Count one fallback to school 1. `site` names where (a short label, never data). */
export function noteFallback(kind: FallbackKind, site?: string): void {
  try {
    const t = tally(utcDay(clock()));
    t.total[kind] += 1;
    t.unflushed[kind] += 1;
    if (site && t.sites.size < MAX_REPORTED_SITES) {
      const label = `${kind}:${site}`.slice(0, 120);
      if (!t.sites.has(label)) { t.sites.add(label); t.newSites.add(label); }
    }
  } catch { /* counting must never break the caller */ }
}

/** This process's counts for a day (today by default). */
export function localFallbackCounts(day = utcDay(clock())): { counts: FallbackCounts; sites: string[] } {
  const t = days.get(day);
  return { counts: t ? { ...t.total } : zero(), sites: t ? [...t.sites] : [] };
}

/** Tests only. */
export function __resetFallbacks(now?: () => number): void {
  days.clear();
  clock = now ?? (() => Date.now());
}

// ---------------------------------------------------------------------------
// Shared aggregation (Redis)
// ---------------------------------------------------------------------------

/** The few Redis commands this needs; an ioredis client satisfies it. */
export interface FallbackStore {
  hincrby(key: string, field: string, increment: number): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
}

const countsKey = (day: string) => `tupo:tenancy:fallbacks:${day}`;
const sitesKey = (day: string) => `tupo:tenancy:fallback-sites:${day}`;
const KEEP_S = 3 * 86_400;

/**
 * Add what this process counted since the last flush to the shared hash. On a
 * Redis error the deltas are kept and go with the next flush.
 */
export async function flushFallbacks(store: FallbackStore): Promise<void> {
  for (const [day, t] of days) {
    const pending = FALLBACK_KINDS.filter((k) => t.unflushed[k] > 0);
    if (!pending.length && !t.newSites.size) continue;
    const moving = { ...t.unflushed };
    const movingSites = [...t.newSites];
    for (const k of pending) t.unflushed[k] = 0;
    t.newSites.clear();
    try {
      for (const k of pending) await store.hincrby(countsKey(day), k, moving[k]);
      await store.expire(countsKey(day), KEEP_S);
      if (movingSites.length) {
        await store.sadd(sitesKey(day), ...movingSites);
        await store.expire(sitesKey(day), KEEP_S);
      }
    } catch {
      // Put them back: counted once, whenever Redis is back. (A partial
      // HINCRBY before the error may count a kind twice — the safe side for
      // a counter whose only question is "zero or not".)
      for (const k of pending) t.unflushed[k] += moving[k];
      for (const s of movingSites) t.newSites.add(s);
    }
  }
}

/** Every Tupo process's counts for a day: the shared hash, or this process's own without Redis. */
export async function dayFallbackCounts(day: string, store?: FallbackStore | null): Promise<{ counts: FallbackCounts; sites: string[] }> {
  if (store) {
    try {
      await flushFallbacks(store);
      const raw = await store.hgetall(countsKey(day));
      const counts = zero();
      for (const k of FALLBACK_KINDS) {
        const n = Number(raw?.[k]);
        counts[k] = Number.isFinite(n) && n > 0 ? n : 0;
      }
      const sites = (await store.smembers(sitesKey(day)).catch(() => [])).slice(0, MAX_REPORTED_SITES);
      return { counts, sites };
    } catch { /* fall through to this process's view */ }
  }
  const local = localFallbackCounts(day);
  return { counts: local.counts, sites: local.sites.slice(0, MAX_REPORTED_SITES) };
}

// ---------------------------------------------------------------------------
// Reporting to MIS
// ---------------------------------------------------------------------------

export interface FallbackReport {
  app: typeof FALLBACK_APP;
  day: string;
  counts: FallbackCounts;
  sites?: string[];
}

export interface ReportOptions {
  misBaseUrl: string;
  /** The same credentials as the registry fetch (Basic client id/secret or a tenants:read token). */
  headers: Record<string, string>;
  store?: FallbackStore | null;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function buildFallbackReport(day: string, store?: FallbackStore | null): Promise<FallbackReport> {
  const { counts, sites } = await dayFallbackCounts(day, store);
  return { app: FALLBACK_APP, day, counts, ...(sites.length ? { sites } : {}) };
}

let lastReportedDay: string | null = null;
const loggedFailures = new Set<string>();

/**
 * Send the day's cumulative counts. When the UTC day has turned since the last
 * report, yesterday's final counts go first, so nothing counted between the
 * last hourly report and midnight is lost. Never throws; returns the HTTP
 * statuses (null = not sent / unreachable).
 */
export async function reportFallbacks(opts: ReportOptions): Promise<Array<{ day: string; status: number | null }>> {
  const base = (opts.misBaseUrl ?? '').replace(/\/+$/, '');
  const today = utcDay(opts.now ?? clock());
  const due = lastReportedDay && lastReportedDay < today ? [lastReportedDay, today] : [today];
  const out: Array<{ day: string; status: number | null }> = [];
  for (const day of due) {
    let status: number | null = null;
    try {
      if (!base) throw new Error('NGA_MIS_BASE_URL is not set');
      const body = await buildFallbackReport(day, opts.store);
      const res = await (opts.fetchImpl ?? fetch)(`${base}/platform/tenancy/fallbacks`, {
        method: 'POST',
        headers: { ...opts.headers, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      status = res.status;
      // An MIS without the endpoint (404) or an old credential scope: say so
      // once per kind of failure, not every hour.
      if (!res.ok) logOnce(`status ${res.status}`, `[tenancy] fallback report answered ${res.status}; MIS may not support it yet`);
    } catch (err) {
      logOnce(err instanceof Error ? err.message : String(err), `[tenancy] fallback report not sent: ${err instanceof Error ? err.message : err}`);
    }
    out.push({ day, status });
  }
  lastReportedDay = today;
  return out;
}

function logOnce(key: string, message: string): void {
  if (loggedFailures.has(key) || loggedFailures.size > 20) return;
  loggedFailures.add(key);
  console.warn(message);
}

/** Tests only. */
export function __resetFallbackReporting(): void {
  lastReportedDay = null;
  loggedFailures.clear();
}

// ---------------------------------------------------------------------------
// Strict mode (registry flag)
// ---------------------------------------------------------------------------

let registryStrict: boolean | null = null;

/**
 * What MIS's registry said about `tenancy.strict.tupo` the last time it
 * answered: true, false (absent counts as false), or null before any answer.
 */
export function setRegistryStrict(value: boolean | null): void {
  if (value !== registryStrict && value !== null && registryStrict !== null) {
    console.warn(`[tenancy] MIS turned strict mode ${value ? 'ON' : 'off'} for tupo${value && strictKillSwitch() ? ' (ignored: TENANCY_STRICT=off)' : ''}`);
  }
  registryStrict = value;
}

export function registryStrictFlag(): boolean | null {
  return registryStrict;
}

function strictKillSwitch(): boolean {
  return (process.env.TENANCY_STRICT ?? '').trim().toLowerCase() === 'off';
}

/**
 * Strict mode is on when MIS's registry says so for tupo, unless the operator
 * set TENANCY_STRICT=off. Strict = TENANCY_LEGACY_DEFAULT_TID=none plus
 * TENANCY_MODE=enforce (contract A.6).
 */
export function strictActive(): boolean {
  return registryStrict === true && !strictKillSwitch();
}

/** `tenancy.strict.tupo` from a registry body (top level or under data); false when absent. */
export function strictFromRegistryBody(body: unknown): boolean {
  const b = body as { tenancy?: { strict?: Record<string, unknown> }; data?: { tenancy?: { strict?: Record<string, unknown> } } } | null;
  const strict = b?.tenancy?.strict ?? b?.data?.tenancy?.strict;
  return strict?.[FALLBACK_APP] === true;
}
