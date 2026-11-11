import type { Pool } from 'pg';
import {
  PRIMARY_TENANT_ID, effectiveTid, normalizeTenant, runWithTenant, runWithoutTenant,
  setLocalTenantLoader, type TenantCtx,
} from '@tupo/tenancy';
import { getPool } from './pool.js';
import { snowflake } from './snowflake.js';
import { seedRbac } from './rbac.js';

/**
 * Tenants as Tupo sees them (multi-tenancy Phase 6, contract §4/§5).
 *
 * MIS is the control plane. The `tenants` table (0046, global, no RLS) is
 * Tupo's record of which schools it has provisioned, and what the registry
 * falls back to when MIS cannot be reached.
 */

/** Rows of the local `tenants` table as contract contexts. */
export async function loadLocalTenants(pool: Pool = getPool()): Promise<TenantCtx[]> {
  const { rows } = await runWithoutTenant('tenant registry (local)', () => pool.query<Record<string, unknown>>(
    'SELECT tid, slug, name, status, is_primary, timezone, pkg FROM tenants ORDER BY tid'));
  return rows.map((r) => normalizeTenant(r)).filter((t): t is TenantCtx => t !== null);
}

// The registry in @tupo/tenancy reads this table when MIS is unreachable.
setLocalTenantLoader(() => loadLocalTenants());

/**
 * The id of the space that holds subject channels. Tenant 1 keeps the row
 * 0030 created (`subjects`); spaces.id is a global key, so every other tenant
 * gets its own (`subjects-t<tid>`, slug `subjects`).
 */
export function subjectSpaceId(tid: number = effectiveTid('subject space')): string {
  return tid === PRIMARY_TENANT_ID ? 'subjects' : `subjects-t${tid}`;
}

export interface SeedTenantResult {
  tid: number;
  /** True when this call registered the tenant for the first time. */
  created: boolean;
  spaces: number;
  pages: number;
  roles: number;
}

/**
 * Create (or top up) everything a school needs before its first sign-in:
 * the four spaces, the default feed pages (named after the school, not NGA)
 * and the system roles with their default permission sets.
 *
 * Idempotent: running it again only adds what is missing. It never replaces
 * an existing tenant's role grants -- an administrator may have customised
 * them -- and so it never re-seeds tenant 1 destructively.
 */
export async function seedTenant(tenant: TenantCtx, pool: Pool = getPool()): Promise<SeedTenantResult> {
  const { rows: reg } = await runWithoutTenant('tenant provisioning', () => pool.query<{ created: boolean }>(
    `INSERT INTO tenants (tid, slug, name, status, is_primary, timezone, pkg, provisioned_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (tid) DO UPDATE
       SET slug = EXCLUDED.slug, name = EXCLUDED.name, status = EXCLUDED.status,
           timezone = EXCLUDED.timezone, pkg = EXCLUDED.pkg, updated_at = now(),
           provisioned_at = COALESCE(tenants.provisioned_at, now())
     RETURNING (xmax = 0) AS created`,
    [tenant.tid, tenant.slug, tenant.name, tenant.status, tenant.tid === PRIMARY_TENANT_ID,
      tenant.timezone, tenant.pkg]));
  const created = Boolean(reg[0]?.created);

  return runWithTenant(tenant, async () => {
    const school = tenant.name || tenant.slug;
    const spaces = [
      { id: snowflake(), slug: 'staff', name: `${school} Staff`, description: 'Teaching and administrative staff' },
      { id: snowflake(), slug: 'students', name: `${school} Students`, description: 'Enrolled learners' },
      { id: snowflake(), slug: 'parents', name: `${school} Parents`, description: 'Parents and guardians' },
      { id: subjectSpaceId(tenant.tid), slug: 'subjects', name: `${school} Subjects`, description: 'Subject channels, one set per subject.' },
    ];
    let spaceCount = 0;
    for (const s of spaces) {
      const res = await pool.query(
        `INSERT INTO spaces (id, slug, name, description) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, slug) DO NOTHING`,
        [s.id, s.slug, s.name, s.description]);
      spaceCount += res.rowCount ?? 0;
    }

    const { rows: adminRows } = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`);
    const ownerId = adminRows[0]?.id ?? null;
    const official = `${tenant.slug}-official`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const pages = [
      { slug: tenant.tid === PRIMARY_TENANT_ID ? 'nga-official' : official, name: `${school} Official`, kind: 'official', mandatory: true, verified: true, accent: '#2563eb', bio: `Official announcements from ${school}.` },
      { slug: 'academics', name: 'Academics & Exams', kind: 'official', mandatory: false, verified: true, accent: '#7c3aed', bio: 'Timetables, exam news, results and study resources.' },
      { slug: 'sports-clubs', name: 'Sports & Clubs', kind: 'club', mandatory: false, verified: false, accent: '#0d9488', bio: 'Fixtures, results, and everything the clubs are up to.' },
    ];
    let pageCount = 0;
    for (const p of pages) {
      const res = await pool.query<{ id: string }>(
        `INSERT INTO feed_pages (id, slug, name, bio, kind, audience, verified, mandatory, accent, created_by)
         VALUES ($1,$2,$3,$4,$5,'everyone',$6,$7,$8,$9)
         ON CONFLICT (tenant_id, lower(slug)) WHERE deleted_at IS NULL DO NOTHING
         RETURNING id`,
        [snowflake(), p.slug, p.name, p.bio, p.kind, p.verified, p.mandatory, p.accent, ownerId]);
      pageCount += res.rowCount ?? 0;
      if (res.rows[0] && ownerId) {
        await pool.query(
          `INSERT INTO feed_page_editors (page_id, user_id, role, added_by) VALUES ($1,$2,'owner',$2)
           ON CONFLICT DO NOTHING`, [res.rows[0].id, ownerId]);
      }
    }

    const rbac = await seedRbac(pool, { onlyMissingRoles: true });
    return { tid: tenant.tid, created, spaces: spaceCount, pages: pageCount, roles: rbac.rolesCreated };
  });
}

const provisioned = new Set<number>();

/**
 * Make sure a tenant has been seeded before its first user lands (an SSO
 * sign-in for a school MIS created but whose provisioning call never reached
 * Tupo). Cheap after the first call per process.
 */
export async function ensureTenantProvisioned(tenant: TenantCtx, pool: Pool = getPool()): Promise<void> {
  if (provisioned.has(tenant.tid)) return;
  const { rows } = await runWithoutTenant('tenant provisioning check', () => pool.query(
    'SELECT 1 FROM tenants WHERE tid = $1 AND provisioned_at IS NOT NULL', [tenant.tid]));
  if (!rows.length) await seedTenant(tenant, pool);
  provisioned.add(tenant.tid);
}

/** Tests only. */
export function __forgetProvisioned(): void {
  provisioned.clear();
}
