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
export interface MisAcademic {
  level: 'super_admin' | 'program_lead' | 'class_teacher' | 'staff' | 'student' | 'parent' | 'none';
  programIds: string[];
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

export async function upsertMisUser(params: {
  misUserId: string;
  name: string;
  email: string;
  avatarUrl?: string;
  derivedRole: Role;
  preferredTheme?: 'light' | 'dark';
  forceAdmin: boolean;
  academic?: MisAcademic;
}): Promise<SessionUser> {
  const pool = getPool();
  const { rows: existingRows } = await pool.query<{
    id: string; role: Role; role_assigned_by_admin: boolean;
  }>(
    'SELECT id, role, role_assigned_by_admin FROM users WHERE mis_user_id = $1',
    [params.misUserId]
  );
  const existing = existingRows[0];

  const finalRole: Role = params.forceAdmin
    ? 'admin'
    : existing?.role_assigned_by_admin
      ? existing.role
      : params.derivedRole;

  // Resolve the RBAC role row that carries the actual permission set.
  // 'unassigned' deliberately maps to NULL: the user exists but holds nothing
  // until an administrator grants a role.
  const roleName = finalRole === 'unassigned' ? null : SYSTEM_ROLE_NAME_FOR[finalRole];
  const derivedRoleId = roleName ? await systemRoleIdByName(pool, roleName) : null;

  const ac = params.academic ?? EMPTY_ACADEMIC;
  // A forced/derived Tupo admin outranks whatever the MIS placement says.
  const academicLevel = finalRole === 'admin' ? 'super_admin' : ac.level;
  const acParams = [
    ac.programIds, ac.gradeIds, ac.classGroupIds,
    ac.programNames, ac.gradeNames, ac.classGroupNames,
    academicLevel,
  ];

  if (existing) {
    const updated = await pool.query<{ preferred_theme: 'light' | 'dark' | null }>(
      `UPDATE users
          SET name = $2,
              email = COALESCE(NULLIF($3, ''), email),
              avatar_url = COALESCE($4, avatar_url),
              role = $5,
              role_assigned_by_admin = CASE WHEN $6 THEN true ELSE role_assigned_by_admin END,
              preferred_theme = COALESCE($7, preferred_theme),
              -- Only recompute role_id when the administrator has not pinned
              -- one; a hand-assigned custom role must survive re-login.
              role_id = CASE WHEN $8 OR NOT role_assigned_by_admin THEN $9 ELSE role_id END,
              mis_program_ids = $10, mis_grade_ids = $11, mis_class_group_ids = $12,
              mis_program_names = $13, mis_grade_names = $14, mis_class_group_names = $15,
              academic_level = $16, academic_synced_at = now(),
              last_login_at = now(),
              updated_at = now()
        WHERE id = $1
      RETURNING preferred_theme`,
      [existing.id, params.name, params.email, params.avatarUrl ?? null,
       finalRole, params.forceAdmin, params.preferredTheme ?? null,
       params.forceAdmin, derivedRoleId, ...acParams]
    );
    return {
      id: existing.id, misUserId: params.misUserId, name: params.name, email: params.email,
      role: finalRole, avatarUrl: params.avatarUrl,
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
                        academic_level, academic_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(),
             $10, $11, $12, $13, $14, $15, $16, now())`,
    [id, params.misUserId, params.name, params.email, params.avatarUrl ?? null,
     finalRole, params.forceAdmin, params.preferredTheme ?? null, derivedRoleId, ...acParams]
  );
  return {
    id, misUserId: params.misUserId, name: params.name, email: params.email,
    role: finalRole, avatarUrl: params.avatarUrl, preferredTheme: params.preferredTheme,
  };
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
