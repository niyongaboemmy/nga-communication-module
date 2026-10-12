/**
 * Partition maintenance (SRS §7.3).
 *
 *   partitions:ensure — keep monthly partitions for `messages` and
 *   `meeting_events` at least three months ahead of today.
 *
 * Without this the logs accept writes only for the months that existed when
 * the database was first migrated. The default partitions added in 0031 are a
 * safety net, not a destination: rows landing there mean this job has not been
 * running, so it says so loudly.
 */
import { getPool } from '@tupo/db';

export const PARTITION_MONTHS_AHEAD = 3;

export async function runPartitionMaintenance(): Promise<{ created: number; inDefault: Record<string, number> }> {
  const pool = getPool();
  const { rows } = await pool.query<{ created: number }>(
    'SELECT tupo_ensure_partitions($1) AS created', [PARTITION_MONTHS_AHEAD],
  );
  const inDefault: Record<string, number> = {};
  for (const table of ['messages_default', 'meeting_events_default']) {
    const r = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    inDefault[table] = Number(r.rows[0]?.n ?? 0);
    if (inDefault[table]! > 0) {
      console.warn(`[worker] partitions:ensure — ${inDefault[table]} row(s) in ${table}; a monthly partition was missing when they were written`);
    }
  }
  return { created: rows[0]?.created ?? 0, inDefault };
}

/** Whole months ahead that both logs can accept writes for. */
export async function partitionsAhead(): Promise<number | null> {
  try {
    const { rows } = await getPool().query<{ n: number }>('SELECT tupo_partitions_ahead() AS n');
    return rows[0]?.n ?? 0;
  } catch {
    return null;
  }
}
