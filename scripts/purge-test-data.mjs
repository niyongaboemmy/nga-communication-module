#!/usr/bin/env node
/**
 * The clean-up safety net (G-04): remove every account a gate or probe ever
 * created — by their id prefixes — with everything hanging off them (feed
 * pages, mail, meeting seats, uploaded files and their bytes), plus feed pages
 * orphaned by older gates. Each gate already cleans up after itself; this
 * catches runs that were interrupted before their `finally`.
 *
 *   npm run verify:purge            (dry run: counts only)
 *   npm run verify:purge -- --apply
 *
 * Never run against production.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { purgeUsers, TEST_USER_PREFIXES } from './lib/purge.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const url = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (/amashuri\.com|rds\.amazonaws|prod/i.test(url ?? '') || env.NODE_ENV === 'production') {
  console.error('Refusing: this looks like a production database.');
  process.exit(1);
}
const apply = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: url });

const ids = (await pool.query(
  `SELECT id FROM users WHERE id LIKE ANY($1::text[])`,
  [TEST_USER_PREFIXES.map((p) => `${p}%`)],
)).rows.map((r) => r.id);
// Pages left behind by gates that predate page clean-up (no owner any more).
const orphanPages = (await pool.query(
  `SELECT id, name FROM feed_pages
    WHERE created_by IS NULL AND (name LIKE 'UI Demo %' OR name LIKE 'Fix Verify %' OR name LIKE 'Verify %')`,
)).rows;

console.log(`${ids.length} test accounts, ${orphanPages.length} orphaned test pages.`);
if (!apply) {
  console.log('Dry run — pass --apply to delete.');
} else {
  await purgeUsers(pool, ids);
  await pool.query(`DELETE FROM feed_comment_reactions WHERE comment_id IN (SELECT id FROM feed_comments
      WHERE post_id IN (SELECT id FROM feed_posts WHERE page_id = ANY($1::text[])))`, [orphanPages.map((p) => p.id)])
    .catch((e) => console.error(`  · feed_comment_reactions: ${e.message}`));
  for (const t of ['feed_reactions', 'feed_poll_votes', 'feed_event_rsvps', 'feed_post_views',
    'feed_bookmarks', 'feed_timeline', 'feed_post_edits', 'feed_reports', 'feed_comments']) {
    await pool.query(`DELETE FROM ${t} WHERE post_id IN (SELECT id FROM feed_posts WHERE page_id = ANY($1::text[]))`,
      [orphanPages.map((p) => p.id)]).catch((e) => console.error(`  · ${t}: ${e.message}`));
  }
  for (const [t, col] of [['feed_posts', 'page_id'], ['feed_page_editors', 'page_id'], ['feed_page_followers', 'page_id'], ['feed_pages', 'id']]) {
    await pool.query(`DELETE FROM ${t} WHERE ${col} = ANY($1::text[])`, [orphanPages.map((p) => p.id)])
      .catch((e) => console.error(`  · ${t}: ${e.message}`));
  }
  const left = (await pool.query(`SELECT count(*)::int AS n FROM users WHERE id LIKE ANY($1::text[])`,
    [TEST_USER_PREFIXES.map((p) => `${p}%`)])).rows[0].n;
  console.log(`Done. ${left} test accounts remain.`);
}
await pool.end();
