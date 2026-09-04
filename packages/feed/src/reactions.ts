/**
 * Reactions on posts and comments (FR-FEED-5). One per user per target;
 * tapping the same emoji again removes it, tapping a different one switches.
 */
import { getPool } from '@tupo/db';
import type { FeedReaction, FeedReactionSummary } from '@tupo/shared';
import { FEED_REACTIONS } from '@tupo/shared';
import { FeedError } from './errors.js';
import { type FeedActor, can, normalizeReaction } from './common.js';

async function assertReactable(actor: FeedActor): Promise<void> {
  if (!can(actor, 'FEED_COMMENT')) throw new FeedError('You cannot react.', 403);
}

export interface PostReactionResult {
  summary: FeedReactionSummary;
  postAuthorId: string;
  pageId: string;
  added: FeedReaction | null;
}

export async function reactToPost(
  actor: FeedActor, postId: string, emoji: string | null,
): Promise<PostReactionResult> {
  await assertReactable(actor);
  const { rows: postRows } = await getPool().query<{ author_id: string; page_id: string; status: string }>(
    `SELECT author_id, page_id, status FROM feed_posts WHERE id = $1 AND deleted_at IS NULL`, [postId],
  );
  const post = postRows[0];
  if (!post || post.status !== 'published') throw new FeedError('Post not found.', 404);

  const client = await getPool().connect();
  let added: FeedReaction | null = null;
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query<{ emoji: string }>(
      'SELECT emoji FROM feed_reactions WHERE post_id = $1 AND user_id = $2', [postId, actor.id],
    );
    if (emoji === null || (existing[0] && existing[0].emoji === emoji)) {
      await client.query('DELETE FROM feed_reactions WHERE post_id = $1 AND user_id = $2', [postId, actor.id]);
    } else {
      const e = normalizeReaction(emoji);
      added = e;
      await client.query(
        `INSERT INTO feed_reactions (post_id, user_id, emoji) VALUES ($1,$2,$3)
         ON CONFLICT (post_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()`,
        [postId, actor.id, e],
      );
    }
    await client.query(
      `UPDATE feed_posts SET reaction_count = (SELECT count(*) FROM feed_reactions WHERE post_id = $1) WHERE id = $1`,
      [postId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { summary: await postReactionSummary(actor, postId), postAuthorId: post.author_id, pageId: post.page_id, added };
}

export async function postReactionSummary(actor: FeedActor, postId: string): Promise<FeedReactionSummary> {
  const pool = getPool();
  const { rows } = await pool.query<{ emoji: string; n: string }>(
    `SELECT emoji, count(*)::text AS n FROM feed_reactions WHERE post_id = $1 GROUP BY emoji`, [postId],
  );
  const { rows: mineRows } = await pool.query<{ emoji: string }>(
    'SELECT emoji FROM feed_reactions WHERE post_id = $1 AND user_id = $2', [postId, actor.id],
  );
  const { rows: sample } = await pool.query<{ id: string; name: string; avatar_url: string | null }>(
    `SELECT u.id, u.name, u.avatar_url FROM feed_reactions r JOIN users u ON u.id = r.user_id
      WHERE r.post_id = $1 ORDER BY r.created_at DESC LIMIT 3`, [postId],
  );
  const byEmoji: Partial<Record<FeedReaction, number>> = {};
  let total = 0;
  for (const r of rows) {
    if ((FEED_REACTIONS as readonly string[]).includes(r.emoji)) { byEmoji[r.emoji as FeedReaction] = Number(r.n); total += Number(r.n); }
  }
  const top = (Object.entries(byEmoji) as Array<[FeedReaction, number]>)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e);
  return {
    total, byEmoji, top,
    mine: mineRows[0] && (FEED_REACTIONS as readonly string[]).includes(mineRows[0].emoji)
      ? (mineRows[0].emoji as FeedReaction) : null,
    sample: sample.map((s) => ({ id: s.id, name: s.name, avatarUrl: s.avatar_url })),
  };
}

export interface CommentReactionResult { postId: string; reactionCount: number; commentAuthorId: string; }

export async function reactToComment(
  actor: FeedActor, commentId: string, emoji: string | null,
): Promise<CommentReactionResult> {
  await assertReactable(actor);
  const { rows: cRows } = await getPool().query<{ post_id: string; author_id: string }>(
    'SELECT post_id, author_id FROM feed_comments WHERE id = $1 AND deleted_at IS NULL', [commentId],
  );
  const comment = cRows[0];
  if (!comment) throw new FeedError('Comment not found.', 404);

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query<{ emoji: string }>(
      'SELECT emoji FROM feed_comment_reactions WHERE comment_id = $1 AND user_id = $2', [commentId, actor.id],
    );
    if (emoji === null || (existing[0] && existing[0].emoji === emoji)) {
      await client.query('DELETE FROM feed_comment_reactions WHERE comment_id = $1 AND user_id = $2', [commentId, actor.id]);
    } else {
      const e = normalizeReaction(emoji);
      await client.query(
        `INSERT INTO feed_comment_reactions (comment_id, user_id, emoji) VALUES ($1,$2,$3)
         ON CONFLICT (comment_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()`,
        [commentId, actor.id, e],
      );
    }
    await client.query(
      `UPDATE feed_comments SET reaction_count = (SELECT count(*) FROM feed_comment_reactions WHERE comment_id = $1) WHERE id = $1`,
      [commentId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await getPool().query<{ reaction_count: number }>(
    'SELECT reaction_count FROM feed_comments WHERE id = $1', [commentId],
  );
  return { postId: comment.post_id, reactionCount: rows[0]?.reaction_count ?? 0, commentAuthorId: comment.author_id };
}
