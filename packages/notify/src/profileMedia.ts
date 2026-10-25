import { getPool, MIS_REMOVED, normaliseMisStatus } from '@tupo/db';
import { reminderConfigFromEnv, type ReminderConfig } from './reminders.js';

/**
 * Everyone's NGA profile photo and cover, kept current from NGA MIS.
 *
 * Sign-in and the /verify-mis poll only refresh the person who is using Tupo, so
 * someone who changed their photo in MIS would keep showing their old one (or
 * initials) in other people's lists until they next opened Tupo. This sweep asks MIS
 * for every known person in batches (POST /users/profile-media/lookup, authenticated
 * with Tupo's SSO client credentials) and writes what changed.
 *
 * People MIS does not answer for are left alone: a missing row is not "no photo".
 *
 * The same lookup carries each person's MIS account status (users.mis_status, see
 * @tupo/db activeUsers.ts). When MIS answers with statuses, an id it leaves out of
 * its answer no longer exists there and becomes REMOVED. An older MIS that sends
 * no status at all leaves mis_status untouched.
 */

const BATCH = 500;
const REQUEST_TIMEOUT_MS = 15_000;

export interface MediaLookupResponse { status: number; body: unknown }
export type MediaTransport = (url: string, init: { headers: Record<string, string>; body: string }) => Promise<MediaLookupResponse>;

export const fetchTransport: MediaTransport = async (url, init) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
};

export interface ProfileMediaSyncResult {
  checked: number;
  avatarsUpdated: number;
  coversUpdated: number;
  /** Rows whose users.mis_status changed. */
  statusesUpdated: number;
  errors: string[];
  skipped?: string;
}

const httpUrl = (u: unknown): string | null => (typeof u === 'string' && /^https?:\/\//.test(u) ? u : null);

export async function runProfileMediaSync(opts: {
  config?: Pick<ReminderConfig, 'misBaseUrl' | 'clientId' | 'clientSecret'>;
  transport?: MediaTransport;
  /** Only these MIS user ids (the back-channel logout re-check); default everyone. */
  misUserIds?: string[];
} = {}): Promise<ProfileMediaSyncResult> {
  const cfg = opts.config ?? reminderConfigFromEnv();
  const result: ProfileMediaSyncResult = { checked: 0, avatarsUpdated: 0, coversUpdated: 0, statusesUpdated: 0, errors: [] };
  if (!cfg.clientId || !cfg.clientSecret) {
    result.skipped = 'SSO_CLIENT_ID / SSO_CLIENT_SECRET are not set';
    return result;
  }
  const transport = opts.transport ?? fetchTransport;
  const pool = getPool();

  // MIS ids are numeric; anything else (an email-keyed fallback id) can't be looked up.
  const { rows } = await pool.query<{
    id: string; mis_user_id: string; avatar_url: string | null; cover_url: string | null; mis_status: string | null;
  }>(
    `SELECT id, mis_user_id, avatar_url, cover_url, mis_status FROM users
      WHERE mis_user_id ~ '^[0-9]+$' AND ($1::text[] IS NULL OR mis_user_id = ANY($1::text[]))
      ORDER BY id`,
    [opts.misUserIds ?? null],
  );
  const byMisId = new Map(rows.map((r) => [Number(r.mis_user_id), r]));
  const ids = [...byMisId.keys()];
  const headers = {
    Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`, 'utf8').toString('base64')}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    let res: MediaLookupResponse;
    try {
      res = await transport(`${cfg.misBaseUrl}/users/profile-media/lookup`, { headers, body: JSON.stringify({ user_ids: batch }) });
    } catch (err) {
      result.errors.push(`lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const users = (res.body as { data?: { users?: unknown } } | null)?.data?.users;
    if (res.status < 200 || res.status >= 300 || !Array.isArray(users)) {
      result.errors.push(`lookup answered ${res.status}`);
      continue;
    }
    const entries = users as Array<{ user_id?: unknown; avatar?: { md?: unknown } | null; cover?: { lg?: unknown } | null; status?: unknown }>;
    // A MIS that knows about status puts it on every user it returns; only then
    // does "not in the answer" mean "no longer exists in MIS".
    const carriesStatus = entries.some((e) => normaliseMisStatus(e?.status) !== undefined);
    const answered = new Set<number>();
    const setStatus = async (row: { id: string; mis_status: string | null }, status: string) => {
      if (status === row.mis_status) {
        await pool.query('UPDATE users SET mis_status_synced_at = now() WHERE id = $1', [row.id]);
        return;
      }
      await pool.query(
        'UPDATE users SET mis_status = $2, mis_status_synced_at = now(), updated_at = now() WHERE id = $1',
        [row.id, status],
      );
      result.statusesUpdated++;
    };
    for (const entry of entries) {
      const row = byMisId.get(Number(entry.user_id));
      if (!row) continue;
      answered.add(Number(entry.user_id));
      result.checked++;
      const status = normaliseMisStatus(entry.status);
      if (status !== undefined) await setStatus(row, status);
      const avatar = entry.avatar ? httpUrl(entry.avatar.md) : null;
      const cover = entry.cover ? httpUrl(entry.cover.lg) : null;
      if (avatar !== row.avatar_url || cover !== row.cover_url) {
        await pool.query('UPDATE users SET avatar_url = $2, cover_url = $3, updated_at = now() WHERE id = $1', [row.id, avatar, cover]);
        if (avatar !== row.avatar_url) result.avatarsUpdated++;
        if (cover !== row.cover_url) result.coversUpdated++;
      }
    }
    if (carriesStatus) {
      for (const misId of batch) {
        if (answered.has(misId)) continue;
        await setStatus(byMisId.get(misId)!, MIS_REMOVED);
      }
    }
  }
  return result;
}
