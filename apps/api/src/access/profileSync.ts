import { getPool } from '@tupo/db';
import { scopeFor, type AccessSnapshot } from '../vendor/nga-access/index.js';
import type { MisAcademic, AcademicLevel } from '../services/userService.js';

/**
 * Derives Tupo's cached placement columns from the MIS access snapshot.
 *
 * `users.mis_*_ids` stay what the GIN-indexed dashboard SQL matches against:
 * the places a person *is* (membership), not what they can see. From the
 * snapshot that is the node of each placement grant — a Class Teacher grant
 * on CLASS_GROUP:7 places them in class 7, a Subject Teacher grant on
 * SUBJECT_CLASS:31/12 in class 12, a Programme lead grant on PROGRAM:2 in
 * programme 2. SCHOOL / PLATFORM / SELF / MENTEES / CHILDREN nodes place
 * nobody anywhere.
 */
export function academicFromSnapshot(
  snap: AccessSnapshot, fallback: MisAcademic, forceAdmin: boolean,
): MisAcademic {
  const programIds: string[] = [];
  const gradeIds: string[] = [];
  const classGroupIds: string[] = [];
  const add = (xs: string[], v: number | null | undefined) => {
    if (v != null && !xs.includes(String(v))) xs.push(String(v));
  };
  for (const g of Object.values(snap.grants ?? {})) {
    switch (g.scope_type) {
      case 'PROGRAM': add(programIds, g.scope_id); break;
      case 'GRADE': add(gradeIds, g.scope_id); break;
      case 'CLASS_GROUP': add(classGroupIds, g.scope_id); break;
      case 'SUBJECT_CLASS': add(classGroupIds, g.scope_id2); break;
      default: break;
    }
  }
  // Names are not in the snapshot; reuse the /users/me names where ids match.
  const nameOf = (ids: string[], names: string[], id: string) => {
    const i = ids.indexOf(id);
    return i >= 0 && names[i] ? names[i]! : id;
  };

  const persona = String(snap.user?.persona ?? '').toUpperCase();
  let placementLevel: AcademicLevel = 'none';
  if (programIds.length) placementLevel = 'program_lead';
  else if (gradeIds.length || classGroupIds.length) placementLevel = 'class_teacher';
  else if (persona === 'STUDENT') placementLevel = 'student';
  else if (persona === 'PARENT') placementLevel = 'parent';
  else if (persona) placementLevel = 'staff';

  // A student's own class groups (MIS snapshot user.class_groups, core 1.2)
  // are membership too -- what the dashboard counts and the contact policy's
  // "teachers / classmates" rules match on. Added after the level is decided,
  // so being in a class never makes a student look like a class teacher.
  if (persona === 'STUDENT') {
    for (const c of snap.user?.class_groups ?? []) add(classGroupIds, c);
  }

  const everywhere = scopeFor(snap, 'DASHBOARD_VIEW', 'detail')?.all === true;
  return {
    level: forceAdmin || everywhere ? 'super_admin' : placementLevel,
    placementLevel,
    programIds,
    leadProgramIds: [...programIds],
    gradeIds,
    classGroupIds,
    programNames: programIds.map((id) => nameOf(fallback.programIds, fallback.programNames, id)),
    gradeNames: gradeIds.map((id) => nameOf(fallback.gradeIds, fallback.gradeNames, id)),
    classGroupNames: classGroupIds.map((id) => nameOf(fallback.classGroupIds, fallback.classGroupNames, id)),
  };
}

/** Contact-policy inputs from the snapshot (migration 0028 columns). */
export function contactColumnsFromSnapshot(snap: AccessSnapshot): {
  persona: string | null; teachClassGroupIds: string[]; studentIds: string[];
} {
  const teach = new Set<string>();
  const students = new Set<string>();
  const grants = snap.grants ?? {};
  for (const entries of Object.values(snap.caps ?? {})) {
    for (const e of entries ?? []) {
      const nodes = (e.via ?? []).map((id) => grants[String(id)]?.scope_type);
      const s = e.scope ?? {};
      for (const id of s.students ?? []) students.add(String(id));
      // Teaching / leading nodes only; a school-wide grant is not "a teacher of".
      if (nodes.some((t) => t === 'CLASS_GROUP' || t === 'SUBJECT_CLASS' || t === 'GRADE' || t === 'PROGRAM')) {
        for (const c of s.class_groups ?? []) teach.add(String(c));
        for (const [, c] of s.pairs ?? []) teach.add(String(c));
      }
    }
  }
  // Grants with no Tupo capability still say where someone teaches.
  for (const g of Object.values(grants)) {
    if (g.scope_type === 'CLASS_GROUP' && g.scope_id != null) teach.add(String(g.scope_id));
    if (g.scope_type === 'SUBJECT_CLASS' && g.scope_id2 != null) teach.add(String(g.scope_id2));
  }
  return { persona: snap.user?.persona ?? null, teachClassGroupIds: [...teach], studentIds: [...students] };
}

/** Persist the contact-policy columns. Never throws (login must not fail on it). */
export async function syncAccessProfile(userId: string, snap: AccessSnapshot): Promise<void> {
  const c = contactColumnsFromSnapshot(snap);
  try {
    await getPool().query(
      `UPDATE users SET access_persona = $2, access_teach_class_group_ids = $3,
              access_student_ids = $4, access_synced_at = now()
        WHERE id = $1`,
      [userId, c.persona, c.teachClassGroupIds, c.studentIds],
    );
  } catch (err) {
    console.warn('[access] contact profile not synced:', (err as Error)?.message ?? err);
  }
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** Does the snapshot-derived placement differ from the /users/me one? */
export function placementDiffers(a: MisAcademic, b: MisAcademic): boolean {
  return !sameSet(a.leadProgramIds ?? [], b.leadProgramIds ?? [])
    || !sameSet(a.gradeIds, b.gradeIds)
    || !sameSet(a.classGroupIds, b.classGroupIds)
    || a.level !== b.level;
}
