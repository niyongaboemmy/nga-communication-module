import { getPool, snowflake, systemRoleIdByName } from '@tupo/db';
import { SYSTEM_ROLE_NAME_FOR } from '@tupo/shared';
import type { Role } from '@tupo/shared';
import { config } from '../config.js';

/**
 * Mentorship comes from NGA MIS: an administrator assigns each student a mentor
 * there, per academic year. Tupo only mirrors it, for two things:
 *
 *   1. the Mentorship page — a student sees their mentor's full profile, a
 *      mentor sees their mentees — and
 *   2. the direct-message rule. Students do not hold DM_START (the safeguarding
 *      default), so without this a student could never open a chat with the one
 *      adult the school appointed for them to talk to.
 *
 * MIS is asked with Tupo's SSO client credentials
 * (GET /mentorship/service/relationships/:misUserId). Answers are cached
 * briefly per person; a reassignment in MIS shows within a minute.
 */

const CACHE_MS = 60_000;
const TIMEOUT_MS = 8_000;

interface MisMedia { md?: string; lg?: string; sm?: string }

export interface MisRelationshipPerson {
  user_id: number;
  name: string | null;
  email: string | null;
  user_type: string | null;
  avatar: MisMedia | null;
  cover: MisMedia | null;
  academic_year_id: number;
  academic_year_name: string | null;
  assigned_at: string | null;
  phone?: string | null;
  registration_number?: string | null;
  class_group_name?: string | null;
}

export interface MisRelationships {
  user_id: number;
  mentor: MisRelationshipPerson | null;
  mentees: MisRelationshipPerson[];
}

export type RelationshipsTransport = (url: string, headers: Record<string, string>) =>
  Promise<{ status: number; body: unknown }>;

const fetchTransport: RelationshipsTransport = async (url, headers) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
};

let transport: RelationshipsTransport = fetchTransport;
/** Tests replace the MIS call. */
export function setRelationshipsTransport(t: RelationshipsTransport | null): void {
  transport = t ?? fetchTransport;
  cache.clear();
}

const cache = new Map<string, { at: number; value: MisRelationships }>();

export class MentorshipUnavailable extends Error {}

/** Who mentors this MIS user, and whom they mentor, right now. */
export async function relationshipsFor(misUserId: string): Promise<MisRelationships> {
  const empty: MisRelationships = { user_id: Number(misUserId), mentor: null, mentees: [] };
  // Only numeric MIS ids exist in MIS; an email-keyed fallback id has no mentor.
  if (!/^[0-9]+$/.test(misUserId)) return empty;

  const hit = cache.get(misUserId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const secret = config.ssoClientSecret === 'placeholder_client_secret' ? '' : config.ssoClientSecret;
  if (!config.ssoClientId || !secret) throw new MentorshipUnavailable('SSO client credentials are not configured');

  const base = config.misBaseUrl.replace(/\/+$/, '');
  let res: { status: number; body: unknown };
  try {
    res = await transport(`${base}/mentorship/service/relationships/${misUserId}`, {
      Authorization: `Basic ${Buffer.from(`${config.ssoClientId}:${secret}`, 'utf8').toString('base64')}`,
      Accept: 'application/json',
    });
  } catch (err) {
    throw new MentorshipUnavailable(err instanceof Error ? err.message : String(err));
  }
  const data = (res.body as { data?: MisRelationships } | null)?.data;
  if (res.status < 200 || res.status >= 300 || !data || !Array.isArray(data.mentees)) {
    throw new MentorshipUnavailable(`MIS answered ${res.status}`);
  }
  const value: MisRelationships = { user_id: Number(misUserId), mentor: data.mentor ?? null, mentees: data.mentees };
  cache.set(misUserId, { at: Date.now(), value });
  return value;
}

const httpUrl = (u: unknown): string | null => (typeof u === 'string' && /^https?:\/\//.test(u) ? u : null);

/** The coarse Tupo role a MIS user type implies before that person ever signs in. */
function roleForUserType(userType: string | null): Role {
  switch (String(userType ?? '').toUpperCase()) {
    case 'STUDENT': return 'student';
    case 'PARENT': return 'parent';
    // Never 'admin': that is derived from MIS permissions at sign-in. Staff is
    // the floor every non-student, non-parent holds.
    default: return 'staff';
  }
}

/**
 * The Tupo user row for each MIS person, created when they have never signed in.
 *
 * A mentor who has not opened Tupo yet must still be reachable: the student's
 * message waits in the conversation and is there on the mentor's first sign-in,
 * when upsertMisUser refreshes the row with their real role and placement.
 * The row is a mirror with no credential, exactly like a signed-in one.
 */
export async function ensureTupoUsers(people: MisRelationshipPerson[]): Promise<Map<number, string>> {
  const pool = getPool();
  const out = new Map<number, string>();
  if (!people.length) return out;
  const ids = people.map((p) => String(p.user_id));
  const { rows } = await pool.query<{ id: string; mis_user_id: string }>(
    'SELECT id, mis_user_id FROM users WHERE mis_user_id = ANY($1::text[])', [ids]);
  for (const r of rows) out.set(Number(r.mis_user_id), r.id);

  for (const p of people) {
    if (out.has(p.user_id) || !p.email) continue;
    const role = roleForUserType(p.user_type);
    const roleId = await systemRoleIdByName(pool, SYSTEM_ROLE_NAME_FOR[role as Exclude<Role, 'unassigned'>]);
    const { rows: inserted } = await pool.query<{ id: string }>(
      `INSERT INTO users (id, mis_user_id, name, email, avatar_url, cover_url, role, role_id, academic_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (mis_user_id) DO UPDATE SET mis_user_id = EXCLUDED.mis_user_id
       RETURNING id`,
      [snowflake(), String(p.user_id), p.name ?? p.email, p.email,
       httpUrl(p.avatar?.md), httpUrl(p.cover?.lg), role, roleId, role],
    );
    if (inserted[0]) out.set(p.user_id, inserted[0].id);
  }
  return out;
}

/**
 * True when `peerId` (a Tupo user id) is the requester's mentor or mentee in MIS
 * right now. Fails closed: if MIS cannot be asked, the ordinary rules apply.
 */
export async function isMentorshipPeer(me: { misUserId: string }, peerId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ mis_user_id: string }>(
    'SELECT mis_user_id FROM users WHERE id = $1', [peerId]);
  const peerMis = Number(rows[0]?.mis_user_id);
  if (!Number.isSafeInteger(peerMis)) return false;
  try {
    const rel = await relationshipsFor(me.misUserId);
    return rel.mentor?.user_id === peerMis || rel.mentees.some((m) => m.user_id === peerMis);
  } catch {
    return false;
  }
}

/** A block, either way round, always wins — mentorship included. */
export async function blockedBetween(a: string, b: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM user_blocks
      WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1`,
    [a, b],
  );
  return rows.length > 0;
}
