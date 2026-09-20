/**
 * Stories — ephemeral 24-hour statuses, grouped by author (FR-FEED-14).
 *
 * A story never appears in the main feed or in search; it lives only in the
 * stories bar until `expires_at`, at which point the worker's `story:sweep`
 * (see `sweepExpiredStories` below, wired the same way as `runFeedSweep`)
 * soft-deletes it. Like Reels, this is a person-authored slice independent of
 * feed_pages — see the migration header (0025) for why it isn't bolted onto
 * feed_posts.
 */
import { getPool, snowflake } from '@tupo/db';
import type {
  ComposeStoryPayload, FeedAudience, FeedMediaItem, FeedStoryGroup, FeedStoryView, FeedStoryViewer,
} from '@tupo/shared';
import { FEED_AUDIENCES, FEED_LIMITS } from '@tupo/shared';
import { FeedError } from './errors.js';
import { type FeedActor, assertVisible, can, canTargetAudience, visibleAudiences } from './common.js';
import { resolveMedia } from './posts.js';

interface StoryRow {
  id: string;
  author_id: string;
  media: FeedMediaItem[];
  caption: string;
  background: string;
  audience: FeedAudience;
  view_count: number;
  created_at: string;
  expires_at: string;
}

function assertCanPostStory(actor: FeedActor): void {
  if (!can(actor, 'FEED_STORY_POST')) throw new FeedError('You cannot publish a story.', 403);
}

export async function createStory(actor: FeedActor, payload: ComposeStoryPayload): Promise<{ storyId: string; expiresAt: string }> {
  assertCanPostStory(actor);
  const audience: FeedAudience =
    payload.audience && (FEED_AUDIENCES as readonly string[]).includes(payload.audience) ? payload.audience : 'everyone';
  if (!canTargetAudience(actor.roleLevel, audience)) throw new FeedError('You cannot post to that audience.', 403);

  const caption = (payload.caption ?? '').slice(0, FEED_LIMITS.STORY_CAPTION_MAX);
  const background = (payload.background ?? '').slice(0, 40);
  if (!caption.trim() && !payload.media?.fileId) {
    throw new FeedError('A story needs a photo, a video or some text.', 400);
  }

  const { rows: countRows } = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM feed_stories
      WHERE author_id = $1 AND deleted_at IS NULL AND expires_at > now()`,
    [actor.id],
  );
  if (Number(countRows[0]?.n ?? 0) >= FEED_LIMITS.MAX_ACTIVE_STORIES_PER_AUTHOR) {
    throw new FeedError(`You can have at most ${FEED_LIMITS.MAX_ACTIVE_STORIES_PER_AUTHOR} active stories.`, 409);
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const media = payload.media?.fileId ? await resolveMedia(client, [payload.media], actor.id, 1) : [];
    const id = snowflake();
    const expiresAt = new Date(Date.now() + FEED_LIMITS.STORY_TTL_HOURS * 3_600_000);
    await client.query(
      `INSERT INTO feed_stories (id, author_id, media, caption, background, audience, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, actor.id, JSON.stringify(media), caption, background, audience, expiresAt],
    );
    await client.query('COMMIT');
    return { storyId: id, expiresAt: expiresAt.toISOString() };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteStory(actor: FeedActor, storyId: string): Promise<{ authorId: string }> {
  const { rows } = await getPool().query<{ author_id: string }>(
    'SELECT author_id FROM feed_stories WHERE id = $1 AND deleted_at IS NULL', [storyId],
  );
  const story = rows[0];
  if (!story) throw new FeedError('Story not found.', 404);
  const isOwner = story.author_id === actor.id;
  const isModerator = can(actor, 'MODERATION_ACT') || actor.roleLevel === 'ADMIN';
  if (!isOwner && !isModerator) throw new FeedError('You cannot delete this story.', 403);
  await getPool().query('UPDATE feed_stories SET deleted_at = now() WHERE id = $1', [storyId]);
  return { authorId: story.author_id };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Views — one row per (story, viewer); "who viewed" reads it back directly.
 * ────────────────────────────────────────────────────────────────────────── */

export async function recordView(actor: FeedActor, storyId: string): Promise<{ viewCount: number } | null> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ author_id: string }>(
      `SELECT author_id FROM feed_stories WHERE id = $1 AND deleted_at IS NULL AND expires_at > now()`, [storyId],
    );
    const story = rows[0];
    if (!story) { await client.query('ROLLBACK'); return null; }
    // The author viewing their own story is not a "view" — it never left them.
    if (story.author_id !== actor.id) {
      await client.query(
        `INSERT INTO feed_story_views (story_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [storyId, actor.id],
      );
      const { rows: countRows } = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM feed_story_views WHERE story_id = $1', [storyId],
      );
      await client.query('UPDATE feed_stories SET view_count = $2 WHERE id = $1',
        [storyId, Number(countRows[0]?.n ?? 0)]);
    }
    await client.query('COMMIT');
    const { rows: viewRows } = await getPool().query<{ view_count: number }>(
      'SELECT view_count FROM feed_stories WHERE id = $1', [storyId],
    );
    return { viewCount: viewRows[0]?.view_count ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Who has seen this story — the author only (FR-FEED-14, "seen by" list). */
export async function getViewers(actor: FeedActor, storyId: string): Promise<FeedStoryViewer[]> {
  const { rows } = await getPool().query<{ author_id: string }>(
    'SELECT author_id FROM feed_stories WHERE id = $1 AND deleted_at IS NULL', [storyId],
  );
  const story = rows[0];
  if (!story) throw new FeedError('Story not found.', 404);
  if (story.author_id !== actor.id && actor.roleLevel !== 'ADMIN') {
    throw new FeedError('Only the author can see who viewed this story.', 403);
  }
  const { rows: viewers } = await getPool().query<{ id: string; name: string; avatar_url: string | null; viewed_at: string }>(
    `SELECT u.id, u.name, u.avatar_url, v.viewed_at FROM feed_story_views v
       JOIN users u ON u.id = v.user_id
      WHERE v.story_id = $1 ORDER BY v.viewed_at DESC`,
    [storyId],
  );
  return viewers.map((v) => ({ id: v.id, name: v.name, avatarUrl: v.avatar_url, viewedAt: v.viewed_at }));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Read path — grouped by author for the stories bar
 * ────────────────────────────────────────────────────────────────────────── */

function toView(r: StoryRow & { author_name: string; author_avatar: string | null; author_role: string | null; viewed: boolean }, actor: FeedActor): FeedStoryView {
  return {
    id: r.id,
    author: { id: r.author_id, name: r.author_name, avatarUrl: r.author_avatar, roleName: r.author_role },
    media: r.media?.[0] ?? null,
    caption: r.caption,
    background: r.background,
    audience: r.audience,
    viewCount: r.view_count,
    viewed: r.author_id === actor.id ? true : r.viewed,
    canDelete: r.author_id === actor.id || can(actor, 'MODERATION_ACT') || actor.roleLevel === 'ADMIN',
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

/**
 * Every active, audience-visible story, grouped by author — the viewer's own
 * group first (so they can always see/add to their own story), then everyone
 * else with an unseen story ahead of those already fully seen, most recent
 * first within each tier (Instagram/Facebook convention).
 */
export async function getActiveStories(actor: FeedActor): Promise<FeedStoryGroup[]> {
  const audiences = visibleAudiences(actor.roleLevel);
  const { rows } = await getPool().query<StoryRow & {
    author_name: string; author_avatar: string | null; author_role: string | null; viewed: boolean;
  }>(
    `SELECT s.*, u.name AS author_name, u.avatar_url AS author_avatar, u.role AS author_role,
            (v.user_id IS NOT NULL) AS viewed
       FROM feed_stories s
       JOIN users u ON u.id = s.author_id
       LEFT JOIN feed_story_views v ON v.story_id = s.id AND v.user_id = $2
      WHERE s.deleted_at IS NULL AND s.expires_at > now()
        AND (s.audience = ANY($1) OR s.author_id = $2)
      ORDER BY s.author_id, s.created_at ASC`,
    [audiences, actor.id],
  );

  const byAuthor = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byAuthor.has(r.author_id)) byAuthor.set(r.author_id, []);
    byAuthor.get(r.author_id)!.push(r);
  }

  const groups: FeedStoryGroup[] = [...byAuthor.values()].map((authorRows) => {
    const stories = authorRows.map((r) => toView(r, actor));
    return {
      author: stories[0]!.author,
      stories,
      allViewed: stories.every((s) => s.viewed),
      latestAt: stories[stories.length - 1]!.createdAt,
    };
  });

  groups.sort((a, b) => {
    if (a.author.id === actor.id) return -1;
    if (b.author.id === actor.id) return 1;
    if (a.allViewed !== b.allViewed) return a.allViewed ? 1 : -1;
    return Date.parse(b.latestAt) - Date.parse(a.latestAt);
  });
  return groups;
}

export async function getStory(actor: FeedActor, storyId: string): Promise<FeedStoryView> {
  const { rows } = await getPool().query<StoryRow & {
    author_name: string; author_avatar: string | null; author_role: string | null; viewed: boolean;
  }>(
    `SELECT s.*, u.name AS author_name, u.avatar_url AS author_avatar, u.role AS author_role,
            (v.user_id IS NOT NULL) AS viewed
       FROM feed_stories s
       JOIN users u ON u.id = s.author_id
       LEFT JOIN feed_story_views v ON v.story_id = s.id AND v.user_id = $2
      WHERE s.id = $1 AND s.deleted_at IS NULL AND s.expires_at > now()`,
    [storyId, actor.id],
  );
  const row = rows[0];
  if (!row) throw new FeedError('Story not found.', 404);
  if (row.author_id !== actor.id) assertVisible(actor, row.audience);
  return toView(row, actor);
}

/** For the worker sweep — expire stories whose 24 hours are up. */
export async function sweepExpiredStories(): Promise<{ expired: number }> {
  const { rowCount } = await getPool().query(
    `UPDATE feed_stories SET deleted_at = now() WHERE deleted_at IS NULL AND expires_at <= now()`,
  );
  return { expired: rowCount ?? 0 };
}
