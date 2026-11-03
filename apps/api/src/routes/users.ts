import { Router, type Request, type Response } from 'express';
import { getPool, activeUserSql } from '@tupo/db';
import { ok, fail } from '@tupo/shared';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { GOVERNANCE_KEYS, beyond, permissionKeysOfRole } from '../access/roleSafety.js';
import { emitToUsers, publishSessionEnd } from '../services/chatRealtime.js';
import { removeAllSubscriptions } from '@tupo/notify';
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

/* ── The roster (F-11) ────────────────────────────────────────────────────
 * Filtered, sorted and paged on the server, with a real total: the screen
 * used to ask for 50 rows and show them as if they were everyone.
 */

const SORTS: Record<string, string> = {
  name: 'u.name',
  last_login: 'u.last_login_at',
  role: 'r.name',
  status: 'u.status',
};

/**
 * ?status= for the roster. Default `active` (the shared active-user rule);
 * `inactive` = everyone else (suspended here or not active in NGA MIS);
 * `suspended` = suspended by a Tupo administrator; `all` = everyone.
 */
const ROSTER_STATUS: Record<string, string> = {
  active: activeUserSql('u'),
  inactive: `NOT ${activeUserSql('u')}`,
  suspended: `u.status = 'suspended'`,
  all: 'true',
};

interface RosterFilters { q: string; role: string; status: string; sort: string; dir: 'asc' | 'desc' }

/** The filters, or null when ?status= is not one we know. */
function rosterFilters(req: Request): RosterFilters | null {
  const sort = String(req.query.sort ?? 'name');
  const status = String(req.query.status ?? 'active').toLowerCase();
  if (!ROSTER_STATUS[status]) return null;
  return {
    q: String(req.query.q ?? '').trim().slice(0, 100),
    // A role id, "none" for unassigned, or empty for any.
    role: String(req.query.role ?? '').trim(),
    status,
    sort: SORTS[sort] ? sort : 'name',
    dir: req.query.dir === 'desc' ? 'desc' : 'asc',
  };
}

const BAD_STATUS = "status must be 'active', 'inactive', 'suspended' or 'all'.";

/** WHERE clause and parameters for a set of filters; `$1…` are used in order. */
function rosterWhere(f: RosterFilters, skip: Array<keyof RosterFilters> = []): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.q && !skip.includes('q')) {
    params.push(f.q);
    where.push(`(u.name ILIKE '%' || $${params.length} || '%' OR u.email ILIKE '%' || $${params.length} || '%')`);
  }
  if (f.role && !skip.includes('role')) {
    if (f.role === 'none') where.push('u.role_id IS NULL');
    else if (/^\d+$/.test(f.role)) { params.push(Number(f.role)); where.push(`u.role_id = $${params.length}`); }
  }
  if (!skip.includes('status')) where.push(ROSTER_STATUS[f.status]!);
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const ROSTER_COLUMNS = `u.id, u.mis_user_id, u.name, u.email, u.avatar_url, u.role, u.status,
            u.mis_status, ${activeUserSql('u')} AS active,
            u.role_assigned_by_admin, u.last_login_at,
            r.id AS role_id, r.name AS role_name, r.level AS role_level`;

function rosterOrder(f: RosterFilters): string {
  // Nulls last either way (never signed in, no role), then name as a tiebreak
  // so paging is stable.
  return `ORDER BY ${SORTS[f.sort]} ${f.dir.toUpperCase()} NULLS LAST, u.name ASC, u.id ASC`;
}

router.get('/', authorizePermission('USERS_VIEW', 'USERS_MANAGE'), async (req: Request, res: Response) => {
  const f = rosterFilters(req);
  if (!f) return res.status(400).json(fail(BAD_STATUS));
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const pool = getPool();
  const { sql, params } = rosterWhere(f);

  const { rows } = await pool.query(
    `SELECT ${ROSTER_COLUMNS}
       FROM users u LEFT JOIN roles r ON r.id = u.role_id
       ${sql} ${rosterOrder(f)}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  const { rows: totalRows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users u ${sql}`, params,
  );
  // Counts for the filter chips: everything but the status filter applies, so
  // each chip says how many it would show.
  const facetWhere = rosterWhere(f, ['status']);
  const { rows: facets } = await pool.query<{ active: number; inactive: number; suspended: number; unassigned: number; all: number }>(
    `SELECT count(*)::int AS all,
            count(*) FILTER (WHERE ${ROSTER_STATUS.active})::int AS active,
            count(*) FILTER (WHERE ${ROSTER_STATUS.inactive})::int AS inactive,
            count(*) FILTER (WHERE u.status = 'suspended')::int AS suspended,
            count(*) FILTER (WHERE u.role_id IS NULL)::int AS unassigned
       FROM users u ${facetWhere.sql}`,
    facetWhere.params,
  );
  return res.json({ ...ok(rows, { total: totalRows[0]?.n ?? 0 }), limit, offset, facets: facets[0] });
});

/**
 * The roles this administrator may hand out (F-11). Read under USERS_MANAGE
 * rather than borrowing the roles editor's permission: without it the
 * dropdown came up empty, and one stray change unassigned the person.
 */
router.get('/assignable-roles', authorizePermission('USERS_MANAGE'), async (req: Request, res: Response) => {
  const actor = (req as AuthenticatedRequest).user!;
  const { rows } = await getPool().query<{ id: number; name: string; level: string; keys: string[] | null; members: number }>(
    `SELECT r.id, r.name, r.level,
            array_remove(array_agg(DISTINCT p.key), NULL) AS keys,
            (SELECT count(*)::int FROM users u WHERE u.role_id = r.id) AS members
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
      GROUP BY r.id
      ORDER BY array_position(ARRAY['STUDENT','PARENT','STAFF','ADMIN'], r.level), r.name`,
  );
  return res.json(ok(rows.map((r) => {
    const keys = r.keys ?? [];
    return {
      id: r.id, name: r.name, level: r.level, members: r.members,
      permissionCount: keys.length,
      assignable: beyond(actor.permissions, keys).length === 0,
      grantsGovernance: GOVERNANCE_KEYS.some((k) => keys.includes(k)),
    };
  })));
});

/** A spreadsheet cell that cannot be read as a formula (CSV injection). */
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The filtered roster as CSV (F-11). Personal data leaving Tupo, so audited. */
router.get('/export.csv', authorizePermission('USERS_VIEW', 'USERS_MANAGE'), async (req: Request, res: Response) => {
  const actor = (req as AuthenticatedRequest).user!;
  const f = rosterFilters(req);
  if (!f) return res.status(400).json(fail(BAD_STATUS));
  const { sql, params } = rosterWhere(f);
  const { rows } = await getPool().query(
    `SELECT ${ROSTER_COLUMNS} FROM users u LEFT JOIN roles r ON r.id = u.role_id ${sql} ${rosterOrder(f)} LIMIT 20000`,
    params,
  );
  const header = ['Name', 'Email', 'MIS id', 'Role', 'Status', 'MIS status', 'Role set by admin', 'Last sign-in'];
  const lines = [header.join(',')].concat(rows.map((u) => [
    u.name, u.email, u.mis_user_id, u.role_name ?? 'Unassigned', u.status, u.mis_status ?? '',
    u.role_assigned_by_admin ? 'yes' : 'no',
    u.last_login_at ? new Date(u.last_login_at).toISOString() : '',
  ].map(csvCell).join(',')));
  await audit({
    actorId: actor.id, action: 'users.export', targetType: 'users',
    metadata: { rows: rows.length, filters: { q: f.q || undefined, role: f.role || undefined, status: f.status } },
    ipAddress: req.ip, userAgent: req.headers['user-agent'],
  });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tupo-users-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
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

  // Someone else changed it since this administrator's screen loaded (F-11):
  // say so rather than silently overwriting their decision.
  const expected = (req.body ?? {}).expectedRoleId;
  if (expected !== undefined && (expected ?? null) !== (userRows[0]!.role_id ?? null)) {
    return res.status(409).json({ ...fail('Someone else changed this person\'s role a moment ago. Reload to see it.'), code: 'ROLE_CHANGED' });
  }

  // An administrator removing their own last administrative role would lock
  // everyone out of role management, so refuse it.
  if (req.params.id === actor.id && roleId !== actor.roleId) {
    const { rows: admins } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.level = 'ADMIN' AND ${activeUserSql('u')} AND u.id <> $1`,
      [actor.id]
    );
    if (Number(admins[0]?.count ?? 0) === 0) {
      return res.status(409).json(fail(
        'You are the only active administrator. Promote someone else before changing your own role.'
      ));
    }
  }

  // Not more power than you hold, in either direction (A-10).
  const targetBeyond = beyond(actor.permissions, await permissionKeysOfRole(userRows[0]!.role_id));
  if (targetBeyond.length) {
    return res.status(403).json(fail('That person holds permissions you do not, so you cannot change their role.'));
  }
  const newBeyond = beyond(actor.permissions, await permissionKeysOfRole(roleId ?? null));
  if (newBeyond.length) {
    return res.status(403).json(fail('That role grants permissions you do not hold, so you cannot assign it.'));
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

  const names = await pool.query<{ id: number; name: string }>(
    'SELECT id, name FROM roles WHERE id = ANY($1::int[])',
    [[target.role_id, roleId].filter((x): x is number => typeof x === 'number')],
  );
  const nameOf = (id: number | null | undefined) => names.rows.find((r) => r.id === id)?.name ?? null;
  await audit({
    actorId: actor.id, action: 'user.role.assign', targetType: 'user', targetId: req.params.id,
    metadata: {
      from: target.role_id, to: roleId ?? null,
      // Names as they were at the time, so the log still reads after a rename (F-13).
      roleNameFrom: nameOf(target.role_id), roleNameTo: nameOf(roleId),
      roleFrom: target.role, roleTo: newRole,
      academicLevelFrom: target.academic_level, academicLevelTo: newAcademicLevel,
    },
    ipAddress: req.ip, userAgent: req.headers['user-agent'],
  });
  // Their open tabs re-read permissions now, not at the next sign-in (F-07).
  emitToUsers([String(req.params.id)], 'access:changed', { reason: 'role' });
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
  const { rows: who } = await getPool().query<{ role_id: number | null }>(
    'SELECT role_id FROM users WHERE id = $1', [req.params.id]);
  if (!who[0]) return res.status(404).json(fail('User not found.'));
  if (beyond(actor.permissions, await permissionKeysOfRole(who[0].role_id)).length) {
    return res.status(403).json(fail('That person holds permissions you do not, so you cannot change their status.'));
  }

  await getPool().query(
    'UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [req.params.id, status]
  );
  if (status === 'suspended') {
    // Suspension takes effect now, everywhere: every token issued before this
    // moment is refused (API, files, gateway) and live connections are dropped.
    await getPool().query(
      `INSERT INTO session_revocations (user_id, revoked_at) VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at`, [req.params.id]);
    publishSessionEnd([String(req.params.id)]);
    // And no more pushes to their devices.
    await removeAllSubscriptions(String(req.params.id)).catch(() => {});
  }

  if (status === 'active') emitToUsers([String(req.params.id)], 'access:changed', { reason: 'status' });
  await audit({
    actorId: actor.id, action: `user.${status}`, targetType: 'user', targetId: req.params.id,
    ipAddress: req.ip, userAgent: req.headers['user-agent'],
  });
  return res.json(ok({ userId: req.params.id, status }));
});

export default router;
