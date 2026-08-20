import type { Pool } from 'pg';
import {
  PERMISSIONS, SYSTEM_ROLES, DEFAULT_ROLE_PERMISSIONS,
} from '@tupo/shared';

/**
 * Seed the permission catalog and the system roles.
 *
 * Runs on every boot and on `npm run db:seed`, and is idempotent by design:
 * new permissions added to the catalog appear automatically, descriptions and
 * categories are refreshed, and **system** role permission sets are re-applied
 * so a code change to DEFAULT_ROLE_PERMISSIONS actually takes effect.
 *
 * Custom roles created by administrators are never touched.
 */
export async function seedRbac(pool: Pool): Promise<{
  permissions: number; roles: number; removed: number;
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ---- permissions -----------------------------------------------------
    for (const p of PERMISSIONS) {
      await client.query(
        `INSERT INTO permissions (key, category, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE
           SET category = EXCLUDED.category, description = EXCLUDED.description`,
        [p.key, p.category, p.description]
      );
    }

    // Retire permissions dropped from the catalog, so a removed key cannot
    // linger on a role and silently keep granting access.
    const keys = PERMISSIONS.map((p) => p.key);
    const { rowCount: removed } = await client.query(
      `DELETE FROM permissions WHERE key <> ALL($1::text[])`, [keys]
    );

    // ---- roles -----------------------------------------------------------
    for (const role of SYSTEM_ROLES) {
      await client.query(
        `INSERT INTO roles (name, level, description, is_system)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (name) DO UPDATE
           SET level = EXCLUDED.level,
               description = EXCLUDED.description,
               is_system = true,
               updated_at = now()`,
        [role.name, role.level, role.description]
      );

      const { rows } = await client.query<{ id: number }>(
        'SELECT id FROM roles WHERE name = $1', [role.name]
      );
      const roleId = rows[0]!.id;
      const grants = DEFAULT_ROLE_PERMISSIONS[role.name] ?? [];

      // Replace rather than merge: the catalog is the source of truth for
      // system roles, so a permission removed in code is removed here too.
      await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
      if (grants.length > 0) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT $1, id FROM permissions WHERE key = ANY($2::text[])`,
          [roleId, grants]
        );
      }
    }

    await client.query('COMMIT');
    return { permissions: PERMISSIONS.length, roles: SYSTEM_ROLES.length, removed: removed ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface ResolvedRole {
  roleId: number | null;
  roleName: string | null;
  roleLevel: string | null;
  permissions: Set<string>;
}

/**
 * Look up a user's current role and permission set straight from the database.
 *
 * Returns `null` when the user row does not exist at all — a dangling session,
 * which the caller turns into a 401. That is deliberately distinct from a user
 * who exists with no role (`role_id IS NULL`): they get an empty permission set
 * and the usual 403s, which is what drives the "pending access" screen.
 */
export async function resolveUserPermissions(
  pool: Pool, userId: string
): Promise<ResolvedRole | null> {
  const { rows: userRows } = await pool.query<{ role_id: number | null }>(
    'SELECT role_id FROM users WHERE id = $1', [userId]
  );
  if (userRows.length === 0) return null;

  const roleId = userRows[0]!.role_id;
  if (roleId === null) {
    return { roleId: null, roleName: null, roleLevel: null, permissions: new Set() };
  }

  const { rows } = await pool.query<{ name: string; level: string; key: string | null }>(
    `SELECT r.name, r.level, p.key
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
      WHERE r.id = $1`,
    [roleId]
  );
  if (rows.length === 0) {
    // Role row vanished (deleted concurrently) — treat as unassigned.
    return { roleId: null, roleName: null, roleLevel: null, permissions: new Set() };
  }

  return {
    roleId,
    roleName: rows[0]!.name,
    roleLevel: rows[0]!.level,
    permissions: new Set(rows.map((r) => r.key).filter((k): k is string => k !== null)),
  };
}

/** Resolve the id of a seeded system role by name. */
export async function systemRoleIdByName(pool: Pool, name: string): Promise<number | null> {
  const { rows } = await pool.query<{ id: number }>(
    'SELECT id FROM roles WHERE name = $1', [name]
  );
  return rows[0]?.id ?? null;
}
