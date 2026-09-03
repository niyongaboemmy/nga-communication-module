/**
 * Page analytics (FR-FEED-10) — impressions, unique reach, engagement and
 * follower growth for the people who run a page.
 */
import { getPool } from '@tupo/db';
import type { FeedPageAnalytics } from '@tupo/shared';
import { FeedError } from './errors.js';
import { type FeedActor, can } from './common.js';

const RANGE_DAYS: Record<'7d' | '30d' | 'all', number> = { '7d': 7, '30d': 30, all: 3650 };

export async function pageAnalytics(
  actor: FeedActor, pageId: string, range: '7d' | '30d' | 'all' = '30d',
): Promise<FeedPageAnalytics> {
  const { rows: editorRows } = await getPool().query<{ role: string }>(
    'SELECT role FROM feed_page_editors WHERE page_id = $1 AND user_id = $2', [pageId, actor.id],
  );
  const isPageAdmin = editorRows.length > 0 || actor.roleLevel === 'ADMIN';
  if (!isPageAdmin && !can(actor, 'FEED_ANALYTICS_VIEW')) {
    throw new FeedError('You cannot view analytics for this page.', 403);
  }
  const { rows: pageRows } = await getPool().query<{ follower_count: number }>(
    'SELECT follower_count FROM feed_pages WHERE id = $1 AND deleted_at IS NULL', [pageId],
  );
  if (!pageRows[0]) throw new FeedError('Page not found.', 404);

  const days = RANGE_DAYS[range];
  const since = `now() - ($2 || ' days')::interval`;

  const { rows: totals } = await getPool().query<{
    posts: string; impressions: string; reach: string; reactions: string; comments: string; shares: string;
  }>(
    `SELECT count(*)::text AS posts,
            COALESCE(sum(view_count),0)::text AS impressions,
            COALESCE(sum(unique_reach),0)::text AS reach,
            COALESCE(sum(reaction_count),0)::text AS reactions,
            COALESCE(sum(comment_count),0)::text AS comments,
            COALESCE(sum(share_count),0)::text AS shares
       FROM feed_posts
      WHERE page_id = $1 AND deleted_at IS NULL AND status = 'published'
        AND published_at >= ${since}`,
    [pageId, days],
  );

  const { rows: growth } = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM feed_page_followers
      WHERE page_id = $1 AND followed_at >= ${since}`,
    [pageId, days],
  );

  const { rows: series } = await getPool().query<{
    date: string; impressions: string; reactions: string; comments: string;
  }>(
    `SELECT to_char(d::date, 'YYYY-MM-DD') AS date,
            COALESCE(sum(p.view_count) FILTER (WHERE p.published_at::date = d::date), 0)::text AS impressions,
            COALESCE(sum(p.reaction_count) FILTER (WHERE p.published_at::date = d::date), 0)::text AS reactions,
            COALESCE(sum(p.comment_count) FILTER (WHERE p.published_at::date = d::date), 0)::text AS comments
       FROM generate_series(now()::date - ($2 - 1) * interval '1 day', now()::date, interval '1 day') d
       LEFT JOIN feed_posts p
         ON p.page_id = $1 AND p.deleted_at IS NULL AND p.status = 'published'
      GROUP BY d ORDER BY d`,
    [pageId, Math.min(days, 30)],
  );

  const { rows: topPosts } = await getPool().query<{
    id: string; body: string; published_at: string; view_count: number; reaction_count: number; comment_count: number;
  }>(
    `SELECT id, body, published_at, view_count, reaction_count, comment_count
       FROM feed_posts
      WHERE page_id = $1 AND deleted_at IS NULL AND status = 'published' AND published_at >= ${since}
      ORDER BY (reaction_count * 2 + comment_count * 3 + view_count) DESC
      LIMIT 5`,
    [pageId, days],
  );

  const t = totals[0]!;
  return {
    range,
    totals: {
      posts: Number(t.posts),
      impressions: Number(t.impressions),
      uniqueReach: Number(t.reach),
      reactions: Number(t.reactions),
      comments: Number(t.comments),
      shares: Number(t.shares),
      followerCount: pageRows[0].follower_count,
      followerGrowth: Number(growth[0]?.n ?? 0),
    },
    series: series.map((s) => ({
      date: s.date, impressions: Number(s.impressions), reactions: Number(s.reactions), comments: Number(s.comments),
    })),
    topPosts: topPosts.map((p) => ({
      id: p.id,
      body: p.body.slice(0, 140),
      publishedAt: p.published_at,
      impressions: p.view_count,
      reactions: p.reaction_count,
      comments: p.comment_count,
    })),
  };
}
