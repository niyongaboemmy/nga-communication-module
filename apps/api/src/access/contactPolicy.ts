import { getPool } from '@tupo/db';

/**
 * Who may start contact with whom (SRS FR-USR-6, SEC-Z1..Z3; plan §11 Phase 7).
 *
 *   staff (teachers, support staff, admins)  → anyone
 *   student → their teachers (class / subject teachers of a class group they
 *             are in), their mentors, and classmates (same class group)
 *   parent  → the teachers and mentors of their children
 *   anyone else → nobody (default deny)
 *
 * `contactDecision` is pure: it looks only at the two profiles handed to it.
 * `loadContactProfiles` builds them from `users` (migration 0023 + 0028
 * columns, refreshed at login from the MIS snapshot). Existing conversations
 * are never affected — this governs *starting* contact.
 */

export type ContactPersona = 'staff' | 'student' | 'parent' | 'unknown';

export interface ContactProfile {
  userId: string;
  misUserId: string;
  persona: ContactPersona;
  /** Class groups the person is a member of (a student's own class). */
  classGroupIds: string[];
  /** Class groups the person teaches / leads (staff). */
  teachClassGroupIds: string[];
  /** MIS ids of the person's mentees (mentor) or children (parent). */
  studentIds: string[];
}

export interface ContactDecision {
  allowed: boolean;
  reason:
    | 'self' | 'staff_sender' | 'teacher' | 'mentor' | 'classmate'
    | 'childs_teacher' | 'childs_mentor' | 'default_deny';
}

const overlaps = (a: string[], b: string[]) => a.some((x) => x && b.includes(x));

export function contactDecision(from: ContactProfile, to: ContactProfile): ContactDecision {
  if (from.userId === to.userId) return { allowed: true, reason: 'self' };
  if (from.persona === 'staff') return { allowed: true, reason: 'staff_sender' };

  if (from.persona === 'student') {
    if (to.persona === 'staff') {
      if (overlaps(from.classGroupIds, to.teachClassGroupIds)) return { allowed: true, reason: 'teacher' };
      if (to.studentIds.includes(from.misUserId)) return { allowed: true, reason: 'mentor' };
    }
    if (to.persona === 'student' && overlaps(from.classGroupIds, to.classGroupIds)) {
      return { allowed: true, reason: 'classmate' };
    }
    return { allowed: false, reason: 'default_deny' };
  }

  if (from.persona === 'parent') {
    if (to.persona === 'staff') {
      // The children's MIS ids are known; their class groups are known only
      // for children who carry them (see loadContactProfiles).
      if (overlaps(from.classGroupIds, to.teachClassGroupIds)) return { allowed: true, reason: 'childs_teacher' };
      if (overlaps(from.studentIds, to.studentIds)) return { allowed: true, reason: 'childs_mentor' };
    }
    return { allowed: false, reason: 'default_deny' };
  }

  return { allowed: false, reason: 'default_deny' };
}

/** Maps a MIS user_type / Tupo role to the contact persona. */
export function personaOf(accessPersona: string | null, role: string | null, academicLevel: string | null): ContactPersona {
  const p = String(accessPersona ?? '').toUpperCase();
  if (p === 'STUDENT') return 'student';
  if (p === 'PARENT') return 'parent';
  if (p) return 'staff'; // TEACHER, STAFF, ADMIN, SUPPORT_STAFF, ...
  const r = String(role ?? '').toLowerCase();
  if (r === 'student' || academicLevel === 'student') return 'student';
  if (r === 'parent' || academicLevel === 'parent') return 'parent';
  if (r === 'staff' || r === 'admin') return 'staff';
  return 'unknown';
}

interface Row {
  id: string; mis_user_id: string; role: string | null; academic_level: string | null;
  access_persona: string | null; mis_class_group_ids: string[] | null;
  access_teach_class_group_ids: string[] | null; access_student_ids: string[] | null;
}

/**
 * Profiles for the given Tupo user ids. A parent's `classGroupIds` is filled
 * with the class groups of their children who are Tupo users and carry one.
 */
export async function loadContactProfiles(userIds: string[]): Promise<Map<string, ContactProfile>> {
  const out = new Map<string, ContactProfile>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return out;
  const pool = getPool();
  const { rows } = await pool.query<Row>(
    `SELECT id, mis_user_id, role, academic_level, access_persona, mis_class_group_ids,
            access_teach_class_group_ids, access_student_ids
       FROM users WHERE id = ANY($1::text[])`,
    [ids],
  );
  for (const r of rows) {
    const teach = [...new Set([...(r.access_teach_class_group_ids ?? [])])];
    const persona = personaOf(r.access_persona, r.role, r.academic_level);
    // Class teachers carry their class group in mis_class_group_ids (from MIS
    // /users/me assignedGrades) — for staff that is a class they teach.
    if (persona === 'staff') for (const c of r.mis_class_group_ids ?? []) if (!teach.includes(c)) teach.push(c);
    out.set(r.id, {
      userId: r.id,
      misUserId: r.mis_user_id,
      persona,
      classGroupIds: persona === 'staff' ? [] : [...(r.mis_class_group_ids ?? [])],
      teachClassGroupIds: teach,
      studentIds: [...(r.access_student_ids ?? [])],
    });
  }
  // Parents: add their children's class groups.
  const parents = [...out.values()].filter((p) => p.persona === 'parent' && p.studentIds.length);
  if (parents.length) {
    const childIds = [...new Set(parents.flatMap((p) => p.studentIds))];
    const { rows: kids } = await pool.query<{ mis_user_id: string; mis_class_group_ids: string[] }>(
      `SELECT mis_user_id, mis_class_group_ids FROM users WHERE mis_user_id = ANY($1::text[])`,
      [childIds],
    );
    const byMis = new Map(kids.map((k) => [k.mis_user_id, k.mis_class_group_ids ?? []]));
    for (const p of parents) {
      p.classGroupIds = [...new Set([...p.classGroupIds, ...p.studentIds.flatMap((s) => byMis.get(s) ?? [])])];
    }
  }
  return out;
}

/** One sender against many recipients. Unknown recipients are denied. */
export async function contactDecisions(
  fromUserId: string, toUserIds: string[],
): Promise<Map<string, ContactDecision>> {
  const profiles = await loadContactProfiles([fromUserId, ...toUserIds]);
  const from = profiles.get(fromUserId);
  const out = new Map<string, ContactDecision>();
  for (const to of toUserIds) {
    const p = profiles.get(to);
    out.set(to, from && p ? contactDecision(from, p) : { allowed: false, reason: 'default_deny' });
  }
  return out;
}
