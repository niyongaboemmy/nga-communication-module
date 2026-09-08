/**
 * Presence, the durable half.
 *
 * The live half — who is green right now — belongs in Redis with a TTL, and
 * neither this file nor the database has any business in it: a status that
 * changes every few seconds and is worthless once stale is not a row.
 *
 * What *is* a row is "last seen". It is read precisely when the live half has
 * nothing to say, it has to survive a gateway restart and a Redis flush, and it
 * is written rarely. So Postgres owns it, with Redis kept in front as a cache
 * so the common lookup never touches the database at all.
 */
import { getPool } from '@tupo/db';

/**
 * Record that someone was here.
 *
 * Called on disconnect, and on a heartbeat that has not written for a while —
 * see LAST_SEEN_WRITE_INTERVAL_MS. Writing on every heartbeat would be one
 * UPDATE per signed-in person every 45 seconds, which for a school of two
 * thousand is a pointless steady write load on a column nobody reads until
 * that person goes offline.
 */
export async function touchLastSeen(userId: string, at: Date = new Date()): Promise<void> {
  await getPool().query('UPDATE users SET last_seen_at = $2 WHERE id = $1', [userId, at]);
}

/**
 * How long a connected socket may go without its last-seen row being written.
 *
 * The row only has to be *approximately* right, because it is only ever read
 * for someone who is offline — and the disconnect path writes it exactly. This
 * interval exists solely so a process killed with -9, which never reaches that
 * path, still leaves a figure that is minutes out rather than days.
 */
export const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60_000;

/** Last-seen for a set of people, from the database. Absent means never seen. */
export async function lastSeenFor(userIds: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (!userIds.length) return out;
  const { rows } = await getPool().query<{ id: string; last_seen_at: Date | null }>(
    'SELECT id, last_seen_at FROM users WHERE id = ANY($1::text[])', [userIds],
  );
  for (const r of rows) out[r.id] = r.last_seen_at ? r.last_seen_at.toISOString() : null;
  return out;
}

/**
 * Does this person let others see their presence?
 *
 * Read straight from the preference row rather than through `getPrefs`, which
 * builds the whole object — this is asked on every connect and on every
 * presence broadcast, and it needs one boolean.
 *
 * Default true, matching DEFAULT_PREFS: someone who has never opened settings
 * has preferences, they are simply the ones nobody changed.
 */
export async function showsPresence(userId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ show_presence: boolean }>(
    'SELECT show_presence FROM user_chat_prefs WHERE user_id = $1', [userId],
  );
  return rows[0]?.show_presence ?? true;
}

/**
 * The same question as `showsPresence`, asked about many people at once.
 *
 * A roster renders one row per member and each row wants a dot, so asking
 * per-member would be a query per row. Returns the set permitted to be shown;
 * anyone who opted out is simply absent from it.
 *
 * `show_presence` has been in the preferences table, in the API and on a toggle
 * in the UI since chat shipped, and until now nothing read it — turning it off
 * changed nothing at all.
 */
export async function presenceVisibleFor(userIds: string[]): Promise<Set<string>> {
  const visible = new Set(userIds);
  if (!userIds.length) return visible;
  try {
    const { rows } = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM user_chat_prefs
        WHERE user_id = ANY($1::text[]) AND show_presence = false`,
      [userIds],
    );
    for (const r of rows) visible.delete(r.user_id);
  } catch {
    // If the preference cannot be read, fall back to showing presence: the
    // column's default is true, so that is the answer for almost everyone.
  }
  return visible;
}
