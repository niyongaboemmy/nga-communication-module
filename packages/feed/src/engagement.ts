/**
 * Impressions & reach (FR-FEED-10), saved posts, event RSVPs and share counts.
 * Small, fire-and-forget mutations that never fail a render.
 */
import { loadVisiblePost } from './visibility.js';
import { getPool } from '@tupo/db';
import { FeedError } from './errors.js';
import type { FeedActor } from './common.js';

/** One impression. Counts unique reach once per person, total views every time. */
export async function recordView(
  actor: FeedActor, postId: string,
): Promise<{ viewCount: number; uniqueReach: number } | null> {
  const visible = await loadVisiblePost(actor, postId).catch(() => null);
  if (!visible || visible.status !== 'published') return null;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // One person is one impression per post per half hour: scrolling past a
    // card twice, or a client calling in a loop, must not inflate the numbers.
    const { rows: counted } = await client.query<{ fresh: boolean }>(
      `INSERT INTO feed_post_views (post_id, user_id) VALUES ($1,$2)
       ON CONFLICT (post_id, user_id) DO UPDATE
         SET views = feed_post_views.views + 1, last_at = now()
         WHERE feed_post_views.last_at < now() - interval '30 minutes'
       RETURNING true AS fresh`,
      [postId, actor.id],
    );
    if (!counted[0]) { await client.query('ROLLBACK'); return null; }
    const { rows } = await client.query<{ views: string; reach: string }>(
      `SELECT COALESCE(sum(views),0)::text AS views, count(*)::text AS reach FROM feed_post_views WHERE post_id = $1`,
      [postId],
    );
    const viewCount = Number(rows[0]?.views ?? 0);
    const uniqueReach = Number(rows[0]?.reach ?? 0);
    await client.query('UPDATE feed_posts SET view_count = $2, unique_reach = $3 WHERE id = $1',
      [postId, viewCount, uniqueReach]);
    await client.query('COMMIT');
    return { viewCount, uniqueReach };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function bookmark(actor: FeedActor, postId: string): Promise<void> {
  await loadVisiblePost(actor, postId);
  await getPool().query(
    'INSERT INTO feed_bookmarks (user_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [actor.id, postId],
  );
}

export async function unbookmark(actor: FeedActor, postId: string): Promise<void> {
  await getPool().query('DELETE FROM feed_bookmarks WHERE user_id = $1 AND post_id = $2', [actor.id, postId]);
}

export async function recordShare(actor: FeedActor, postId: string): Promise<number> {
  await loadVisiblePost(actor, postId);
  const { rows } = await getPool().query<{ share_count: number }>(
    `UPDATE feed_posts SET share_count = share_count + 1
      WHERE id = $1 AND deleted_at IS NULL AND status = 'published' RETURNING share_count`,
    [postId],
  );
  if (!rows[0]) throw new FeedError('Post not found.', 404);
  return rows[0].share_count;
}

export interface RsvpResult { going: boolean; goingCount: number; }

export async function rsvpEvent(actor: FeedActor, postId: string, going: boolean): Promise<RsvpResult> {
  const post = await loadVisiblePost(actor, postId).catch(() => null);
  if (!post || post.status !== 'published' || !post.event) throw new FeedError('Event not found.', 404);
  if (going) {
    await getPool().query(
      `INSERT INTO feed_event_rsvps (post_id, user_id, status) VALUES ($1,$2,'going')
       ON CONFLICT (post_id, user_id) DO UPDATE SET status = 'going'`,
      [postId, actor.id],
    );
  } else {
    await getPool().query('DELETE FROM feed_event_rsvps WHERE post_id = $1 AND user_id = $2', [postId, actor.id]);
  }
  const { rows: countRows } = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM feed_event_rsvps WHERE post_id = $1 AND status = 'going'`, [postId],
  );
  return { going, goingCount: Number(countRows[0]?.n ?? 0) };
}
