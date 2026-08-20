import { Router, type Request, type Response } from 'express';
import { getPool } from '@tupo/db';
import {
  ok, fail, PERMISSIONS, PERMISSION_KEYS, PERMISSION_CATEGORIES,
  CATEGORY_ORDER, groupPermissionsByCategory,
} from '@tupo/shared';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { audit } from '../services/userService.js';

const router = Router();
router.use(authMiddleware);

const VALID_LEVELS = ['STUDENT', 'PARENT', 'STAFF', 'ADMIN'];

/**
 * The caller's own resolved role and permissions, straight from what
 * authMiddleware just computed. Lets the frontend re-sync after an
 * administrator changes a role, without forcing a re-login.
 */
router.get('/me', (req: Request, res: Response) => {
  const user = (req as AuthenticatedRequest).user!;
  return res.json(ok({
    roleId: user.roleId,
    roleName: user.roleName,
    roleLevel: user.roleLevel,
    permissionKeys: Array.from(user.permissions).sort(),
  }));
});

/** The full permission catalog, grouped by category, for the admin matrix. */
router.get('/permissions', (_req: Request, res: Response) => {
  return res.json(ok({
    categories: PERMISSION_CATEGORIES,
    categoryOrder: CATEGORY_ORDER,
    grouped: groupPermissionsByCategory(),
    all: PERMISSIONS,
  }));
});

async function loadRole(id: number) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, name, level, description, is_system, created_at, updated_at FROM roles WHERE id = $1`,
    [id]
  );
  const role = rows[0];
  if (!role) return null;

  const { rows: perms } = await pool.query<{ key: string }>(
    `SELECT p.key FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1 ORDER BY p.key`,
    [id]
  );
  const { rows: counts } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM users WHERE role_id = $1', [id]
  );

  return {
    ...role,
    isSystem: role.is_system,
    permissionKeys: perms.map((p) => p.key),
    userCount: Number(counts[0]?.count ?? 0),
  };
}

router.get('/roles',
  authorizePermission('ROLES_PERMISSIONS_VIEW', 'ROLES_PERMISSIONS_MANAGE'),
  async (_req: Request, res: Response) => {
    const { rows } = await getPool().query<{ id: number }>(
      `SELECT id FROM roles
        ORDER BY array_position(ARRAY['STUDENT','PARENT','STAFF','ADMIN'], level), name`
    );
    const full = await Promise.all(rows.map((r) => loadRole(r.id)));
    return res.json(ok(full));
  });

router.get('/roles/:id',
  authorizePermission('ROLES_PERMISSIONS_VIEW', 'ROLES_PERMISSIONS_MANAGE'),
  async (req: Request, res: Response) => {
    const role = await loadRole(Number(req.params.id));
    if (!role) return res.status(404).json(fail('Role not found.'));
    return res.json(ok(role));
  });

/** Reject unknown keys outright rather than silently dropping them — a typo in
 *  a permission key must not quietly produce a role with less access than the
 *  administrator believes they granted. */
function validatePermissionKeys(keys: unknown): string[] | null {
  if (!Array.isArray(keys)) return null;
  const unique = Array.from(new Set(keys.map(String)));
  if (unique.some((k) => !PERMISSION_KEYS.has(k))) return null;
  return unique;
}

async function replacePermissions(roleId: number, keys: string[]): Promise<void> {
  const pool = getPool();
  await pool.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
  if (keys.length > 0) {
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, id FROM permissions WHERE key = ANY($2::text[])`,
      [roleId, keys]
    );
  }
}

router.post('/roles',
  authorizePermission('ROLES_PERMISSIONS_MANAGE'),
  async (req: Request, res: Response) => {
    const actor = (req as AuthenticatedRequest).user!;
    const { name, level, description } = req.body ?? {};
    const permissionKeys = validatePermissionKeys(req.body?.permissionKeys ?? []);

    if (!name || String(name).trim().length === 0 || String(name).length > 60) {
      return res.status(400).json(fail('Role name is required (max 60 characters).'));
    }
    if (!level || !VALID_LEVELS.includes(level)) {
      return res.status(400).json(fail(`level must be one of: ${VALID_LEVELS.join(', ')}.`));
    }
    if (permissionKeys === null) {
      return res.status(400).json(fail('permissionKeys must be an array of valid permission keys.'));
    }

    const pool = getPool();
    const { rows: existing } = await pool.query('SELECT id FROM roles WHERE name = $1', [name]);
    if (existing.length > 0) {
      return res.status(409).json(fail('A role with that name already exists.'));
    }

    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO roles (name, level, description, is_system)
       VALUES ($1, $2, $3, false) RETURNING id`,
      [String(name).trim(), level, description ?? null]
    );
    const roleId = rows[0]!.id;
    await replacePermissions(roleId, permissionKeys);

    await audit({
      actorId: actor.id, action: 'role.create', targetType: 'role', targetId: String(roleId),
      metadata: { name, level, permissionKeys }, ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });
    return res.json(ok(await loadRole(roleId)));
  });

/** The level is immutable after creation — it is load-bearing for navigation
 *  and default routing, and changing it under existing users would silently
 *  move them between experiences. */
router.put('/roles/:id',
  authorizePermission('ROLES_PERMISSIONS_MANAGE'),
  async (req: Request, res: Response) => {
    const actor = (req as AuthenticatedRequest).user!;
    const id = Number(req.params.id);
    const { name, description } = req.body ?? {};
    const keysProvided = req.body?.permissionKeys !== undefined;
    const permissionKeys = keysProvided ? validatePermissionKeys(req.body.permissionKeys) : [];

    if (keysProvided && permissionKeys === null) {
      return res.status(400).json(fail('permissionKeys must be an array of valid permission keys.'));
    }

    const role = await loadRole(id);
    if (!role) return res.status(404).json(fail('Role not found.'));

    // System roles keep their identity (a renamed 'Admin' would break the SSO
    // role mapping) but their permission sets remain editable.
    if (role.isSystem && name !== undefined && name !== role.name) {
      return res.status(400).json(fail('A system role cannot be renamed.'));
    }

    const pool = getPool();
    await pool.query(
      `UPDATE roles SET name = COALESCE($2, name), description = COALESCE($3, description),
                        updated_at = now()
        WHERE id = $1`,
      [id, name ?? null, description ?? null]
    );
    if (keysProvided) await replacePermissions(id, permissionKeys!);

    await audit({
      actorId: actor.id, action: 'role.update', targetType: 'role', targetId: String(id),
      metadata: { name, permissionKeys: keysProvided ? permissionKeys : undefined },
      ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });
    return res.json(ok(await loadRole(id)));
  });

router.delete('/roles/:id',
  authorizePermission('ROLES_PERMISSIONS_MANAGE'),
  async (req: Request, res: Response) => {
    const actor = (req as AuthenticatedRequest).user!;
    const id = Number(req.params.id);
    const role = await loadRole(id);

    if (!role) return res.status(404).json(fail('Role not found.'));
    if (role.isSystem) return res.status(400).json(fail('System roles cannot be deleted.'));
    if (role.userCount > 0) {
      return res.status(409).json(fail(
        `${role.userCount} user(s) still hold this role. Reassign them before deleting it.`
      ));
    }

    await getPool().query('DELETE FROM roles WHERE id = $1', [id]);
    await audit({
      actorId: actor.id, action: 'role.delete', targetType: 'role', targetId: String(id),
      metadata: { name: role.name }, ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });
    return res.json(ok({ deleted: true }));
  });

export default router;
