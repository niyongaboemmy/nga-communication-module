import * as chat from '@tupo/chat';
import type { MisSubject } from '@tupo/chat';
import { config } from '../config.js';

/**
 * Mirror a person's subjects from the NGA Central MIS into Tupo at sign-in, so
 * the Channels page shows the subjects they teach or take and they are in
 * those subjects' channels.
 *
 * Teachers: /academics/my-assigned-subjects. Students: their enrolments
 * (current academic year only). Both are asked; whichever the person's MIS
 * role does not allow simply answers 403 and contributes nothing. If neither
 * call succeeds the stored subjects are left alone -- an MIS hiccup must not
 * empty everyone's channel list -- and a failure never fails the sign-in.
 */
const TIMEOUT_MS = 5_000;

type Row = Record<string, unknown>;

async function misGet(path: string, misToken: string): Promise<Row[] | null> {
  try {
    const res = await fetch(`${config.misBaseUrl}${path}`, {
      headers: { Authorization: `Bearer ${misToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    return Array.isArray(body.data) ? (body.data as Row[]) : null;
  } catch {
    return null;
  }
}

const toSubject = (r: Row, role: MisSubject['role']): MisSubject | null => {
  const id = r.subject_id ?? r.id;
  const name = r.subject_name ?? r.name;
  if (id == null || !name) return null;
  const code = r.subject_code ?? r.code;
  return { id: String(id), name: String(name), code: code ? String(code) : null, role };
};

export async function syncSubjectsFromMis(userId: string, misUserId: string, misToken: string): Promise<void> {
  const [taught, enrolled] = await Promise.all([
    misGet('/academics/my-assigned-subjects', misToken),
    misGet(`/academics/students/${encodeURIComponent(misUserId)}/enrolled-subjects`, misToken),
  ]);
  if (taught === null && enrolled === null) return;

  const subjects = [
    ...(taught ?? []).map((r) => toSubject(r, 'teacher')),
    ...(enrolled ?? [])
      // Past years' enrolments stay in the MIS; only this year's subjects count.
      .filter((r) => r.academic_year_is_current === undefined || Number(r.academic_year_is_current) === 1)
      .map((r) => toSubject(r, 'student')),
  ].filter((s): s is MisSubject => s !== null);

  try {
    await chat.syncUserSubjects(userId, subjects);
  } catch (err) {
    console.error('[subjects] sync failed:', err);
  }
}
