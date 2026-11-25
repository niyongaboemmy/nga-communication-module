/**
 * RLS coverage check (school isolation, defence in depth).
 *
 * Every school-owned table AND partition in `public` must be under
 *   ENABLE + FORCE ROW LEVEL SECURITY, with
 *   a `tenant_isolation` policy (PERMISSIVE, FOR ALL, TO PUBLIC) whose USING and
 *   WITH CHECK both reference tupo_tenant_id().
 * A table with no tenant_id column is allowed only if it is in GLOBAL_TABLES:
 * a new global table has to be added there on purpose.
 * Any other permissive policy that applies to PUBLIC must also reference
 * tupo_tenant_id() — an extra `USING (true)` policy would OR away the isolation.
 *
 * Read-only: it only reads the catalog, so it is safe to run against production
 * on every deploy (`npm run db:rls-check`, after `npm run db:migrate`).
 */

/** Tables with no tenant_id by design (0046, 0047). A new one must be added here on purpose. */
export const GLOBAL_TABLES: readonly string[] = ['_migrations', 'alert_state', 'link_previews', 'metric_samples', 'permissions', 'tenants'];

export const TENANT_POLICY = 'tenant_isolation';
const TENANT_FN = /\btupo_tenant_id\(\)/;

export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface RelationRow {
  relname: string;
  partition: boolean;
  rls: boolean;
  force: boolean;
  has_tenant: boolean;
}

export interface PolicyRow {
  tablename: string;
  policyname: string;
  permissive: string;
  roles: string[];
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

export interface RlsCoverageResult {
  ok: boolean;
  /** Tables/partitions with tenant_id that pass every rule. */
  covered: string[];
  /** One line per offending relation: `name: reason[, reason]`. */
  offenders: string[];
  /** Next month's messages_/meeting_events_ partitions and whether they exist yet. */
  nextMonth: Array<{ name: string; exists: boolean }>;
}

const refsTenant = (expr: string | null | undefined) => !!expr && TENANT_FN.test(expr);
const appliesToPublic = (roles: string[]) => roles.includes('public');

/** Pure rule evaluation over catalog rows (unit-tested without a database). */
export function evaluateRlsCoverage(
  relations: RelationRow[],
  policies: PolicyRow[],
  nextMonthNames: string[] = [],
  globalTables: readonly string[] = GLOBAL_TABLES,
): RlsCoverageResult {
  const byTable = new Map<string, PolicyRow[]>();
  for (const p of policies) byTable.set(p.tablename, [...(byTable.get(p.tablename) ?? []), p]);

  const covered: string[] = [];
  const offenders: string[] = [];
  const allow = new Set(globalTables);

  for (const r of [...relations].sort((a, b) => a.relname.localeCompare(b.relname))) {
    if (!r.has_tenant) {
      if (!allow.has(r.relname)) offenders.push(`${r.relname}: no tenant_id column and not in the global-table allowlist`);
      continue;
    }
    const reasons: string[] = [];
    if (!r.rls) reasons.push('row level security not enabled');
    if (!r.force) reasons.push('row level security not FORCEd');
    const pols = byTable.get(r.relname) ?? [];
    const tp = pols.find((p) => p.policyname === TENANT_POLICY);
    if (!tp) reasons.push(`no ${TENANT_POLICY} policy`);
    else {
      if (tp.permissive !== 'PERMISSIVE' || tp.cmd !== 'ALL' || !appliesToPublic(tp.roles)) {
        reasons.push(`${TENANT_POLICY} must be PERMISSIVE FOR ALL TO PUBLIC (is ${tp.permissive} FOR ${tp.cmd} TO ${tp.roles.join(',')})`);
      }
      if (!refsTenant(tp.qual)) reasons.push(`${TENANT_POLICY} USING does not reference tupo_tenant_id()`);
      if (!refsTenant(tp.with_check)) reasons.push(`${TENANT_POLICY} WITH CHECK does not reference tupo_tenant_id()`);
    }
    for (const p of pols) {
      if (p.policyname === TENANT_POLICY || p.permissive !== 'PERMISSIVE' || !appliesToPublic(p.roles)) continue;
      if (!refsTenant(p.qual) || (p.with_check !== null && !refsTenant(p.with_check))) {
        reasons.push(`permissive policy ${p.policyname} applies to PUBLIC without tupo_tenant_id()`);
      }
    }
    if (reasons.length) offenders.push(`${r.relname}${r.partition ? ' (partition)' : ''}: ${reasons.join('; ')}`);
    else covered.push(r.relname);
  }

  const names = new Set(relations.map((r) => r.relname));
  return { ok: offenders.length === 0, covered, offenders, nextMonth: nextMonthNames.map((name) => ({ name, exists: names.has(name) })) };
}

/** Reads the catalog of `public` and evaluates it. Works under any role (catalog reads are not subject to RLS). */
export async function checkRlsCoverage(db: Queryable, globalTables: readonly string[] = GLOBAL_TABLES): Promise<RlsCoverageResult> {
  const relations = (await db.query<RelationRow & Record<string, unknown>>(
    `SELECT c.relname, c.relispartition AS partition, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
            EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped) AS has_tenant
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`)).rows;
  const policies = (await db.query<PolicyRow & Record<string, unknown>>(
    `SELECT tablename::text, policyname::text, permissive, roles::text[] AS roles, cmd, qual, with_check
       FROM pg_policies WHERE schemaname = 'public'`)).rows;
  const month = (await db.query<{ m: string } & Record<string, unknown>>(
    `SELECT to_char(date_trunc('month', now()) + interval '1 month', 'YYYY_MM') AS m`)).rows[0]!.m;
  return evaluateRlsCoverage(relations, policies, [`messages_${month}`, `meeting_events_${month}`], globalTables);
}

/** The deploy-log lines for a result. */
export function formatRlsCoverage(r: RlsCoverageResult): string[] {
  const ok = new Set(r.covered);
  const next = r.nextMonth
    .map((p) => `${p.name} ${!p.exists ? 'not created yet (partitions:ensure makes it)' : ok.has(p.name) ? 'covered' : 'NOT covered'}`)
    .join(', ');
  const lines = [`RLS check: ${r.covered.length} tables/partitions covered, ${r.offenders.length} missing`];
  if (next) lines.push(`RLS check: next month ${next}`);
  for (const o of r.offenders) lines.push(`  ✗ ${o}`);
  return lines;
}
