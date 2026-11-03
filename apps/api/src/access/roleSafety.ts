import { getPool } from '@tupo/db';

/**
 * Role safety (A-10): nobody can hand out, or take control over, more power
 * than they hold themselves.
 *
 *   - You may assign a role only if you hold every permission it grants.
 *   - You may change the role or status of someone only if you hold every
 *     permission *their current* role grants — a user manager cannot demote
 *     or suspend an administrator.
 *   - You may grant a permission to a role only if you hold it.
 *   - Role management can never be locked: the last way to manage roles and
 *     users is never removed from the Admin role or from your own.
 */

export const GOVERNANCE_KEYS = ['ROLES_PERMISSIONS_MANAGE', 'USERS_MANAGE'] as const;

export async function permissionKeysOfRole(roleId: number | null | undefined): Promise<string[]> {
  if (roleId === null || roleId === undefined) return [];
  const { rows } = await getPool().query<{ key: string }>(
    `SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1`,
    [roleId],
  );
  return rows.map((r) => r.key);
}

/** The permissions in `keys` that `held` does not include. */
export function beyond(held: Set<string>, keys: string[]): string[] {
  return keys.filter((k) => !held.has(k));
}
