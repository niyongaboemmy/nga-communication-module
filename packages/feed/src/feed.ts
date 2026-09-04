/**
 * The feed read path — hybrid fan-out merge (FR-FEED-6, 7).
 *
 * Candidates come from two places:
 *   1. `feed_timeline` — rows fanned out at publish time for ordinary pages.
 *   2. A read-time query for pages that are *mandatory* or above the fan-out
 *      threshold: their posts are never written to a timeline, so they are
 *      merged in here for the followers who should see them.
 *
 * `sort=recent` is a keyset scan on `(published_at, id)`. `sort=top` scores a
 * recent window with `rankScore` and pages by offset — pinned and announcement
 * posts always land first (FR-FEED-6).
 */
import { getPool } from '@tupo/db';
import type { FeedFilter, FeedPostView, FeedSort, FeedTimelinePage } from '@tupo/shared';
import { FEED_LIMITS } from '@tupo/shared';
import {
  type FeedActor, clampLimit, decodeCursor, encodeCursor, rankScore, visibleAudiences,
} from './common.js';
import { hydratePosts } from './posts.js';

export interface GetFeedOpts {
  cursor?: string | null;
  sort?: FeedSort;
  filter?: FeedFilter;
  /** Restrict to one page — the page-profile feed. */
  pageId?: string | null;
  limit?: number;
}

const TOP_WINDOW = 150;

/**
 * The candidate id list for a viewer + filter, newest first. Audience-scoped.
 * `before` is the keyset boundary for recent paging; ignored for top.
 */
async function candidateIds(
  actor: FeedActor, opts: GetFeedOpts, before: { key: string; id: string } | null, limit: number,
): Promise<Array<{ id: string; published_at: string }>> {
  const audiences = visibleAudiences(actor.roleLevel);
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  // Bound once, referenced by whichever branches actually need it below —
  // NOT unconditionally like `actor.id` used to be. A param pushed into
  // `params` but never referenced in the query text (the pageId branch
  // doesn't filter by actor at all) makes Postgres unable to infer its type
  // and the whole query 500s with "could not determine data type of
  // parameter $1", which is exactly what a page's own post list did.
  const audP = p(audiences);

  let source: string;
  if (opts.filter === 'bookmarks') {
    const actorP = p(actor.id);
    source = `
      SELECT fp.id, fp.published_at
        FROM feed_bookmarks bm
        JOIN feed_posts fp ON fp.id = bm.post_id
       WHERE bm.user_id = ${actorP} AND fp.deleted_at IS NULL AND fp.status = 'published'
         AND fp.audience = ANY(${audP})`;
  } else if (opts.pageId) {
    source = `
      SELECT fp.id, fp.published_at
        FROM feed_posts fp
       WHERE fp.page_id = ${p(opts.pageId)} AND fp.deleted_at IS NULL AND fp.status = 'published'
         AND fp.audience = ANY(${audP})`;
  } else {
    // timeline ∪ read-time merge of big / mandatory pages the user follows
    const followFilter = opts.filter === 'following' ? `AND t.reason = 'follow'` : '';
    const annFilter = opts.filter === 'announcements' ? `AND fp.type = 'announcement'` : '';
    const actorP = p(actor.id);
    source = `
      SELECT fp.id, fp.published_at FROM feed_timeline t
        JOIN feed_posts fp ON fp.id = t.post_id
       WHERE t.user_id = ${actorP} AND fp.deleted_at IS NULL AND fp.status = 'published'
         AND fp.audience = ANY(${audP}) ${followFilter} ${annFilter}
      UNION
      SELECT fp.id, fp.published_at FROM feed_page_followers f
        JOIN feed_pages pg ON pg.id = f.page_id AND pg.deleted_at IS NULL
        JOIN feed_posts fp ON fp.page_id = pg.id
       WHERE f.user_id = ${actorP} AND (pg.mandatory OR pg.follower_count > ${p(FEED_LIMITS.FANOUT_THRESHOLD)})
         AND fp.deleted_at IS NULL AND fp.status = 'published' AND fp.audience = ANY(${audP})
         ${opts.filter === 'announcements' ? `AND fp.type = 'announcement'` : ''}`;
  }

  const keyset = before && (opts.sort ?? 'recent') === 'recent'
    ? `AND (c.published_at, c.id) < (${p(before.key)}::timestamptz, ${p(before.id)})`
    : '';

  const { rows } = await getPool().query<{ id: string; published_at: string }>(
    `SELECT c.id, c.published_at FROM ( ${source} ) c
      WHERE true ${keyset}
      ORDER BY c.published_at DESC, c.id DESC
      LIMIT ${p(limit)}`,
    params,
  );
  return rows;
}

export async function getFeed(actor: FeedActor, opts: GetFeedOpts = {}): Promise<FeedTimelinePage> {
  const sort: FeedSort = opts.sort === 'top' ? 'top' : 'recent';
  const limit = clampLimit(opts.limit);

  if (sort === 'top') {
    const window = await candidateIds(actor, opts, null, TOP_WINDOW);
    const map = await hydratePosts(actor, window.map((w) => w.id));
    const scored = [...map.values()]
      .map((v) => ({ v, s: rankScore({
        reactions: v.reactions.total, comments: v.commentCount, shares: v.shareCount,
        publishedAt: new Date(v.publishedAt ?? v.createdAt), pinned: v.pinned, type: v.type,
      }) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.v);
    const offset = Number(decodeCursor(opts.cursor)?.key ?? '0') || 0;
    const slice = scored.slice(offset, offset + limit);
    const next = offset + limit < scored.length ? encodeCursor({ key: String(offset + limit), id: 'top' }) : null;
    return { items: slice, nextCursor: next };
  }

  const before = decodeCursor(opts.cursor);
  const rows = await candidateIds(actor, opts, before, limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const map = await hydratePosts(actor, pageRows.map((r) => r.id));
  const items = pageRows.map((r) => map.get(r.id)).filter((v): v is FeedPostView => Boolean(v));
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ key: last.published_at, id: last.id }) : null;
  return { items, nextCursor };
}
