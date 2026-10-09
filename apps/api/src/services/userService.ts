import { getPool, snowflake, systemRoleIdByName } from '@tupo/db';
import { SYSTEM_ROLE_NAME_FOR } from '@tupo/shared';
import type { Role, SessionUser } from '@tupo/shared';

/**
 * Create or update the local projection of a MIS identity.
 *
 * Role precedence, matching the sibling apps:
 *   1. A bootstrap admin (config allowlist) always wins — the owner can never
 *      lock themselves out.
 *   2. Otherwise a role an administrator assigned by hand is sticky.
 *   3. Otherwise the role derived from MIS permissions is used.
 *
 * The derived role also decides which `roles` row the user is attached to, and
 * therefore which permissions they hold. A role an administrator set by hand is
 * never overwritten by a later login.
 *
 * Note what is NOT written here: no credential of any kind. The user row is a
 * mirror, not an account.
 */
/**
 * The MIS academic placement carried on every login, so the admin dashboard can
 * scope activity to a programme or a grade without a live MIS call. See
 * migration 0023 and routes/dashboard.ts.
 */
export type AcademicLevel =
  'super_admin' | 'program_lead' | 'class_teacher' | 'staff' | 'student' | 'parent' | 'none';

export interface MisAcademic {
  level: AcademicLevel;
  /**
   * The level the MIS placement alone implies, ignoring a MIS SUPER_ADMIN role
   * (and forced admin). Used when an administrator has pinned the person to a
   * non-admin Tupo role: their MIS super-admin status must not re-promote them
   * to an unrestricted dashboard scope. Optional so older callers still work.
   */
  placementLevel?: AcademicLevel;
  /**
   * Programme membership: the programmes the person belongs to, including the
   * programme of a class teacher's grade. What OTHER viewers match against.
   */
  programIds: string[];
  /**
   * Programmes the person LEADS (MIS assignedPrograms) — their own dashboard
   * scope. Kept apart from `programIds` so a class teacher's scope is not
   * widened to their whole programme. Optional for older callers (stored NULL).
   */
  leadProgramIds?: string[];
  gradeIds: string[];
  classGroupIds: string[];
  programNames: string[];
  gradeNames: string[];
  classGroupNames: string[];
}

const EMPTY_ACADEMIC: MisAcademic = {
  level: 'none',
  programIds: [], gradeIds: [], classGroupIds: [],
  programNames: [], gradeNames: [], classGroupNames: [],
};

/**
 * The coarse `users.role` label for an RBAC role level. `users.role` is still
 * read directly by the dashboard scope, chat's contact rules and the feed, so
 * it has to follow `role_id` whenever an administrator changes it.
 */
export function roleLabelForLevel(level: string | null | undefined): Role {
  switch (String(level ?? '').toUpperCase()) {
    case 'ADMIN': return 'admin';
    case 'STAFF': return 'staff';
    case 'STUDENT': return 'student';
    case 'PARENT': return 'parent';
    default: return 'unassigned';
  }
}

/**
 * The academic level implied by the stored MIS placement arrays alone, for a
 * person who is not (or is no longer) a Tupo administrator.
 *
 * `mis_program_ids` also carries the programme of every class-teacher grade,
 * so it cannot tell a programme lead from a class teacher. When grades are
 * present we therefore pick the narrower `class_teacher` — under-scoping is
 * safe, over-scoping is not — and the person's next MIS login restores the
 * precise level from the live payload.
 */
export function academicLevelFromPlacement(
  role: Role,
  placement: { programIds: string[]; gradeIds: string[]; classGroupIds: string[] },
): AcademicLevel {
  if (role === 'admin') return 'super_admin';
  if (placement.gradeIds.length > 0 || placement.classGroupIds.length > 0) return 'class_teacher';
  if (placement.programIds.length > 0) return 'program_lead';
  if (role === 'staff' || role === 'student' || role === 'parent') return role;
  return 'none';
}

export async function upsertMisUser(params: {
  misUserId: string;
  name: string;
  email: string;
  /** undefined = keep the stored picture; null = MIS says there is none. */
  avatarUrl?: string | null;
  derivedRole: Role;
  preferredTheme?: 'light' | 'dark';
  forceAdmin: boolean;
  academic?: MisAcademic;
}): Promise<SessionUser> {
  const pool = getPool();
  const { rows: existingRows } = await pool.query<{
    id: string; role: Role; role_assigned_by_admin: boolean; pinned_level: string | null;
  }>(
    `SELECT u.id, u.role, u.role_assigned_by_admin, r.level AS pinned_level
       FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.mis_user_id = $1`,
    [params.misUserId]
  );
  const existing = existingRows[0];

  // A pinned role's label is read from the role row it points at, not from the
  // text column: rows demoted before the role-change route kept `users.role`
  // in sync could still say 'admin' here, and must not be re-promoted.
  const pinnedRole: Role | undefined = existing?.role_assigned_by_admin
    ? (existing.pinned_level ? roleLabelForLevel(existing.pinned_level) : existing.role)
    : undefined;

  const finalRole: Role = params.forceAdmin
    ? 'admin'
    : pinnedRole ?? params.derivedRole;

  // Resolve the RBAC role row that carries the actual permission set.
  // 'unassigned' deliberately maps to NULL: the user exists but holds nothing
  // until an administrator grants a role.
  const roleName = finalRole === 'unassigned' ? null : SYSTEM_ROLE_NAME_FOR[finalRole];
  const derivedRoleId = roleName ? await systemRoleIdByName(pool, roleName) : null;

  const ac = params.academic ?? EMPTY_ACADEMIC;
  // A forced/derived Tupo admin outranks whatever the MIS placement says.
  // Conversely, someone an administrator pinned to a non-admin role must not
  // be lifted back to an unrestricted scope by their MIS SUPER_ADMIN role.
  const pinnedNonAdmin = !params.forceAdmin && pinnedRole !== undefined && pinnedRole !== 'admin';
  const academicLevel: AcademicLevel = finalRole === 'admin'
    ? 'super_admin'
    : pinnedNonAdmin && ac.level === 'super_admin'
      ? (ac.placementLevel && ac.placementLevel !== 'super_admin'
          ? ac.placementLevel
          : academicLevelFromPlacement(finalRole, ac))
      : ac.level;
  const acParams = [
    ac.programIds, ac.gradeIds, ac.classGroupIds,
    ac.programNames, ac.gradeNames, ac.classGroupNames,
    academicLevel, ac.leadProgramIds ?? null,
  ];

  if (existing) {
    const updated = await pool.query<{ preferred_theme: 'light' | 'dark' | null; avatar_url: string | null }>(
      `UPDATE users
          SET name = $2,
              email = COALESCE(NULLIF($3, ''), email),
              avatar_url = CASE WHEN $18 THEN NULL ELSE COALESCE($4, avatar_url) END,
              role = $5,
              role_assigned_by_admin = CASE WHEN $6 THEN true ELSE role_assigned_by_admin END,
              preferred_theme = COALESCE($7, preferred_theme),
              -- Only recompute role_id when the administrator has not pinned
              -- one; a hand-assigned custom role must survive re-login.
              role_id = CASE WHEN $8 OR NOT role_assigned_by_admin THEN $9 ELSE role_id END,
              mis_program_ids = $10, mis_grade_ids = $11, mis_class_group_ids = $12,
              mis_program_names = $13, mis_grade_names = $14, mis_class_group_names = $15,
              academic_level = $16, mis_lead_program_ids = $17, academic_synced_at = now(),
              last_login_at = now(),
              updated_at = now()
        WHERE id = $1
      RETURNING preferred_theme, avatar_url`,
      [existing.id, params.name, params.email, params.avatarUrl ?? null,
       finalRole, params.forceAdmin, params.preferredTheme ?? null,
       params.forceAdmin, derivedRoleId, ...acParams, params.avatarUrl === null]
    );
    return {
      id: existing.id, misUserId: params.misUserId, name: params.name, email: params.email,
      role: finalRole, avatarUrl: updated.rows[0]?.avatar_url ?? undefined,
      // The stored value, not the incoming one: a returning user whose MIS
      // payload carried no theme still has their saved choice honoured, which
      // is why the COALESCE above keeps it.
      preferredTheme: (updated.rows[0]?.preferred_theme ?? undefined) as 'light' | 'dark' | undefined,
    };
  }

  const id = snowflake();
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, avatar_url, role,
                        role_assigned_by_admin, preferred_theme, role_id, last_login_at,
                        mis_program_ids, mis_grade_ids, mis_class_group_ids,
                        mis_program_names, mis_grade_names, mis_class_group_names,
                        academic_level, mis_lead_program_ids, academic_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(),
             $10, $11, $12, $13, $14, $15, $16, $17, now())`,
    [id, params.misUserId, params.name, params.email, params.avatarUrl ?? null,
     finalRole, params.forceAdmin, params.preferredTheme ?? null, derivedRoleId, ...acParams]
  );
  return {
    id, misUserId: params.misUserId, name: params.name, email: params.email,
    role: finalRole, avatarUrl: params.avatarUrl ?? undefined, preferredTheme: params.preferredTheme,
  };
}

/**
 * Keeps the stored picture in step with MIS (the /verify-mis poll). Returns true
 * when it changed, so the caller can tell the browser.
 */
export async function setUserAvatar(userId: string, avatarUrl: string | null): Promise<boolean> {
  const { rowCount } = await getPool().query(
    'UPDATE users SET avatar_url = $2, updated_at = now() WHERE id = $1 AND avatar_url IS DISTINCT FROM $2',
    [userId, avatarUrl]
  );
  return (rowCount ?? 0) > 0;
}

/** Same as setUserAvatar, for the profile cover. */
export async function setUserCover(userId: string, coverUrl: string | null): Promise<boolean> {
  const { rowCount } = await getPool().query(
    'UPDATE users SET cover_url = $2, updated_at = now() WHERE id = $1 AND cover_url IS DISTINCT FROM $2',
    [userId, coverUrl]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Tupo's own copy of the appearance preference. The MIS remains the source of
 * truth across the app family; this row is what keeps the UI correct while the
 * MIS is unreachable, and what the session is hydrated from at login.
 */
export async function setUserTheme(userId: string, theme: 'light' | 'dark'): Promise<void> {
  await getPool().query(
    'UPDATE users SET preferred_theme = $2, updated_at = now() WHERE id = $1',
    [userId, theme]
  );
}

export async function getUserTheme(userId: string): Promise<'light' | 'dark' | null> {
  const { rows } = await getPool().query<{ preferred_theme: 'light' | 'dark' | null }>(
    'SELECT preferred_theme FROM users WHERE id = $1',
    [userId]
  );
  return rows[0]?.preferred_theme ?? null;
}

/** Append-only audit trail (SRS FR-ADM-4). Never throws into the request path. */
export async function audit(entry: {
  actorId?: string; action: string; targetType?: string; targetId?: string;
  metadata?: Record<string, unknown>; ipAddress?: string; userAgent?: string;
}): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, metadata, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [snowflake(), entry.actorId ?? null, entry.action, entry.targetType ?? null,
       entry.targetId ?? null, JSON.stringify(entry.metadata ?? {}),
       entry.ipAddress ?? null, entry.userAgent ?? null]
    );
  } catch (err) {
    // Losing an audit row must not fail the user's request; surface it in logs.
    console.error('[audit] failed to write entry:', err);
  }
}
