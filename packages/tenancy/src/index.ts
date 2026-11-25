/**
 * @tupo/tenancy -- Tupo's side of the NGA multi-tenancy contract.
 *
 * The contract core (tenant context, registry, key/room/path helpers) is the
 * vendored copy in ./vendor/nga-tenancy (never edit it; re-sync with
 * `node nga_central_mis/packages/tenancy/sync.mjs packages/tenancy/src/vendor/nga-tenancy`).
 * This file adds what only Tupo needs:
 *
 *  - TENANCY_MODE (shadow | enforce) and the legacy-token default tenant;
 *  - the database scope the pool wrapper in @tupo/db applies to every
 *    connection: a tenant, the platform (every tenant, explicitly marked
 *    code only) or none (global tables only);
 *  - the tenant registry loaded from MIS `GET /platform/tenants/active`;
 *  - request gating (contract §6), job payload helpers and the X-NGA-Tenant
 *    header for service calls (contract §3).
 *
 * Every Tupo process loads one copy of this package (a workspace dependency),
 * so the AsyncLocalStorage behind currentTenant() is shared by api, chat,
 * mail, feed, notify and db code alike.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { setRoomTenantResolver } from '@tupo/shared';
import {
  PRIMARY_TENANT_ID,
  TenantContextMissing,
  TenantRegistry,
  currentTenantOrNull,
  isTenantUsable,
  normalizeTenant,
  parseTid,
  primaryTenantCtx,
  runWithTenant,
  type TenantClaims,
  type TenantCtx,
} from './vendor/nga-tenancy/index.js';

import {
  noteFallback, reportFallbacks, flushFallbacks, setRegistryStrict, strictActive, strictFromRegistryBody,
  type FallbackStore,
} from './fallbacks.js';

export * from './vendor/nga-tenancy/index.js';
export * from './fallbacks.js';

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export type TenancyMode = 'shadow' | 'enforce';

/**
 * shadow (default): code that reaches the database, a room or a MIS call with
 * no tenant context is treated as tenant 1 and logged once per call site
 * label. enforce: it throws TenantContextMissing (fail closed, contract §6.3).
 * Read on every call so tests (and an operator's restart) can flip it.
 */
export function tenancyMode(): TenancyMode {
  // MIS's registry turned strict mode on for tupo (contract A.6).
  if (strictActive()) return 'enforce';
  return (process.env.TENANCY_MODE ?? '').trim().toLowerCase() === 'enforce' ? 'enforce' : 'shadow';
}

/**
 * The tenant a token without a `tid` claim belongs to (contract §2): tenant 1
 * while TENANCY_LEGACY_DEFAULT_TID is unset or numeric, none (reject with
 * TENANT_REQUIRED) once it is set to `none`.
 */
export function legacyDefaultTid(): number | null {
  if (strictActive()) return null;
  const raw = (process.env.TENANCY_LEGACY_DEFAULT_TID ?? '').trim();
  if (!raw) return PRIMARY_TENANT_ID;
  if (raw.toLowerCase() === 'none') return null;
  return parseTid(raw) ?? PRIMARY_TENANT_ID;
}

/**
 * The school a session token's claims (or a MIS token's) speak for. A token
 * without `tid` (or the older `school_id`) gets TENANCY_LEGACY_DEFAULT_TID and
 * is counted as a `legacy_tid` fallback; null = refuse (TENANT_REQUIRED).
 */
export function sessionTidFromClaims(claims: TenantClaims | null | undefined, site = 'session token'): number | null {
  const explicit = claims ? (parseTid(claims.tid) ?? parseTid(claims.school_id)) : null;
  if (explicit) return explicit;
  const fallback = legacyDefaultTid();
  if (fallback !== null) noteFallback('legacy_tid', site);
  return fallback;
}

const warned = new Set<string>();
function warnShadow(what: string, kind: 'no_context' | 'payload_no_tid' = 'no_context'): void {
  noteFallback(kind, what);
  if (warned.has(what) || warned.size > 50) return;
  warned.add(what);
  const where = new Error().stack?.split('\n').slice(3, 6).map((l) => l.trim()).join(' <- ');
  console.warn(`[tenancy] ${what} ran without a tenant context; shadow mode treats it as tenant ${PRIMARY_TENANT_ID} (${where ?? 'unknown site'})`);
}

/** Tests only. */
export function __resetTenancyWarnings(): void {
  warned.clear();
}

/**
 * The tenant id this code acts for: the context's, else tenant 1 in shadow
 * mode, else TenantContextMissing.
 */
export function effectiveTid(what = 'operation'): number {
  const t = currentTenantOrNull();
  if (t) return t.tid;
  if (tenancyMode() === 'enforce') throw new TenantContextMissing(what);
  warnShadow(what);
  return PRIMARY_TENANT_ID;
}

/** The context this code runs in, with the same shadow fallback as effectiveTid. */
export function effectiveTenant(what = 'operation'): TenantCtx {
  const t = currentTenantOrNull();
  if (t) return t;
  if (tenancyMode() === 'enforce') throw new TenantContextMissing(what);
  warnShadow(what);
  return primaryTenantCtx();
}

// Every server-side room helper in @tupo/shared now names `t<tid>:<room>`.
setRoomTenantResolver(() => effectiveTid('socket room'));

// ---------------------------------------------------------------------------
// Database scope
// ---------------------------------------------------------------------------

export type DbScope =
  | { kind: 'tenant'; tid: number }
  /** Every tenant's rows (SET ROLE tupo_platform). Explicitly marked code only. */
  | { kind: 'platform'; reason: string }
  /** No tenant: tenant tables read as empty and refuse writes. For global tables and DDL. */
  | { kind: 'none'; reason: string };

interface ScopeFrame {
  kind: 'platform' | 'none';
  reason: string;
  /** The tenant context that was current when the frame was entered. */
  outer: TenantCtx | null;
}
const scopeAls = new AsyncLocalStorage<ScopeFrame>();

/**
 * Run `fn` across every tenant. The pool wrapper switches the connection to
 * the `tupo_platform` role, whose RLS policy sees every row. Reserved for the
 * control-plane-like jobs that genuinely span schools (partition upkeep's
 * reads, monitoring roll-ups, the provisioning endpoint). Inserts made here
 * must name `tenant_id` explicitly: the column default has no tenant to use.
 */
export function runAsPlatform<T>(reason: string, fn: () => T): T {
  return scopeAls.run({ kind: 'platform', reason, outer: currentTenantOrNull() }, fn);
}

/**
 * Run `fn` with no tenant at all: only the global tables (permissions,
 * link_previews, metric_samples, error_events, alert_state, tenants,
 * _migrations) are usable. Health checks and DDL helpers use it.
 */
export function runWithoutTenant<T>(reason: string, fn: () => T): T {
  return scopeAls.run({ kind: 'none', reason, outer: currentTenantOrNull() }, fn);
}

/**
 * The scope a database connection must carry right now. A runWithTenant()
 * entered *inside* a platform/none block wins over it (forEachActiveTenant
 * from a platform job), and a platform/none block entered inside a tenant
 * wins over the tenant.
 */
export function currentDbScope(what = 'database query'): DbScope {
  const frame = scopeAls.getStore();
  const tenant = currentTenantOrNull();
  if (frame && frame.outer === tenant) {
    return frame.kind === 'platform'
      ? { kind: 'platform', reason: frame.reason }
      : { kind: 'none', reason: frame.reason };
  }
  if (tenant) return { kind: 'tenant', tid: tenant.tid };
  return { kind: 'tenant', tid: effectiveTid(what) };
}

/** A minimal context for a tenant known only by id (jobs, relays). */
export function tenantCtxFor(tid: number, known?: TenantCtx | null): TenantCtx {
  if (known && known.tid === tid) return known;
  if (tid === PRIMARY_TENANT_ID) return primaryTenantCtx();
  return {
    tid, slug: `t${tid}`, name: `Tenant ${tid}`, status: 'ACTIVE',
    isPrimary: false, timezone: 'Africa/Kigali', pkg: 'starter',
  };
}

/** runWithTenant for code that only carries a tid (Redis relays, jobs). */
export function runWithTid<T>(tid: number, fn: () => T): T {
  const t = currentTenantOrNull();
  return runWithTenant(t && t.tid === tid ? t : tenantCtxFor(tid), fn);
}

// ---------------------------------------------------------------------------
// Registry (contract §4)
// ---------------------------------------------------------------------------

export interface MisRegistryOptions {
  misBaseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  /** Alternative to Basic: an integration token with scope tenants:read. */
  integrationToken?: string;
  /** Read when MIS is unreachable or too old (Tupo's own `tenants` table). */
  localLoad?: () => Promise<TenantCtx[]>;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  /** 'local' skips MIS and reads only `localLoad` (tests, an isolated dev box). */
  source?: 'mis' | 'local';
  /** Called with `tenancy.strict.tupo` each time MIS answers the registry fetch. */
  onStrict?: (strict: boolean) => void;
}

/** The service credentials MIS's platform endpoints take (registry fetch, fallback report). */
export function misServiceHeaders(opts: Pick<MisRegistryOptions, 'clientId' | 'clientSecret' | 'integrationToken'>): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.integrationToken) headers.Authorization = `Bearer ${opts.integrationToken}`;
  else if (opts.clientId && opts.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')}`;
  }
  return headers;
}

export async function loadTenantsFromMis(opts: MisRegistryOptions): Promise<TenantCtx[]> {
  const base = (opts.misBaseUrl ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('NGA_MIS_BASE_URL is not set');
  const headers = misServiceHeaders(opts);
  const res = await (opts.fetchImpl ?? fetch)(`${base}/platform/tenants/active`, {
    headers, signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`MIS /platform/tenants/active answered ${res.status}`);
  const body = (await res.json()) as { tenants?: unknown; data?: { tenants?: unknown } };
  const raw = Array.isArray(body.tenants) ? body.tenants
    : Array.isArray(body.data?.tenants) ? body.data!.tenants as unknown[] : null;
  if (!raw) throw new Error('MIS /platform/tenants/active returned no tenant list');
  // Automatic strict mode (contract A.6): an MIS without the flag means off.
  opts.onStrict?.(strictFromRegistryBody(body));
  return raw
    .map((t) => (t && typeof t === 'object' ? normalizeTenant(t as Record<string, unknown>) : null))
    .filter((t): t is TenantCtx => t !== null);
}

export function createMisTenantRegistry(opts: MisRegistryOptions = {}): TenantRegistry {
  return new TenantRegistry({
    ttlMs: opts.ttlMs ?? 30_000,
    fallback: [primaryTenantCtx()],
    load: async () => {
      if (opts.source === 'local') {
        const local = opts.localLoad ? await opts.localLoad() : [];
        if (!local.length) throw new Error('no local tenants');
        return local;
      }
      try {
        const list = await loadTenantsFromMis(opts);
        // MIS answered: it is the control plane. The primary tenant always exists.
        if (!list.some((t) => t.tid === PRIMARY_TENANT_ID)) list.push(primaryTenantCtx());
        return list;
      } catch (err) {
        if (opts.localLoad) {
          const local = await opts.localLoad().catch(() => []);
          if (local.length) return local;
        }
        throw err;
      }
    },
  });
}

let registry: TenantRegistry | null = null;
let localLoader: (() => Promise<TenantCtx[]>) | undefined;

/** @tupo/db registers a reader of the local `tenants` table as the fallback. */
export function setLocalTenantLoader(fn: () => Promise<TenantCtx[]>): void {
  localLoader = fn;
  registry = null;
}

/** The process-wide registry, built from env on first use. */
export function tenantRegistry(): TenantRegistry {
  if (!registry) {
    registry = createMisTenantRegistry({
      misBaseUrl: process.env.NGA_MIS_BASE_URL ?? 'https://mis.amashuri.com',
      clientId: process.env.SSO_CLIENT_ID,
      clientSecret: process.env.SSO_CLIENT_SECRET,
      integrationToken: process.env.MIS_TENANTS_TOKEN || undefined,
      localLoad: localLoader,
      source: process.env.TENANCY_REGISTRY_SOURCE === 'local' ? 'local' : 'mis',
      ttlMs: Number(process.env.TENANCY_REGISTRY_TTL_MS) || 30_000,
      onStrict: setRegistryStrict,
    });
  }
  return registry;
}

/** Tests: install a registry (or null to rebuild from env). */
export function setTenantRegistry(r: TenantRegistry | null): void {
  registry = r;
}

// ---------------------------------------------------------------------------
// Request gating (contract §6)
// ---------------------------------------------------------------------------

export type TenantGate =
  | { ok: true; tenant: TenantCtx }
  | { ok: false; status: 401 | 403; code: 'TENANT_REQUIRED' | 'TENANT_UNKNOWN' | 'TENANT_PENDING' | 'TENANT_SUSPENDED'; message: string };

/** Resolve a session's tid against the registry and apply the status rules. */
export async function gateTenant(tid: number | null, reg: Pick<TenantRegistry, 'get'> = tenantRegistry()): Promise<TenantGate> {
  if (tid == null) {
    return { ok: false, status: 401, code: 'TENANT_REQUIRED', message: 'Your session names no school. Please sign in again.' };
  }
  let tenant: TenantCtx | null = null;
  try {
    tenant = await reg.get(tid);
  } catch {
    tenant = tid === PRIMARY_TENANT_ID ? primaryTenantCtx() : null;
  }
  if (!tenant) return { ok: false, status: 401, code: 'TENANT_UNKNOWN', message: 'This school is not known here. Please sign in again.' };
  if (tenant.status === 'PENDING') return { ok: false, status: 403, code: 'TENANT_PENDING', message: 'This school is not open yet.' };
  if (!isTenantUsable(tenant.status)) return { ok: false, status: 403, code: 'TENANT_SUSPENDED', message: 'This school’s access is suspended.' };
  return { ok: true, tenant };
}

// ---------------------------------------------------------------------------
// Service calls (contract §3) and jobs (contract §6.4)
// ---------------------------------------------------------------------------

export const TENANT_HEADER_NAME = 'X-NGA-Tenant';

/** `{ 'X-NGA-Tenant': '<tid>' }` for a service-to-service call made now. */
export function tenantHeaders(what = 'MIS service call'): Record<string, string> {
  return { [TENANT_HEADER_NAME]: String(effectiveTid(what)) };
}

/** A queue payload named a tenant other than the one the enqueuing code runs in. */
export class JobTenantMismatch extends Error {
  constructor(readonly payloadTid: unknown, readonly contextTid: number) {
    super(`queue payload names tenant ${String(payloadTid)} but the code enqueuing it runs in tenant ${contextTid}`);
    this.name = 'JobTenantMismatch';
  }
}

/**
 * Stamp a queue payload with the tenant it belongs to: always the tenant of
 * the code enqueuing it (the request's context), never one the payload names.
 * A payload that already carries a different `tid` (or an unparsable one) is
 * refused, so data built from user input can never pick the tenant a job runs
 * in. The worker trusts `tid` only because server code stamped it here (or
 * the platform sweep fan-out in apps/worker/src/tenantJobs.ts did).
 */
export function withJobTenant<T extends object>(data: T): T & { tid: number } {
  const tid = effectiveTid('queue job');
  const raw = (data as { tid?: unknown }).tid;
  if (raw !== undefined && raw !== null && parseTid(raw) !== tid) throw new JobTenantMismatch(raw, tid);
  return { ...data, tid };
}

/** The tid a queue payload carries (shadow: missing -> tenant 1). */
export function jobTid(data: unknown): number {
  const tid = parseTid((data as { tid?: unknown } | null | undefined)?.tid);
  if (tid) return tid;
  if (tenancyMode() === 'enforce') throw new TenantContextMissing('queue job without tid');
  warnShadow('queue job without tid', 'payload_no_tid');
  return PRIMARY_TENANT_ID;
}

/** Re-enter the job's tenant (contract: queue jobs carry tid). */
export async function runJobInTenant<T>(data: unknown, fn: () => Promise<T>): Promise<T> {
  const tid = jobTid(data);
  const known = await tenantRegistry().get(tid).catch(() => null);
  return runWithTenant(tenantCtxFor(tid, known), fn);
}

// ---------------------------------------------------------------------------
// Fallback reporting (contract A.6)
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const FLUSH_MS = 60_000;

/**
 * Start this process's part of the fallback counters.
 *  - Every process with Redis adds its counts to the shared hash every minute.
 *  - The reporting process (the API's primary instance) also sends the day's
 *    totals to MIS at start-up and every hour, and refreshes the registry so
 *    a strict-mode flip is picked up even on a quiet server.
 * Returns a stop function. Timers are unref'd: they never hold a process open.
 */
export function startFallbackReporting(opts: {
  store?: FallbackStore | null;
  report?: boolean;
  fetchImpl?: typeof fetch;
} = {}): () => void {
  const timers: NodeJS.Timeout[] = [];
  const store = opts.store ?? null;
  if (store) {
    const t = setInterval(() => { void flushFallbacks(store).catch(() => {}); }, FLUSH_MS);
    t.unref?.();
    timers.push(t);
  }
  if (opts.report) {
    const send = async () => {
      // A registry read applies the current strict flag before reporting.
      await tenantRegistry().list().catch(() => []);
      await reportFallbacks({
        misBaseUrl: process.env.NGA_MIS_BASE_URL ?? 'https://mis.amashuri.com',
        headers: misServiceHeaders({
          clientId: process.env.SSO_CLIENT_ID,
          clientSecret: process.env.SSO_CLIENT_SECRET,
          integrationToken: process.env.MIS_TENANTS_TOKEN || undefined,
        }),
        store,
        fetchImpl: opts.fetchImpl,
      });
    };
    // Start-up report shortly after boot (the process is still settling).
    const first = setTimeout(() => { void send(); }, 5_000);
    first.unref?.();
    timers.push(first);
    const hourly = setInterval(() => { void send(); }, HOUR_MS);
    hourly.unref?.();
    timers.push(hourly);
  }
  return () => { for (const t of timers) clearInterval(t); };
}

// ---------------------------------------------------------------------------
// MIS browser session id (TENANT_SWITCHING_PLAN.md Appendix A.2)
// ---------------------------------------------------------------------------

const SID_RE = /^[A-Za-z0-9_-]{8,32}$/;

/** A valid MIS session id (`sid` claim, `nga_school` cookie), else null. */
export function parseSid(raw: unknown): string | null {
  return typeof raw === 'string' && SID_RE.test(raw) ? raw : null;
}

/**
 * The `sid` claim of a MIS JWT we hold (nested in the Tupo session) — read,
 * not verified: MIS verified it when it was issued to us. null for a token
 * minted before sids (it cannot be told apart from any other session).
 */
export function misTokenSid(misToken: string | null | undefined): string | null {
  if (!misToken || typeof misToken !== 'string') return null;
  try {
    const part = misToken.split('.')[1];
    if (!part) return null;
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { sid?: unknown };
    return parseSid(claims?.sid);
  } catch {
    return null;
  }
}

/**
 * The key a session's per-session revocation is stored under: its MIS `sid`,
 * or '' for a session whose MIS token has none (contract A.3: those are ended
 * by every sid-scoped logout, since they cannot be told apart).
 */
export function revocationSidOf(claims: { misToken?: string | null } | null | undefined): string {
  return misTokenSid(claims?.misToken) ?? '';
}

/** `nga_school=<tid>.<sid>` from a Cookie header (contract A.1), else null. */
export function parseSchoolCookie(cookieHeader: string | null | undefined): { tid: number; sid: string } | null {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== 'nga_school') continue;
    let value = part.slice(i + 1).trim();
    try { value = decodeURIComponent(value); } catch { /* keep raw */ }
    const m = /^(\d{1,9})\.([A-Za-z0-9_-]{8,32})$/.exec(value);
    if (!m) return null;
    const tid = parseTid(m[1]);
    return tid ? { tid, sid: m[2]! } : null;
  }
  return null;
}
