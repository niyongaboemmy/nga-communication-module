/**
 * Who counts as an active person in Tupo — the ONE rule, used by every list of
 * people (pickers, search, recipients, notification fan-out, dashboard counts,
 * the realtime/API auth checks).
 *
 * Active = not suspended locally by a Tupo administrator (`users.status`) AND
 * active in NGA MIS (`users.mis_status`, the source of truth; NULL = not synced
 * yet, which counts as active so nobody vanishes before the first sweep).
 *
 * History (messages, mail headers, feed authors, oversight, audit, meeting
 * participants) is never filtered by this; views of it tag people `inactive`.
 */

/** The MIS status that counts as active. Anything else (INACTIVE, SUSPENDED, REMOVED) does not. */
export const MIS_ACTIVE = 'ACTIVE';
/** Written for ids MIS no longer returns (hard-deleted there). */
export const MIS_REMOVED = 'REMOVED';

/**
 * SQL predicate for "this users row is active". `alias` is the table alias
 * (or the table name) the query uses for users. Contains no parameters, so it
 * can be spliced into any query.
 */
export function activeUserSql(alias = 'users'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error(`bad SQL alias: ${alias}`);
  return `(${alias}.status = 'active' AND COALESCE(${alias}.mis_status, '${MIS_ACTIVE}') = '${MIS_ACTIVE}')`;
}

/** The negation, for counting/flagging inactive people. */
export function inactiveUserSql(alias = 'users'): string {
  return `(NOT ${activeUserSql(alias)})`;
}

/** The same rule for a row already in memory. */
export function isActiveUser(u: { status?: string | null; mis_status?: string | null; misStatus?: string | null }): boolean {
  const mis = u.mis_status ?? u.misStatus ?? null;
  return (u.status ?? 'active') === 'active' && (mis ?? MIS_ACTIVE) === MIS_ACTIVE;
}

/**
 * Normalise a status value read from MIS. Returns undefined when MIS said
 * nothing usable (an older MIS without `status`), so callers leave the stored
 * value alone rather than guessing.
 */
export function normaliseMisStatus(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().toUpperCase();
  return /^[A-Z_]{1,16}$/.test(s) ? s : undefined;
}

/**
 * Of the given user ids, those that are active. Order is preserved; unknown
 * ids are dropped. `query` is a pg Pool/Client.
 */
export async function filterActiveUserIds(
  query: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ id: string }> }> },
  userIds: readonly string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const { rows } = await query.query(
    `SELECT id FROM users u WHERE u.id = ANY($1::text[]) AND ${activeUserSql('u')}`,
    [[...new Set(userIds)]],
  );
  const ok = new Set(rows.map((r) => r.id));
  return userIds.filter((id) => ok.has(id));
}
