import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { currentDbScope, runWithoutTenant, tenancyMode, type DbScope, type TenancyMode } from '@tupo/tenancy';
import * as schema from './schema.js';

/**
 * Tenant-scoped connection pool (multi-tenancy Phase 6, ADR-1).
 *
 * Every tenant-owned table has row-level security keyed on the session
 * setting `app.tenant_id` (migration 0046). This pool makes sure each
 * connection carries the right setting before any statement of the caller
 * runs on it:
 *
 *  - `pool.query(...)` (pg-pool routes it through `connect()`), Drizzle, and
 *    `pool.connect()` + BEGIN/COMMIT transaction helpers all go through
 *    `connect()` below, which applies the caller's scope (from the
 *    AsyncLocalStorage tenant context, see @tupo/tenancy currentDbScope).
 *  - The scope is applied with a SESSION-level set_config and remembered on
 *    the pg client, so it is sent only when it changes: in the steady state
 *    (one tenant, or a run of requests from one tenant) a query costs zero
 *    extra round trips; a tenant switch costs one. The obvious alternative --
 *    BEGIN; SELECT set_config(..., true); <stmt>; COMMIT around every query --
 *    costs extra round trips on every statement (measured in
 *    __tests__/tenantPool.test.ts).
 *  - It is always applied on an idle connection (never inside a caller's
 *    transaction), so a ROLLBACK cannot undo it behind the cache's back.
 *  - A checked-out client is bound to the scope it was checked out under for
 *    its whole life (a transaction never straddles tenants).
 *
 * Scopes: a tenant (`app.tenant_id = <tid>`, RESET ROLE); the platform
 * (`SET ROLE tupo_platform`, whose policy sees every tenant -- runAsPlatform);
 * none (`app.tenant_id = ''`, tenant tables read empty -- runWithoutTenant).
 * With no context at all: TENANCY_MODE=enforce throws TenantContextMissing,
 * shadow uses tenant 1 and warns once.
 */

const SCOPE = Symbol.for('tupo.tenantScope');
type ScopedClient = pg.PoolClient & { [SCOPE]?: string };

/** Created by migration 0046; the app role may SET ROLE to it but never inherits it. */
export const PLATFORM_ROLE = 'tupo_platform';

function scopeKey(scope: DbScope): string {
  return scope.kind === 'tenant' ? `t${scope.tid}` : scope.kind === 'platform' ? 'platform' : 'none';
}

/** The one statement (simple protocol, no parameters) that moves a session to `scope`. */
export function scopeSql(scope: DbScope, previous: string | undefined): string {
  const tid = scope.kind === 'tenant' ? String(scope.tid) : '';
  // tid is interpolated as a literal: it must be a plain positive integer.
  if (scope.kind === 'tenant' && !/^[1-9]\d{0,15}$/.test(tid)) throw new Error(`invalid tenant id ${tid}`);
  const set = `SELECT set_config('app.tenant_id', '${tid}', false)`;
  if (scope.kind === 'platform') return `${set}; SET ROLE ${pg.escapeIdentifier(PLATFORM_ROLE)}`;
  // RESET ROLE only when the connection may have been platform before.
  return previous === undefined || previous === 'platform' ? `${set}; RESET ROLE` : set;
}

/** Tests/benchmarks: how many scope switches this process sent. */
export const tenantPoolStats = { switches: 0 };

async function applyScope(client: ScopedClient, scope: DbScope): Promise<void> {
  const key = scopeKey(scope);
  if (client[SCOPE] === key) return;
  const sql = scopeSql(scope, client[SCOPE]);
  // Forget the old key first: if the statement fails the client is released
  // with the error (destroyed) and never reused under a stale key.
  client[SCOPE] = undefined;
  await client.query(sql);
  client[SCOPE] = key;
  tenantPoolStats.switches++;
}

type ConnectCallback = (err: Error | undefined, client?: pg.PoolClient, done?: (release?: Error | boolean) => void) => void;

export class TenantPool extends pg.Pool {
  override connect(): Promise<pg.PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    let scope: DbScope;
    try {
      scope = currentDbScope('database query');
    } catch (err) {
      if (callback) { process.nextTick(() => callback(err as Error)); return; }
      return Promise.reject(err);
    }
    const ready = super.connect().then(async (client) => {
      try {
        await applyScope(client as ScopedClient, scope);
      } catch (err) {
        client.release(err as Error);
        throw err;
      }
      return client;
    });
    if (!callback) return ready;
    ready.then((client) => callback(undefined, client, client.release), (err) => callback(err as Error));
  }
}

let pool: TenantPool | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export function getPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!pool) {
    if (!connectionString) {
      // Deliberately no default: silently connecting to a guessed database is
      // how a migration ends up running against the wrong environment.
      throw new Error(
        'DATABASE_URL is not set. For migrations/seeds set it in packages/db/.env ' +
        '(copy packages/db/.env.example); services read it from their own apps/*/.env.'
      );
    }
    pool = new TenantPool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  }
  return pool;
}

export function getDb() {
  if (!db) db = drizzle(getPool(), { schema });
  return db;
}

/** Used by health checks: a cheap round-trip that proves the pool is alive. Global. */
export async function pingDb(): Promise<boolean> {
  const result = await runWithoutTenant('health check', () => getPool().query('SELECT 1 as ok'));
  return result.rows[0]?.ok === 1;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

/* ── Startup guard: the app role must not skip row-level security ───────── */

export interface DbRoleInfo {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  /** Member of tupo_platform WITH INHERIT TRUE: the see-every-tenant policy applies to every query. */
  inheritsPlatform: boolean;
}

/** Who this pool connects as, and whether RLS binds that role. Global query. */
export async function checkDbRole(p: pg.Pool = getPool()): Promise<DbRoleInfo> {
  const { rows } = await runWithoutTenant('database role check', () => p.query<{
    role: string; superuser: boolean; bypass_rls: boolean; inherits_platform: boolean;
  }>(
    `SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls,
            COALESCE((SELECT pg_has_role(current_user, pr.oid, 'USAGE')
                        FROM pg_roles pr WHERE pr.rolname = $1), false) AS inherits_platform
       FROM pg_roles r WHERE r.rolname = current_user`,
    [PLATFORM_ROLE],
  ));
  const r = rows[0];
  if (!r) throw new Error('current_user is not in pg_roles');
  // A superuser "has" every role; report its own attributes, not the inheritance.
  return { role: r.role, superuser: r.superuser, bypassRls: r.bypass_rls, inheritsPlatform: !r.superuser && r.inherits_platform };
}

/** Why `info` makes tenant isolation unenforceable, or null when it is safe. */
export function unsafeDbRoleReason(info: DbRoleInfo): string | null {
  if (info.superuser) return `database role "${info.role}" is a SUPERUSER, which skips row-level security`;
  if (info.bypassRls) return `database role "${info.role}" has BYPASSRLS, which skips row-level security`;
  if (info.inheritsPlatform) return `database role "${info.role}" inherits ${PLATFORM_ROLE}, whose policy sees every tenant`;
  return null;
}

export class UnsafeDbRoleError extends Error {
  constructor(service: string, reason: string) {
    super(`[${service}] refusing to start: ${reason}. Tenant isolation (RLS) would be OFF. ` +
      'Connect as a non-superuser app role without BYPASSRLS (see apps/api/.env.example, "Database role").');
    this.name = 'UnsafeDbRoleError';
  }
}

/**
 * Check the connected role once at startup. TENANCY_MODE=enforce throws
 * UnsafeDbRoleError for a superuser / BYPASSRLS / platform-inheriting role
 * (the caller exits); shadow logs a loud warning and carries on. If the
 * database cannot be reached the check is retried in the background (enforce
 * then exits the process the moment it sees an unsafe role).
 */
export async function guardDbRole(
  service: string,
  opts: { pool?: pg.Pool; mode?: TenancyMode; retryMs?: number; onUnsafe?: (err: UnsafeDbRoleError) => void } = {},
): Promise<DbRoleInfo | null> {
  const mode = opts.mode ?? tenancyMode();
  let info: DbRoleInfo;
  try {
    info = await checkDbRole(opts.pool ?? getPool());
  } catch (err) {
    const retryMs = opts.retryMs ?? 30_000;
    console.warn(`[${service}] could not verify the database role (${err instanceof Error ? err.message : err}); retrying in ${retryMs / 1000}s`);
    setTimeout(() => {
      void guardDbRole(service, {
        ...opts,
        onUnsafe: opts.onUnsafe ?? ((e) => { console.error(e.message); process.exit(1); }),
      }).catch(() => { /* reported by onUnsafe */ });
    }, retryMs).unref();
    return null;
  }
  const reason = unsafeDbRoleReason(info);
  if (!reason) return info;
  if (mode === 'enforce') {
    const err = new UnsafeDbRoleError(service, reason);
    if (opts.onUnsafe) { opts.onUnsafe(err); return info; }
    throw err;
  }
  const bar = '!'.repeat(78);
  console.error(`${bar}\n[${service}] WARNING: ${reason}.\n[${service}] Row-level security does NOT isolate tenants on this connection.\n` +
    `[${service}] TENANCY_MODE=enforce will refuse to start like this. Use a non-superuser app role.\n${bar}`);
  return info;
}

export { schema };
