/**
 * The one answer to "may this person see — and therefore engage with — this
 * post?" (D-01).
 *
 * A post is visible when it is published and not deleted, its page is not
 * deleted, and *both* the post's audience and its page's audience include the
 * person's role. The page counts too: a post written on a staff-only page is
 * staff-only, whatever the composer defaulted to. The page's own team always
 * sees its posts, drafts included.
 *
 * Every engagement path — comments, replies, reactions (on posts and on
 * comments), polls, RSVPs, bookmarks, views, shares — and the reel
 * equivalents go through here, so the permalink, the feed and the actions
 * beside a post cannot disagree about who it is for.
 */
import { getPool } from '@tupo/db';
import type { FeedAudience } from '@tupo/shared';
import { FeedError } from './errors.js';
import { visibleAudiences, type FeedActor } from './common.js';

export interface VisiblePost {
  id: string;
  page_id: string;
  author_id: string;
  status: string;
  comment_policy: string;
  audience: FeedAudience;
  page_audience: FeedAudience;
  editor_role: string | null;
  following: boolean;
  poll: { question: string; options: string[]; multi: boolean; closesAt: string | null } | null;
  event: Record<string, unknown> | null;
}

export async function loadVisiblePost(
  actor: FeedActor, postId: string, opts: { allowUnpublished?: boolean } = {},
): Promise<VisiblePost> {
  const { rows } = await getPool().query<VisiblePost>(
    `SELECT fp.id, fp.page_id, fp.author_id, fp.status, fp.comment_policy, fp.audience,
            fp.poll, fp.event, pg.audience AS page_audience,
            e.role AS editor_role, (f.user_id IS NOT NULL) AS following
       FROM feed_posts fp
       JOIN feed_pages pg ON pg.id = fp.page_id AND pg.deleted_at IS NULL
       LEFT JOIN feed_page_editors e ON e.page_id = fp.page_id AND e.user_id = $2
       LEFT JOIN feed_page_followers f ON f.page_id = fp.page_id AND f.user_id = $2
      WHERE fp.id = $1 AND fp.deleted_at IS NULL`,
    [postId, actor.id],
  );
  const post = rows[0];
  if (!post) throw new FeedError('Post not found.', 404);
  if (post.editor_role !== null) return post;   // the page's own team
  if (post.status !== 'published' && !opts.allowUnpublished) throw new FeedError('Post not found.', 404);
  const allowed = visibleAudiences(actor.roleLevel);
  if (!allowed.includes(post.audience) || !allowed.includes(post.page_audience)) {
    throw new FeedError('Post not found.', 404);
  }
  return post;
}

/** The post a comment belongs to, checked the same way. */
export async function loadVisibleComment(
  actor: FeedActor, commentId: string,
): Promise<{ comment: { id: string; post_id: string; author_id: string; parent_id: string | null }; post: VisiblePost }> {
  const { rows } = await getPool().query<{ id: string; post_id: string; author_id: string; parent_id: string | null }>(
    'SELECT id, post_id, author_id, parent_id FROM feed_comments WHERE id = $1 AND deleted_at IS NULL', [commentId],
  );
  if (!rows[0]) throw new FeedError('Comment not found.', 404);
  return { comment: rows[0], post: await loadVisiblePost(actor, rows[0].post_id) };
}

/** Reels have one audience of their own and an author; same rule. */
export async function loadVisibleReel(
  actor: FeedActor, reelId: string,
): Promise<{ id: string; author_id: string; audience: FeedAudience }> {
  const { rows } = await getPool().query<{ id: string; author_id: string; audience: FeedAudience }>(
    'SELECT id, author_id, audience FROM feed_reels WHERE id = $1 AND deleted_at IS NULL', [reelId],
  );
  const reel = rows[0];
  if (!reel) throw new FeedError('Reel not found.', 404);
  if (reel.author_id !== actor.id && !visibleAudiences(actor.roleLevel).includes(reel.audience)) {
    throw new FeedError('Reel not found.', 404);
  }
  return reel;
}
