import { Router, type Request, type Response } from 'express';
import { getPool } from '@tupo/db';
import { ok, fail } from '@tupo/shared';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import {
  audit, getUserTheme, setUserTheme, roleLabelForLevel, academicLevelFromPlacement,
} from '../services/userService.js';
import { fetchMisTheme, updateMisTheme } from '../services/misClient.js';

const router = Router();
router.use(authMiddleware);

/**
 * The caller's appearance preference, read back from the MIS so a change made
 * in the MIS — or in TaskMentor, or Discipline & Attendance — shows up here
 * too. The MIS is the single source of truth for this across the app family.
 *
 * Falls back to Tupo's stored copy when the MIS cannot be reached, so a blip
 * never flips a dark-mode user back to light.
 */
router.get('/me/theme', async (req: Request, res: Response) => {
  const actor = (req as AuthenticatedRequest).user!;
  const local = await getUserTheme(actor.id);

  const misTheme = actor.misToken ? await fetchMisTheme(actor.misToken) : null;
  if (misTheme && misTheme !== local) {
    // The MIS moved on without us; adopt it so the local copy stays usable
    // as the offline fallback.
    await setUserTheme(actor.id, misTheme);
  }

  return res.json(ok({ theme: misTheme ?? local ?? 'light', source: misTheme ? 'mis' : 'local' }));
});

/**
 * Save the caller's appearance preference — locally first, then up to the MIS
 * (`PATCH /users/me/theme`) so the rest of the NGA apps pick it up.
 *
 * The MIS leg is best-effort: `misSynced: false` tells the client the choice is
 * saved but has not propagated yet. Failing the whole request over an
 * unreachable MIS would make a theme toggle feel broken.
 */
router.patch('/me/theme', async (req: Request, res: Response) => {
  const actor = (req as AuthenticatedRequest).user!;
  const theme = String(req.body?.theme ?? '');
  if (theme !== 'light' && theme !== 'dark') {
    return res.status(400).json(fail("theme must be 'light' or 'dark'."));
  }

  await setUserTheme(actor.id, theme);
  const misSynced = actor.misToken ? await updateMisTheme(actor.misToken, theme) : false;

  return res.json(ok({ theme, misSynced }));
});

/** The roster, with each user's current role. */
router.get('/', authorizePermission('USERS_VIEW', 'USERS_MANAGE'), async (req: Request, res: Response) => {
  const search = String(req.query.q ?? '').trim();
  const limit = Math.min(Number(req.query.limit ?? 50), 200);

  const { rows } = await getPool().query(
    `SELECT u.id, u.mis_user_id, u.name, u.email, u.avatar_url, u.role, u.status,
            u.role_assigned_by_admin, u.last_login_at,
            r.id AS role_id, r.name AS role_name, r.level AS role_level
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE ($1 = '' OR u.name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%')
      ORDER BY (u.role_id IS NULL) DESC, u.name
      LIMIT $2`,
    [search, limit]
  );
  return res.json(ok(rows, { total: rows.length }));
});

/**
 * Assign a role. Once an administrator does this the choice becomes sticky:
 * `role_assigned_by_admin` stops the next MIS login from recomputing the role
 * from MIS permissions and silently undoing the decision.
 */
router.put('/:id/role', authorizePermission('USERS_MANAGE'), async (req: Request, res: Response) => {
  const actor = (req as AuthenticatedRequest).user!;
  const { roleId } = req.body ?? {};
  const pool = getPool();

  const { rows: userRows } = await pool.query<{
    id: string; role_id: number | null; role: string; academic_level: string | null;
    mis_program_ids: string[]; mis_grade_ids: string[]; mis_class_group_ids: string[];
  }>(
    `SELECT id, role_id, role, academic_level, mis_program_ids, mis_grade_ids, mis_class_group_ids
       FROM users WHERE id = $1`,
    [req.params.id]
  );
  if (userRows.length === 0) return res.status(404).json(fail('User not found.'));

  // An administrator removing their own last administrative role would lock
  // everyone out of role management, so refuse it.
  if (req.params.id === actor.id && roleId !== actor.roleId) {
    const { rows: admins } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.level = 'ADMIN' AND u.status = 'active' AND u.id <> $1`,
      [actor.id]
    );
    if (Number(admins[0]?.count ?? 0) === 0) {
      return res.status(409).json(fail(
        'You are the only active administrator. Promote someone else before changing your own role.'
      ));
    }
  }

  let roleLevel: string | null = null;
  if (roleId !== null && roleId !== undefined) {
    const { rows: roleRows } = await pool.query<{ id: number; level: string }>(
      'SELECT id, level FROM roles WHERE id = $1', [roleId]
    );
    if (roleRows.length === 0) return res.status(400).json(fail('That role does not exist.'));
    roleLevel = roleRows[0]!.level;
  }

  // Keep the coarse `users.role` label and the dashboard's `academic_level` in
  // step with the new role row: both are read directly (dashboard scope, chat
  // contact rules, feed audiences), so leaving them stale would let a demoted
  // administrator keep an administrator's reach.
  const target = userRows[0]!;
  const newRole = roleLabelForLevel(roleLevel);
  let newAcademicLevel = target.academic_level;
  if (newRole === 'admin') {
    newAcademicLevel = 'super_admin';
  } else if (target.academic_level === 'super_admin') {
    newAcademicLevel = academicLevelFromPlacement(newRole, {
      programIds: target.mis_program_ids ?? [],
      gradeIds: target.mis_grade_ids ?? [],
      classGroupIds: target.mis_class_group_ids ?? [],
    });
  }

  await pool.query(
    `UPDATE users SET role_id = $2, role_assigned_by_admin = $3, role = $4, academic_level = $5,
                      updated_at = now()
      WHERE id = $1`,
    [req.params.id, roleId ?? null, roleId !== null && roleId !== undefined, newRole, newAcademicLevel]
  );

  await audit({
    actorId: actor.id, action: 'user.role.assign', targetType: 'user', targetId: req.params.id,
    metadata: {
      from: target.role_id, to: roleId ?? null,
      roleFrom: target.role, roleTo: newRole,
      academicLevelFrom: target.academic_level, academicLevelTo: newAcademicLevel,
    },
    ipAddress: req.ip, userAgent: req.headers['user-agent'],
  });
  return res.json(ok({ userId: req.params.id, roleId: roleId ?? null }));
});

router.put('/:id/status', authorizePermission('USERS_MANAGE'), async (req: Request, res: Response) => {
  const actor = (req as AuthenticatedRequest).user!;
  const status = String(req.body?.status ?? '');
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json(fail("status must be 'active' or 'suspended'."));
  }
  if (req.params.id === actor.id && status === 'suspended') {
    return res.status(400).json(fail('You cannot suspend your own account.'));
  }

  const { rowCount } = await getPool().query(
    'UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [req.params.id, status]
  );
  if (!rowCount) return res.status(404).json(fail('User not found.'));

  await audit({
    actorId: actor.id, action: `user.${status}`, targetType: 'user', targetId: req.params.id,
    ipAddress: req.ip, userAgent: req.headers['user-agent'],
  });
  return res.json(ok({ userId: req.params.id, status }));
});

export default router;
