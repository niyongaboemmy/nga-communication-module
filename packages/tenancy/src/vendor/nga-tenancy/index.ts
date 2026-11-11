// VENDORED from nga_central_mis/packages/tenancy/src/index.ts -- do not edit.
// Re-sync with: node nga_central_mis/packages/tenancy/sync.mjs <this dir>
// sha256:131c6c9b22cce59c177bd1e50a20dc741e5901363919e554743e965c0b529619
/**
 * @nga/tenancy -- the shared multi-tenancy core.
 *
 * Every NGA service (MIS, Task Mentor, Tendo, Tupo api/realtime/worker/files)
 * runs each request, job and socket handler inside a tenant context. Data
 * access resolves the tenant from that context, so code that forgets to set
 * one fails closed (TenantContextMissing) instead of reading another school.
 *
 * Source of truth: nga_central_mis/packages/tenancy/src/index.ts. Consumers
 * vendor an exact copy with `node nga_central_mis/packages/tenancy/sync.mjs
 * <dir>` -- never edit a copy. Contract: MULTI_TENANCY_GAP_FIX_PLAN.md §2 and
 * packages/tenancy/CONTRACT.md.
 *
 * Node-only (AsyncLocalStorage); no other dependencies.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const TENANCY_CORE_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type TenantStatus = "PENDING" | "ACTIVE" | "GRACE" | "SUSPENDED" | "ARCHIVED";
export const TENANT_STATUSES: readonly TenantStatus[] = [
  "PENDING",
  "ACTIVE",
  "GRACE",
  "SUSPENDED",
  "ARCHIVED",
];

/** The existing school (NGA). Its databases are tenant 1 in place. */
export const PRIMARY_TENANT_ID = 1;

/** Header every service-to-service call carries (lower-case for Node). */
export const TENANT_HEADER = "x-nga-tenant";

export interface TenantCtx {
  tid: number;
  slug: string;
  name: string;
  status: TenantStatus;
  isPrimary: boolean;
  timezone: string;
  /** Package code: starter | gold | premium | max (management plan §3). */
  pkg: string;
}

/** Claims MIS puts in every session/SSO/logout token (token contract v2). */
export interface TenantClaims {
  tid?: number | string | null;
  tslug?: string | null;
  tstatus?: TenantStatus | null;
  pkg?: string | null;
  /** Older snapshots only carried school_id. */
  school_id?: number | string | null;
}

export class TenantContextMissing extends Error {
  readonly code = "TENANT_CONTEXT_MISSING";
  constructor(what = "operation") {
    super(`No tenant context for ${what}; wrap it in runWithTenant()/forEachActiveTenant()`);
    this.name = "TenantContextMissing";
  }
}

export class TenantMismatch extends Error {
  readonly code = "TENANT_MISMATCH";
  constructor(expected: number, got: number) {
    super(`Tenant mismatch: expected ${expected}, got ${got}`);
    this.name = "TenantMismatch";
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const als = new AsyncLocalStorage<TenantCtx>();

export function runWithTenant<T>(tenant: TenantCtx, fn: () => T): T {
  return als.run(tenant, fn);
}

/** The current tenant, or throw -- the fail-closed accessor data layers use. */
export function currentTenant(what?: string): TenantCtx {
  const t = als.getStore();
  if (!t) throw new TenantContextMissing(what);
  return t;
}

export function currentTenantOrNull(): TenantCtx | null {
  return als.getStore() ?? null;
}

export function currentTid(what?: string): number {
  return currentTenant(what).tid;
}

/** A minimal context for code paths that only know the id (e.g. legacy tokens). */
export function primaryTenantCtx(overrides: Partial<TenantCtx> = {}): TenantCtx {
  return {
    tid: PRIMARY_TENANT_ID,
    slug: "nga",
    name: "NGA",
    status: "ACTIVE",
    isPrimary: true,
    timezone: "Africa/Kigali",
    pkg: "max",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A positive safe integer tenant id, or null. Accepts "7" and 7. */
export function parseTid(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

/**
 * The tenant id a token speaks for. Tokens minted before tenancy carry
 * neither `tid` nor `school_id`; they belong to the primary tenant, but only
 * while `legacyDefault` is passed (apps pass PRIMARY_TENANT_ID during the
 * transition and null once every token in circulation carries a tid).
 */
export function tidFromClaims(
  claims: TenantClaims | null | undefined,
  legacyDefault: number | null = PRIMARY_TENANT_ID,
): number | null {
  if (!claims) return legacyDefault;
  const tid = parseTid(claims.tid);
  if (tid) return tid;
  const school = parseTid(claims.school_id);
  if (school) return school;
  return legacyDefault;
}

export function assertSameTenant(expected: number, got: number | null | undefined): void {
  if (got !== expected) throw new TenantMismatch(expected, Number(got));
}

// ---------------------------------------------------------------------------
// Status rules
// ---------------------------------------------------------------------------

/** May users of this tenant use the apps? GRACE still works (with a banner). */
export function isTenantUsable(status: TenantStatus): boolean {
  return status === "ACTIVE" || status === "GRACE";
}

/** Should schedulers run for this tenant? */
export function isTenantSchedulable(status: TenantStatus): boolean {
  return isTenantUsable(status);
}

// ---------------------------------------------------------------------------
// Namespacing helpers -- every shared resource carries the tenant
// ---------------------------------------------------------------------------

function tidOf(tid?: number): number {
  return tid ?? currentTid("tenant-scoped key");
}

/** Cache/Redis key prefix: tenantKey("snapshot", 42) -> "t7:snapshot:42". */
export function tenantKey(...parts: Array<string | number>): string {
  return [`t${tidOf()}`, ...parts].join(":");
}

export function tenantKeyFor(tid: number, ...parts: Array<string | number>): string {
  return [`t${tid}`, ...parts].join(":");
}

/** File-server path: tenantPath("nga-task-mentor", "a", "f.pdf") -> "nga-task-mentor/t/7/a/f.pdf". */
export function tenantPath(app: string, ...parts: string[]): string {
  return tenantPathFor(tidOf(), app, ...parts);
}

export function tenantPathFor(tid: number, app: string, ...parts: string[]): string {
  const clean = parts
    .flatMap((p) => String(p).split("/"))
    .filter((p) => p !== "" && p !== "." && p !== "..");
  return [app, "t", String(tid), ...clean].join("/");
}

/** Socket.IO room: tenantRoom("conv:9") -> "t7:conv:9". */
export function tenantRoom(name: string, tid?: number): string {
  return `t${tidOf(tid)}:${name}`;
}

/** Does a room/key belong to the given tenant? */
export function belongsToTenant(keyOrRoom: string, tid: number): boolean {
  return keyOrRoom.startsWith(`t${tid}:`);
}

// ---------------------------------------------------------------------------
// Registry -- cached view of the control plane's tenant list
// ---------------------------------------------------------------------------

export interface TenantRegistryOptions {
  /** Load every tenant (MIS reads the control plane; spokes call MIS). */
  load: () => Promise<TenantCtx[]>;
  ttlMs?: number;
  /** Used when `load` fails before anything was cached. */
  fallback?: TenantCtx[];
}

export class TenantRegistry {
  private cache: Map<number, TenantCtx> | null = null;
  private loadedAt = 0;
  private inflight: Promise<Map<number, TenantCtx>> | null = null;
  private readonly ttlMs: number;

  constructor(private readonly opts: TenantRegistryOptions) {
    this.ttlMs = opts.ttlMs ?? 30_000;
  }

  invalidate(): void {
    this.cache = null;
    this.loadedAt = 0;
  }

  private async map(): Promise<Map<number, TenantCtx>> {
    if (this.cache && Date.now() - this.loadedAt < this.ttlMs) return this.cache;
    if (!this.inflight) {
      this.inflight = this.opts
        .load()
        .then((list) => {
          const m = new Map(list.map((t) => [t.tid, t] as const));
          this.cache = m;
          this.loadedAt = Date.now();
          return m;
        })
        .catch((err) => {
          // Keep serving a stale list rather than dropping every request.
          if (this.cache) return this.cache;
          if (this.opts.fallback) return new Map(this.opts.fallback.map((t) => [t.tid, t] as const));
          throw err;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  async get(tid: number): Promise<TenantCtx | null> {
    return (await this.map()).get(tid) ?? null;
  }

  async list(): Promise<TenantCtx[]> {
    return [...(await this.map()).values()].sort((a, b) => a.tid - b.tid);
  }

  async listSchedulable(): Promise<TenantCtx[]> {
    return (await this.list()).filter((t) => isTenantSchedulable(t.status));
  }
}

// ---------------------------------------------------------------------------
// Jobs -- run a body once per tenant, isolated
// ---------------------------------------------------------------------------

export interface ForEachTenantOptions {
  onError?: (tenant: TenantCtx, err: unknown) => void;
  /** Override the default schedulable filter (ACTIVE + GRACE). */
  filter?: (t: TenantCtx) => boolean;
}

/**
 * Runs `fn` sequentially for each schedulable tenant inside its context. One
 * tenant's failure never stops the others. Returns the tenants that failed.
 */
export async function forEachActiveTenant(
  registry: Pick<TenantRegistry, "list">,
  fn: (tenant: TenantCtx) => Promise<void> | void,
  opts: ForEachTenantOptions = {},
): Promise<TenantCtx[]> {
  const filter = opts.filter ?? ((t: TenantCtx) => isTenantSchedulable(t.status));
  const failed: TenantCtx[] = [];
  for (const tenant of (await registry.list()).filter(filter)) {
    try {
      await runWithTenant(tenant, () => fn(tenant));
    } catch (err) {
      failed.push(tenant);
      if (opts.onError) opts.onError(tenant, err);
      else console.error(`[tenancy] job failed for tenant ${tenant.tid} (${tenant.slug}):`, err);
    }
  }
  return failed;
}

/** Serialize a tenant list as MIS's GET /platform/tenants/active returns it. */
export function normalizeTenant(raw: Record<string, unknown>): TenantCtx | null {
  const tid = parseTid(raw.tid ?? raw.tenant_id);
  if (!tid) return null;
  const status = String(raw.status ?? "ACTIVE").toUpperCase() as TenantStatus;
  return {
    tid,
    slug: String(raw.slug ?? `t${tid}`),
    name: String(raw.name ?? raw.display_name ?? raw.slug ?? `Tenant ${tid}`),
    status: TENANT_STATUSES.includes(status) ? status : "ACTIVE",
    isPrimary: Boolean(raw.isPrimary ?? raw.is_primary ?? tid === PRIMARY_TENANT_ID),
    timezone: String(raw.timezone ?? "Africa/Kigali"),
    pkg: String(raw.pkg ?? raw.package_code ?? raw.package ?? "starter"),
  };
}
