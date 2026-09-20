/**
 * Reels — short vertical videos, published by a person directly (FR-FEED-13).
 *
 * Deliberately a separate, self-contained slice from feed_posts: a reel has
 * no page, no poll/event, one like instead of six reactions, and flat
 * (unnested) comments — see the migration header (0025) for why this isn't
 * bolted onto the page-centric post model instead.
 */
import type { PoolClient } from 'pg';
import { getPool, snowflake } from '@tupo/db';
import type {
  ComposeReelPayload, FeedAudience, FeedMediaItem, FeedPage_, FeedPerson, FeedReelCommentView, FeedReelView,
} from '@tupo/shared';
import { FEED_AUDIENCES, FEED_LIMITS } from '@tupo/shared';
import { FeedError } from './errors.js';
import { type FeedActor, assertVisible, can, canTargetAudience, clampLimit, decodeCursor, encodeCursor, visibleAudiences } from './common.js';
import { resolveMedia } from './posts.js';

interface ReelRow {
  id: string;
  author_id: string;
  caption: string;
  media: FeedMediaItem;
  audience: FeedAudience;
  like_count: number;
  comment_count: number;
  view_count: number;
  unique_reach: number;
  created_at: string;
}

function assertCanPostReel(actor: FeedActor): void {
  if (!can(actor, 'FEED_REEL_POST')) throw new FeedError('You cannot publish reels.', 403);
}

export async function createReel(actor: FeedActor, payload: ComposeReelPayload): Promise<{ reelId: string }> {
  assertCanPostReel(actor);
  const audience: FeedAudience =
    payload.audience && (FEED_AUDIENCES as readonly string[]).includes(payload.audience) ? payload.audience : 'everyone';
  if (!canTargetAudience(actor.roleLevel, audience)) throw new FeedError('You cannot post to that audience.', 403);
  if (!payload.media?.fileId) throw new FeedError('A reel needs a video.', 400);

  const caption = (payload.caption ?? '').slice(0, FEED_LIMITS.REEL_CAPTION_MAX);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const [media] = await resolveMedia(client, [payload.media], actor.id, 1);
    if (!media || media.kind !== 'video') throw new FeedError('A reel needs a video file.', 400);
    const id = snowflake();
    await client.query(
      `INSERT INTO feed_reels (id, author_id, caption, media, audience) VALUES ($1,$2,$3,$4,$5)`,
      [id, actor.id, caption, JSON.stringify(media), audience],
    );
    await client.query('COMMIT');
    return { reelId: id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteReel(actor: FeedActor, reelId: string): Promise<void> {
  const { rows } = await getPool().query<{ author_id: string }>(
    'SELECT author_id FROM feed_reels WHERE id = $1 AND deleted_at IS NULL', [reelId],
  );
  const reel = rows[0];
  if (!reel) throw new FeedError('Reel not found.', 404);
  const isOwner = reel.author_id === actor.id;
  const isModerator = can(actor, 'MODERATION_ACT') || actor.roleLevel === 'ADMIN';
  if (!isOwner && !isModerator) throw new FeedError('You cannot delete this reel.', 403);
  await getPool().query('UPDATE feed_reels SET deleted_at = now() WHERE id = $1', [reelId]);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Likes & comments
 * ────────────────────────────────────────────────────────────────────────── */

export interface ReelLikeResult { liked: boolean; likeCount: number; authorId: string; }

export async function toggleLike(actor: FeedActor, reelId: string): Promise<ReelLikeResult> {
  const { rows } = await getPool().query<{ author_id: string }>(
    `SELECT author_id FROM feed_reels WHERE id = $1 AND deleted_at IS NULL`, [reelId],
  );
  const reel = rows[0];
  if (!reel) throw new FeedError('Reel not found.', 404);
  if (!can(actor, 'FEED_COMMENT')) throw new FeedError('You cannot react.', 403);

  const client = await getPool().connect();
  let liked = false;
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      'DELETE FROM feed_reel_likes WHERE reel_id = $1 AND user_id = $2', [reelId, actor.id],
    );
    if (!rowCount) {
      await client.query(
        'INSERT INTO feed_reel_likes (reel_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [reelId, actor.id],
      );
      liked = true;
    }
    const { rows: countRows } = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM feed_reel_likes WHERE reel_id = $1', [reelId],
    );
    const likeCount = Number(countRows[0]?.n ?? 0);
    await client.query('UPDATE feed_reels SET like_count = $2 WHERE id = $1', [reelId, likeCount]);
    await client.query('COMMIT');
    return { liked, likeCount, authorId: reel.author_id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function addComment(actor: FeedActor, reelId: string, body: string): Promise<FeedReelCommentView> {
  if (!can(actor, 'FEED_COMMENT')) throw new FeedError('You cannot comment.', 403);
  const text = (body ?? '').trim().slice(0, FEED_LIMITS.REEL_COMMENT_BODY_MAX);
  if (!text) throw new FeedError('A comment needs some text.', 400);
  const { rows } = await getPool().query<{ author_id: string }>(
    'SELECT author_id FROM feed_reels WHERE id = $1 AND deleted_at IS NULL', [reelId],
  );
  if (!rows[0]) throw new FeedError('Reel not found.', 404);

  const client = await getPool().connect();
  const id = snowflake();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO feed_reel_comments (id, reel_id, author_id, body) VALUES ($1,$2,$3,$4)',
      [id, reelId, actor.id, text],
    );
    await client.query(
      `UPDATE feed_reels SET comment_count = (
          SELECT count(*) FROM feed_reel_comments WHERE reel_id = $1 AND deleted_at IS NULL
       ) WHERE id = $1`,
      [reelId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows: authorRows } = await getPool().query<{ id: string; name: string; avatar_url: string | null }>(
    'SELECT id, name, avatar_url FROM users WHERE id = $1', [actor.id],
  );
  const author: FeedPerson = { id: actor.id, name: authorRows[0]?.name ?? '', avatarUrl: authorRows[0]?.avatar_url ?? null };
  return { id, reelId, author, body: text, createdAt: new Date().toISOString(), canDelete: true };
}

export async function listComments(actor: FeedActor, reelId: string): Promise<FeedReelCommentView[]> {
  const { rows } = await getPool().query<{
    id: string; reel_id: string; author_id: string; body: string; created_at: string;
    author_name: string; author_avatar: string | null;
  }>(
    `SELECT c.id, c.reel_id, c.author_id, c.body, c.created_at, u.name AS author_name, u.avatar_url AS author_avatar
       FROM feed_reel_comments c JOIN users u ON u.id = c.author_id
      WHERE c.reel_id = $1 AND c.deleted_at IS NULL
      ORDER BY c.created_at ASC`,
    [reelId],
  );
  return rows.map((r) => ({
    id: r.id,
    reelId: r.reel_id,
    author: { id: r.author_id, name: r.author_name, avatarUrl: r.author_avatar },
    body: r.body,
    createdAt: r.created_at,
    canDelete: r.author_id === actor.id || can(actor, 'MODERATION_ACT') || actor.roleLevel === 'ADMIN',
  }));
}

export async function deleteComment(actor: FeedActor, commentId: string): Promise<{ reelId: string }> {
  const { rows } = await getPool().query<{ reel_id: string; author_id: string }>(
    'SELECT reel_id, author_id FROM feed_reel_comments WHERE id = $1 AND deleted_at IS NULL', [commentId],
  );
  const row = rows[0];
  if (!row) throw new FeedError('Comment not found.', 404);
  const isModerator = can(actor, 'MODERATION_ACT') || actor.roleLevel === 'ADMIN';
  if (row.author_id !== actor.id && !isModerator) throw new FeedError('You cannot delete this comment.', 403);

  await getPool().query('UPDATE feed_reel_comments SET deleted_at = now() WHERE id = $1', [commentId]);
  await getPool().query(
    `UPDATE feed_reels SET comment_count = (
        SELECT count(*) FROM feed_reel_comments WHERE reel_id = $1 AND deleted_at IS NULL
     ) WHERE id = $1`,
    [row.reel_id],
  );
  return { reelId: row.reel_id };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Views (same per-viewer identity pattern as feed_post_views)
 * ────────────────────────────────────────────────────────────────────────── */

export async function recordView(
  actor: FeedActor, reelId: string,
): Promise<{ viewCount: number; uniqueReach: number } | null> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: exists } = await client.query(
      'SELECT 1 FROM feed_reels WHERE id = $1 AND deleted_at IS NULL', [reelId],
    );
    if (!exists[0]) { await client.query('ROLLBACK'); return null; }
    await client.query(
      `INSERT INTO feed_reel_views (reel_id, user_id) VALUES ($1,$2)
       ON CONFLICT (reel_id, user_id) DO UPDATE SET views = feed_reel_views.views + 1, last_at = now()`,
      [reelId, actor.id],
    );
    const { rows } = await client.query<{ views: string; reach: string }>(
      `SELECT COALESCE(sum(views),0)::text AS views, count(*)::text AS reach FROM feed_reel_views WHERE reel_id = $1`,
      [reelId],
    );
    const viewCount = Number(rows[0]?.views ?? 0);
    const uniqueReach = Number(rows[0]?.reach ?? 0);
    await client.query('UPDATE feed_reels SET view_count = $2, unique_reach = $3 WHERE id = $1',
      [reelId, viewCount, uniqueReach]);
    await client.query('COMMIT');
    return { viewCount, uniqueReach };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Read path
 * ────────────────────────────────────────────────────────────────────────── */

function toView(actor: FeedActor, r: ReelRow & { author_name: string; author_avatar: string | null; author_role: string | null; liked: boolean }): FeedReelView {
  return {
    id: r.id,
    author: { id: r.author_id, name: r.author_name, avatarUrl: r.author_avatar, roleName: r.author_role },
    caption: r.caption,
    media: r.media,
    audience: r.audience,
    likeCount: r.like_count,
    commentCount: r.comment_count,
    viewCount: r.view_count,
    uniqueReach: r.unique_reach,
    liked: r.liked,
    canDelete: r.author_id === actor.id || can(actor, 'MODERATION_ACT') || actor.roleLevel === 'ADMIN',
    createdAt: r.created_at,
  };
}

/** Global reels feed, newest first — a personal, page-free stream (FR-FEED-13). */
export async function getReels(actor: FeedActor, cursor?: string | null, limit?: number): Promise<FeedPage_<FeedReelView>> {
  const pageSize = clampLimit(limit, FEED_LIMITS.REEL_PAGE_SIZE);
  const before = decodeCursor(cursor);
  const audiences = visibleAudiences(actor.roleLevel);
  const params: unknown[] = [audiences, actor.id];
  let keyset = '';
  if (before) { params.push(before.key, before.id); keyset = `AND (r.created_at, r.id) < ($3::timestamptz, $4)`; }
  params.push(pageSize + 1);

  const { rows } = await getPool().query<ReelRow & {
    author_name: string; author_avatar: string | null; author_role: string | null; liked: boolean;
  }>(
    `SELECT r.*, u.name AS author_name, u.avatar_url AS author_avatar, u.role AS author_role,
            (l.user_id IS NOT NULL) AS liked
       FROM feed_reels r
       JOIN users u ON u.id = r.author_id
       LEFT JOIN feed_reel_likes l ON l.reel_id = r.id AND l.user_id = $2
      WHERE r.deleted_at IS NULL AND r.audience = ANY($1) ${keyset}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toView(actor, r)),
    nextCursor: hasMore && last ? encodeCursor({ key: last.created_at, id: last.id }) : null,
  };
}

export async function getReel(actor: FeedActor, reelId: string): Promise<FeedReelView> {
  const { rows } = await getPool().query<ReelRow & {
    author_name: string; author_avatar: string | null; author_role: string | null; liked: boolean;
  }>(
    `SELECT r.*, u.name AS author_name, u.avatar_url AS author_avatar, u.role AS author_role,
            (l.user_id IS NOT NULL) AS liked
       FROM feed_reels r
       JOIN users u ON u.id = r.author_id
       LEFT JOIN feed_reel_likes l ON l.reel_id = r.id AND l.user_id = $2
      WHERE r.id = $1 AND r.deleted_at IS NULL`,
    [reelId, actor.id],
  );
  const row = rows[0];
  if (!row) throw new FeedError('Reel not found.', 404);
  assertVisible(actor, row.audience);
  return toView(actor, row);
}
