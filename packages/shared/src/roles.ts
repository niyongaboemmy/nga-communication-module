/**
 * Tupo's own roles. Deliberately NOT the same list as Discipline's — a
 * communication platform cares about who may broadcast and moderate, not
 * who may mark attendance.
 *
 * There is no 'guest' here yet; scoped guests arrive with FR-CHN-8.
 */
export type Role = 'admin' | 'staff' | 'student' | 'parent' | 'unassigned';

export const ROLES: readonly Role[] = ['admin', 'staff', 'student', 'parent', 'unassigned'] as const;

/**
 * Derive a Tupo role from the MIS permission strings.
 *
 * The NGA Central MIS is permission-based and returns no role field, so every
 * sibling app infers its role from what the user is allowed to do. Precedence
 * is most-privileged-first: someone who can administer the institution is an
 * admin even though they also hold teaching permissions.
 *
 * 'unassigned' is a real outcome, not a fallback to be papered over — an
 * unrecognised user gets no access until an administrator assigns a role,
 * rather than being silently treated as staff.
 */
export function roleFromPermissions(permissions: unknown): Role {
  const perms = (Array.isArray(permissions) ? permissions : []).map((p) => String(p).toUpperCase());
  const has = (...keywords: string[]) => perms.some((p) => keywords.some((k) => p.includes(k)));

  if (has('MANAGE_USER', 'MANAGE_ROLE', 'MANAGE_STAFF', 'MANAGE_SYSTEM', 'MANAGE_SCHOOL', 'ADMIN'))
    return 'admin';

  if (has('MARK_ATTENDANCE', 'TAKE_ATTENDANCE', 'MANAGE_ATTENDANCE', 'MANAGE_DISCIPLINE',
          'MANAGE_LESSON', 'CREATE_LESSON', 'MANAGE_RESULT', 'ENTER_RESULT', 'GRADE',
          'MANAGE_CLASS', 'MANAGE_STUDENT', 'TEACHER', 'STAFF'))
    return 'staff';

  if (has('PARENT', 'GUARDIAN')) return 'parent';

  if (has('STUDENT', 'VIEW_RESULTS', 'VIEW_ATTENDANCE', 'VIEW_STUDENT_CALENDAR', 'VIEW_LESSON'))
    return 'student';

  return 'unassigned';
}

/** Fallback for a MIS that ever starts sending an explicit role field. */
export function roleFromMisUser(misUser: unknown): Role {
  const u = (misUser ?? {}) as Record<string, unknown>;
  const raw = [u.role, u.role_name, u.type, u.user_type, u.role_code, u.user_role]
    .map((f) => (f && typeof f === 'object' ? JSON.stringify(f) : String(f ?? '')))
    .join(' ')
    .toLowerCase();

  if (raw.includes('admin')) return 'admin';
  if (raw.includes('teacher') || raw.includes('staff') || raw.includes('instructor') || raw.includes('faculty'))
    return 'staff';
  if (raw.includes('parent') || raw.includes('guardian')) return 'parent';
  if (raw.includes('student') || raw.includes('learner') || raw.includes('pupil')) return 'student';
  return 'unassigned';
}

/** Permissions first, explicit role field second. */
export function resolveMisRole(misUser: unknown, permissions: unknown): Role {
  const fromPerms = roleFromPermissions(permissions);
  return fromPerms !== 'unassigned' ? fromPerms : roleFromMisUser(misUser);
}

/**
 * The seeded system role a derived role maps onto.
 *
 * `role` (lowercase) is the coarse label carried in the session; `role_id`
 * points at a row in `roles` that actually carries the permission set. An
 * 'unassigned' user gets no role row at all and therefore no permissions —
 * they see a "pending access" screen until an administrator assigns one.
 */
export const SYSTEM_ROLE_NAME_FOR: Record<Exclude<Role, 'unassigned'>, string> = {
  admin: 'Admin',
  staff: 'Staff',
  student: 'Student',
  parent: 'Parent',
};
