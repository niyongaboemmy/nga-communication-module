/**
 * Announcing a newly published post: notify the followers allowed to see it
 * and push it live to every open feed. One path for every way a post goes
 * live — published from the composer, published from a draft, or published
 * by the scheduled sweep (FEED-B3, which used to go live silently).
 *
 * It runs in the worker (`feed:announce`), not in the publishing request: for
 * a mandatory page the follower list is the whole school (FEED-P4).
 */
import { getPool, resolveUserPermissions } from '@tupo/db';
import { feedAudienceRoom } from '@tupo/shared';
import type { FeedAudience, FeedPostView } from '@tupo/shared';
import { notifyAndPush, relay } from '@tupo/notify';
import { effectiveAudience, levelsThatSee, type FeedActor } from './common.js';
import { getPostView } from './posts.js';

/** A post as broadcast to everyone: no viewer-specific fields. */
export function neutralPost(post: FeedPostView): FeedPostView {
  return {
    ...post,
    canEdit: false, canPin: false, canModerate: false, bookmarked: false,
    reactions: { ...post.reactions, mine: null },
    poll: post.poll ? { ...post.poll, myVotes: [] } : post.poll,
    event: post.event ? { ...post.event, going: false } : post.event,
    page: { ...post.page, following: false, myRole: null },
  };
}

export async function announcePost(postId: string): Promise<{ notified: number; delivered: number }> {
  const pool = getPool();
  const { rows } = await pool.query<{
    author_id: string; type: string; audience: FeedAudience; page_audience: FeedAudience; page_name: string;
  }>(
    `SELECT p.author_id, p.type, p.audience, pg.audience AS page_audience, pg.name AS page_name
       FROM feed_posts p JOIN feed_pages pg ON pg.id = p.page_id
      WHERE p.id = $1 AND p.status = 'published' AND p.deleted_at IS NULL AND pg.deleted_at IS NULL`,
    [postId],
  );
  const meta = rows[0];
  // Unpublished or deleted again before this ran: nothing to announce.
  if (!meta) return { notified: 0, delivered: 0 };

  // Only followers who may see it: the post's and the page's audience both
  // have to include their role (same rule as every read path).
  const levels = levelsThatSee(effectiveAudience(meta.audience, meta.page_audience));
  const named = levels.filter((l): l is NonNullable<typeof l> => l !== null);
  const { rows: followers } = await pool.query<{ user_id: string; notify: boolean }>(
    `SELECT f.user_id, f.notify
       FROM feed_page_followers f
       JOIN feed_posts p ON p.page_id = f.page_id
       JOIN users u ON u.id = f.user_id AND u.status = 'active'
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE p.id = $1 AND f.user_id <> $4
        AND (r.level = ANY($2::text[]) OR ($3 AND r.level IS NULL))`,
    [postId, named, levels.includes(null), meta.author_id],
  );

  const notifyIds = followers.filter((f) => f.notify).map((f) => f.user_id);
  if (notifyIds.length) {
    const announcement = meta.type === 'announcement';
    await notifyAndPush(notifyIds, {
      kind: announcement ? 'feed.announcement' : 'feed.published',
      title: announcement ? `📣 ${meta.page_name}` : meta.page_name,
      body: announcement ? 'posted an announcement' : 'shared a new post',
      link: `/app/feed/post/${postId}`, subjectType: 'feed_post', subjectId: postId,
    }).catch(() => {});
  }

  // Built as its author sees it, then stripped of everything viewer-specific.
  const access = await resolveUserPermissions(pool, meta.author_id);
  const author: FeedActor = {
    id: meta.author_id,
    roleLevel: (access?.roleLevel ?? null) as FeedActor['roleLevel'],
    permissions: access?.permissions ?? new Set(),
  };
  const post = neutralPost(await getPostView(author, postId));
  // One relay to the union of rooms: Socket.IO delivers once per socket even
  // when it is in several of them (author, followers, the audience band).
  await relay(
    [...new Set([meta.author_id, ...followers.map((f) => f.user_id)])].map((id) => `user:${id}`)
      .concat(feedAudienceRoom(post.audience)),
    'feed:post_new', { post },
  );
  return { notified: notifyIds.length, delivered: followers.length };
}
