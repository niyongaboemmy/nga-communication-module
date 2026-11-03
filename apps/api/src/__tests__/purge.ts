import { getPool } from '@tupo/db';

/**
 * Remove test users and everything they left behind — conversations,
 * messages, files, feed pages — with the same purge the live suites use
 * (scripts/lib/purge.mjs). A file that leaves rows pointing at its users
 * breaks the next file that clears the users table.
 */
export async function purgeTestUsers(ids: string[]): Promise<void> {
  const url = new URL('../../../../scripts/lib/purge.mjs', import.meta.url).href;
  const mod = (await import(url)) as { purgeUsers: (pool: unknown, ids: string[], opts?: { quiet?: boolean }) => Promise<void> };
  await mod.purgeUsers(getPool(), ids, { quiet: true });
}
