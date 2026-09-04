/**
 * Posts — creation, lifecycle, editing, hydration and fan-out (FR-FEED-2…7).
 *
 * The lifecycle is `draft → scheduled → published → unpublished`. Only a
 * published post is ever visible in a feed or fanned out. Editing a published
 * post writes a `feed_post_edits` row so the history is real (FR-FEED-4).
 */
import type { PoolClient } from 'pg';
import { getPool, snowflake } from '@tupo/db';
import type {
  ComposePostPayload, EditPostPayload, FeedAudience, FeedCommentPolicy, FeedMediaItem,
  FeedPerson, FeedPollView, FeedPostType, FeedPostView, FeedReaction, FeedReactionSummary,
} from '@tupo/shared';
import { FEED_AUDIENCES, FEED_LIMITS, FEED_REACTIONS } from '@tupo/shared';
import { FeedError } from './errors.js';
import {
  type FeedActor, assertVisible, can, canTargetAudience, rankScore, visibleAudiences,
} from './common.js';
import { toPageSummary, type PageRow } from './pages.js';

/* ────────────────────────────────────────────────────────────────────────── *
 * Row shape
 * ────────────────────────────────────────────────────────────────────────── */

interface PostRow {
  id: string;
  page_id: string;
  author_id: string;
  body: string;
  format: 'plain' | 'rich';
  media: FeedMediaItem[];
  link_preview: FeedPostView['linkPreview'];
  type: FeedPostType;
  poll: { question: string; options: string[]; multi: boolean; closesAt: string | null } | null;
  event: { title: string; startsAt: string; endsAt: string | null; location: string | null; meetingId: string | null } | null;
  audience: FeedAudience;
  status: FeedPostView['status'];
  scheduled_at: string | null;
  published_at: string | null;
  pinned: boolean;
  comment_policy: FeedCommentPolicy;
  edited_at: string | null;
  reaction_count: number;
  comment_count: number;
  view_count: number;
  unique_reach: number;
  share_count: number;
  created_at: string;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Validation helpers
 * ────────────────────────────────────────────────────────────────────────── */

async function resolveMedia(
  client: PoolClient, media: FeedMediaItem[] | undefined, ownerId: string,
): Promise<FeedMediaItem[]> {
  const items = (media ?? []).slice(0, FEED_LIMITS.MAX_MEDIA);
  if (!items.length) return [];
  const ids = items.map((m) => m.fileId).filter(Boolean);
  const { rows } = await client.query<{ id: string; owner_id: string; status: string; mime_type: string; original_name: string; size_bytes: string }>(
    `SELECT id, owner_id, status, mime_type, original_name, size_bytes FROM files WHERE id = ANY($1)`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return items.map((m) => {
    const f = byId.get(m.fileId);
    if (!f) throw new FeedError('An attachment could not be found.', 400);
    if (f.owner_id !== ownerId) throw new FeedError('An attachment is not yours to post.', 403);
    if (f.status !== 'ready' && f.status !== 'pending') throw new FeedError('An attachment failed to upload.', 409);
    const kind: FeedMediaItem['kind'] =
      f.mime_type.startsWith('image/') ? 'image' : f.mime_type.startsWith('video/') ? 'video' : 'document';
    return {
      fileId: f.id, kind, name: f.original_name, mime: f.mime_type, size: Number(f.size_bytes),
      w: m.w ?? null, h: m.h ?? null,
    };
  });
}

function validatePoll(input: ComposePostPayload['poll']): PostRow['poll'] {
  if (!input) return null;
  const question = (input.question ?? '').trim();
  const options = (input.options ?? []).map((o) => o.trim()).filter(Boolean);
  if (!question) throw new FeedError('A poll needs a question.', 400);
  if (options.length < FEED_LIMITS.MIN_POLL_OPTIONS) throw new FeedError('A poll needs at least two options.', 400);
  if (options.length > FEED_LIMITS.MAX_POLL_OPTIONS) throw new FeedError(`A poll can have at most ${FEED_LIMITS.MAX_POLL_OPTIONS} options.`, 400);
  return { question, options, multi: Boolean(input.multi), closesAt: input.closesAt ?? null };
}

function validateEvent(input: ComposePostPayload['event']): PostRow['event'] {
  if (!input) return null;
  const title = (input.title ?? '').trim();
  if (!title) throw new FeedError('An event needs a title.', 400);
  if (!input.startsAt || Number.isNaN(Date.parse(input.startsAt))) throw new FeedError('An event needs a start time.', 400);
  return {
    title,
    startsAt: new Date(input.startsAt).toISOString(),
    endsAt: input.endsAt ? new Date(input.endsAt).toISOString() : null,
    location: input.location?.trim() || null,
    meetingId: input.meetingId ?? null,
  };
}

function resolveType(payload: ComposePostPayload): FeedPostType {
  if (payload.poll) return 'poll';
  if (payload.event) return 'event';
  if (payload.type === 'announcement') return 'announcement';
  return 'standard';
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Authorisation
 * ────────────────────────────────────────────────────────────────────────── */

export async function assertCanPostAs(actor: FeedActor, pageId: string, audience: FeedAudience): Promise<PageRow> {
  if (!can(actor, 'FEED_POST')) throw new FeedError('You cannot publish posts.', 403);
  const { rows } = await getPool().query<PageRow & { my_follow: boolean; my_notify: boolean; my_editor_role: 'owner' | 'editor' | null }>(
    `SELECT p.*, true AS my_follow, true AS my_notify, e.role AS my_editor_role
       FROM feed_pages p
       LEFT JOIN feed_page_editors e ON e.page_id = p.id AND e.user_id = $2
      WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [pageId, actor.id],
  );
  const row = rows[0];
  if (!row) throw new FeedError('Page not found.', 404);
  if (!row.my_editor_role && actor.roleLevel !== 'ADMIN') {
    throw new FeedError('You are not an editor of this page.', 403);
  }
  if (!canTargetAudience(actor.roleLevel, audience)) {
    throw new FeedError('You cannot post to that audience.', 403);
  }
  return row as unknown as PageRow;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Create
 * ────────────────────────────────────────────────────────────────────────── */

export interface CreateResult { postId: string; status: FeedPostView['status']; }

export async function createPost(actor: FeedActor, payload: ComposePostPayload): Promise<CreateResult> {
  const audience: FeedAudience =
    payload.audience && (FEED_AUDIENCES as readonly string[]).includes(payload.audience) ? payload.audience : 'everyone';
  await assertCanPostAs(actor, payload.pageId, audience);

  const body = (payload.body ?? '').slice(0, FEED_LIMITS.POST_BODY_MAX);
  const poll = validatePoll(payload.poll);
  const event = validateEvent(payload.event);
  const type = resolveType(payload);
  if (type === 'announcement' && !can(actor, 'FEED_POST')) throw new FeedError('You cannot post announcements.', 403);

  const wantStatus = payload.status ?? 'published';
  if (wantStatus === 'scheduled') {
    if (!payload.scheduledAt || Date.parse(payload.scheduledAt) <= Date.now()) {
      throw new FeedError('A scheduled post needs a time in the future.', 400);
    }
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const media = await resolveMedia(client, payload.media, actor.id);
    if (!body.trim() && !media.length && !poll && !event) {
      throw new FeedError('A post needs text, media, a poll or an event.', 400);
    }
    const id = snowflake();
    const status = wantStatus;
    const publishedAt = status === 'published' ? new Date() : null;

    await client.query(
      `INSERT INTO feed_posts
        (id, page_id, author_id, body, format, media, link_preview, type, poll, event,
         audience, status, scheduled_at, published_at, pinned, comment_policy)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id, payload.pageId, actor.id, body, payload.format === 'rich' ? 'rich' : 'plain',
        JSON.stringify(media), payload.linkPreview ? JSON.stringify(payload.linkPreview) : null,
        type, poll ? JSON.stringify(poll) : null, event ? JSON.stringify(event) : null,
        audience, status, status === 'scheduled' ? payload.scheduledAt : null, publishedAt,
        Boolean(payload.pinned), payload.commentPolicy ?? 'open',
      ],
    );

    if (status === 'published') {
      await onPublished(client, id);
    }
    await client.query('COMMIT');
    return { postId: id, status };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Everything that must happen the moment a post goes live: stamp
 * `published_at`, bump the page's `post_count`, and fan out to follower
 * timelines when the page is small enough (FR-FEED-7).
 */
export async function onPublished(client: PoolClient, postId: string): Promise<PostRow> {
  const { rows } = await client.query<PostRow & { follower_count: number }>(
    `UPDATE feed_posts SET status = 'published',
        published_at = COALESCE(published_at, now()), updated_at = now()
      WHERE id = $1
      RETURNING *, (SELECT follower_count FROM feed_pages WHERE id = feed_posts.page_id) AS follower_count`,
    [postId],
  );
  const post = rows[0];
  if (!post) throw new FeedError('Post not found.', 404);

  await client.query(
    `UPDATE feed_pages SET post_count = (
        SELECT count(*) FROM feed_posts WHERE page_id = $1 AND status = 'published' AND deleted_at IS NULL
     ) WHERE id = $1`,
    [post.page_id],
  );

  // Hybrid fan-out: only for pages at or below the threshold. Big and mandatory
  // pages are merged at read time instead.
  if (post.follower_count <= FEED_LIMITS.FANOUT_THRESHOLD) {
    const score = rankScore({
      reactions: 0, comments: 0, shares: 0,
      publishedAt: new Date(post.published_at ?? Date.now()),
      pinned: post.pinned, type: post.type,
    });
    await client.query(
      `INSERT INTO feed_timeline (user_id, post_id, page_id, score, published_at, reason)
         SELECT f.user_id, $1, $2, $3, $4, 'follow'
           FROM feed_page_followers f
          WHERE f.page_id = $2
       ON CONFLICT (user_id, post_id) DO NOTHING`,
      [post.id, post.page_id, score, post.published_at ?? new Date()],
    );
  }
  // The author's own copy, always — so a page editor sees their post land.
  await client.query(
    `INSERT INTO feed_timeline (user_id, post_id, page_id, score, published_at, reason)
     VALUES ($1,$2,$3,$4,$5,'author') ON CONFLICT DO NOTHING`,
    [post.author_id, post.id, post.page_id, 999, post.published_at ?? new Date()],
  );
  return post;
}

export async function publishPost(actor: FeedActor, postId: string): Promise<void> {
  const post = await loadForWrite(actor, postId);
  if (post.status === 'published') return;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await onPublished(client, postId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function unpublishPost(actor: FeedActor, postId: string): Promise<void> {
  await loadForWrite(actor, postId);
  await getPool().query(`UPDATE feed_posts SET status = 'unpublished', updated_at = now() WHERE id = $1`, [postId]);
  await getPool().query('DELETE FROM feed_timeline WHERE post_id = $1', [postId]);
}

export async function deletePost(actor: FeedActor, postId: string, byModerator = false): Promise<void> {
  await loadForWrite(actor, postId, byModerator);
  await getPool().query('UPDATE feed_posts SET deleted_at = now(), updated_at = now() WHERE id = $1', [postId]);
  await getPool().query('DELETE FROM feed_timeline WHERE post_id = $1', [postId]);
  await getPool().query(
    `UPDATE feed_pages SET post_count = GREATEST(0, post_count - 1) WHERE id = (SELECT page_id FROM feed_posts WHERE id = $1)`,
    [postId],
  );
}

export async function editPost(actor: FeedActor, postId: string, patch: EditPostPayload): Promise<void> {
  const post = await loadForWrite(actor, postId);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Snapshot the version being replaced.
    await client.query(
      `INSERT INTO feed_post_edits (id, post_id, body, media, edited_by) VALUES ($1,$2,$3,$4,$5)`,
      [snowflake(), postId, post.body, JSON.stringify(post.media), actor.id],
    );
    const sets: string[] = ['edited_at = now()', 'edit_count = edit_count + 1', 'updated_at = now()'];
    const params: unknown[] = [];
    if (patch.body !== undefined) { params.push(patch.body.slice(0, FEED_LIMITS.POST_BODY_MAX)); sets.push(`body = $${params.length}`); }
    if (patch.format !== undefined) { params.push(patch.format === 'rich' ? 'rich' : 'plain'); sets.push(`format = $${params.length}`); }
    if (patch.media !== undefined) {
      const media = await resolveMedia(client, patch.media, actor.id);
      params.push(JSON.stringify(media)); sets.push(`media = $${params.length}`);
    }
    if (patch.linkPreview !== undefined) { params.push(patch.linkPreview ? JSON.stringify(patch.linkPreview) : null); sets.push(`link_preview = $${params.length}`); }
    if (patch.audience !== undefined && (FEED_AUDIENCES as readonly string[]).includes(patch.audience)) {
      if (!canTargetAudience(actor.roleLevel, patch.audience)) throw new FeedError('You cannot post to that audience.', 403);
      params.push(patch.audience); sets.push(`audience = $${params.length}`);
    }
    if (patch.commentPolicy !== undefined) { params.push(patch.commentPolicy); sets.push(`comment_policy = $${params.length}`); }
    if (patch.pinned !== undefined) { params.push(Boolean(patch.pinned)); sets.push(`pinned = $${params.length}`); }
    params.push(postId);
    await client.query(`UPDATE feed_posts SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Load a post for a write, checking the actor may perform it. */
async function loadForWrite(actor: FeedActor, postId: string, moderator = false): Promise<PostRow> {
  const { rows } = await getPool().query<PostRow & { editor_role: string | null }>(
    `SELECT fp.*, e.role AS editor_role
       FROM feed_posts fp
       LEFT JOIN feed_page_editors e ON e.page_id = fp.page_id AND e.user_id = $2
      WHERE fp.id = $1 AND fp.deleted_at IS NULL`,
    [postId, actor.id],
  );
  const post = rows[0];
  if (!post) throw new FeedError('Post not found.', 404);
  const isAuthor = post.author_id === actor.id;
  const isPageAdmin = post.editor_role !== null || actor.roleLevel === 'ADMIN';
  const isModerator = moderator && (can(actor, 'MODERATION_ACT') || actor.roleLevel === 'ADMIN');
  if (!isAuthor && !isPageAdmin && !isModerator) {
    throw new FeedError('You cannot change this post.', 403);
  }
  return post;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Hydration — turn rows into FeedPostView for the client
 * ────────────────────────────────────────────────────────────────────────── */

export async function hydratePosts(actor: FeedActor, postIds: string[]): Promise<Map<string, FeedPostView>> {
  const out = new Map<string, FeedPostView>();
  if (!postIds.length) return out;
  const pool = getPool();

  const { rows: posts } = await pool.query<PostRow & {
    editor_role: 'owner' | 'editor' | null;
    page_slug: string; page_name: string; page_bio: string; page_kind: string; page_audience: string;
    page_mandatory: boolean; page_verified: boolean; page_avatar: string | null; page_cover: string | null;
    page_accent: string; page_followers: number; page_posts: number; page_following: boolean; page_notify: boolean;
    author_name: string; author_avatar: string | null; author_role: string | null;
    my_reaction: string | null; bookmarked: boolean;
  }>(
    `SELECT fp.*,
            e.role AS editor_role,
            p.slug AS page_slug, p.name AS page_name, p.bio AS page_bio, p.kind AS page_kind,
            p.audience AS page_audience, p.mandatory AS page_mandatory, p.verified AS page_verified,
            p.avatar_file_id AS page_avatar, p.cover_file_id AS page_cover, p.accent AS page_accent,
            p.follower_count AS page_followers, p.post_count AS page_posts,
            (pf.user_id IS NOT NULL) AS page_following, COALESCE(pf.notify,false) AS page_notify,
            u.name AS author_name, u.avatar_url AS author_avatar, u.role AS author_role,
            r.emoji AS my_reaction,
            (b.user_id IS NOT NULL) AS bookmarked
       FROM feed_posts fp
       JOIN feed_pages p ON p.id = fp.page_id
       JOIN users u ON u.id = fp.author_id
       LEFT JOIN feed_page_editors e ON e.page_id = fp.page_id AND e.user_id = $2
       LEFT JOIN feed_page_followers pf ON pf.page_id = fp.page_id AND pf.user_id = $2
       LEFT JOIN feed_reactions r ON r.post_id = fp.id AND r.user_id = $2
       LEFT JOIN feed_bookmarks b ON b.post_id = fp.id AND b.user_id = $2
      WHERE fp.id = ANY($1) AND fp.deleted_at IS NULL`,
    [postIds, actor.id],
  );
  if (!posts.length) return out;

  const ids = posts.map((p) => p.id);

  // Reaction breakdown + a small sample of reactor names.
  const { rows: reactionRows } = await pool.query<{ post_id: string; emoji: string; n: string }>(
    `SELECT post_id, emoji, count(*)::text AS n FROM feed_reactions WHERE post_id = ANY($1) GROUP BY post_id, emoji`,
    [ids],
  );
  const { rows: sampleRows } = await pool.query<{ post_id: string; id: string; name: string; avatar_url: string | null }>(
    `SELECT x.post_id, u.id, u.name, u.avatar_url FROM (
        SELECT post_id, user_id, row_number() OVER (PARTITION BY post_id ORDER BY created_at DESC) AS rn
          FROM feed_reactions WHERE post_id = ANY($1)
     ) x JOIN users u ON u.id = x.user_id WHERE x.rn <= 3`,
    [ids],
  );

  // Poll tallies.
  const pollPosts = posts.filter((p) => p.poll);
  const voteByPost = new Map<string, Map<number, number>>();
  const myVotesByPost = new Map<string, number[]>();
  const votersByPost = new Map<string, Set<string>>();
  if (pollPosts.length) {
    const { rows: voteRows } = await pool.query<{ post_id: string; option_index: number; user_id: string }>(
      `SELECT post_id, option_index, user_id FROM feed_poll_votes WHERE post_id = ANY($1)`,
      [pollPosts.map((p) => p.id)],
    );
    for (const v of voteRows) {
      if (!voteByPost.has(v.post_id)) { voteByPost.set(v.post_id, new Map()); votersByPost.set(v.post_id, new Set()); }
      const m = voteByPost.get(v.post_id)!;
      m.set(v.option_index, (m.get(v.option_index) ?? 0) + 1);
      votersByPost.get(v.post_id)!.add(v.user_id);
      if (v.user_id === actor.id) {
        myVotesByPost.set(v.post_id, [...(myVotesByPost.get(v.post_id) ?? []), v.option_index]);
      }
    }
  }

  // Event RSVPs.
  const eventPosts = posts.filter((p) => p.event);
  const goingByPost = new Map<string, number>();
  const myGoing = new Set<string>();
  if (eventPosts.length) {
    const { rows: rsvpRows } = await pool.query<{ post_id: string; n: string; mine: boolean }>(
      `SELECT post_id, count(*)::text AS n, bool_or(user_id = $2) AS mine
         FROM feed_event_rsvps WHERE post_id = ANY($1) AND status = 'going' GROUP BY post_id`,
      [eventPosts.map((p) => p.id), actor.id],
    );
    for (const r of rsvpRows) { goingByPost.set(r.post_id, Number(r.n)); if (r.mine) myGoing.add(r.post_id); }
  }

  for (const p of posts) {
    const byEmoji: Partial<Record<FeedReaction, number>> = {};
    for (const rr of reactionRows.filter((r) => r.post_id === p.id)) {
      if ((FEED_REACTIONS as readonly string[]).includes(rr.emoji)) byEmoji[rr.emoji as FeedReaction] = Number(rr.n);
    }
    const top = (Object.entries(byEmoji) as Array<[FeedReaction, number]>)
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e);
    const sample: FeedPerson[] = sampleRows
      .filter((s) => s.post_id === p.id)
      .map((s) => ({ id: s.id, name: s.name, avatarUrl: s.avatar_url }));

    const reactions: FeedReactionSummary = {
      total: p.reaction_count,
      byEmoji, top,
      mine: p.my_reaction && (FEED_REACTIONS as readonly string[]).includes(p.my_reaction)
        ? (p.my_reaction as FeedReaction) : null,
      sample,
    };

    let poll: FeedPollView | null = null;
    if (p.poll) {
      const tally = voteByPost.get(p.id) ?? new Map<number, number>();
      const closed = Boolean(p.poll.closesAt && Date.parse(p.poll.closesAt) <= Date.now());
      poll = {
        question: p.poll.question,
        options: p.poll.options.map((text, i) => ({ text, votes: tally.get(i) ?? 0 })),
        multi: p.poll.multi,
        closesAt: p.poll.closesAt,
        closed,
        totalVoters: (votersByPost.get(p.id)?.size) ?? 0,
        myVotes: myVotesByPost.get(p.id) ?? [],
      };
    }

    const event = p.event
      ? {
          title: p.event.title, startsAt: p.event.startsAt, endsAt: p.event.endsAt,
          location: p.event.location, meetingId: p.event.meetingId,
          going: myGoing.has(p.id), goingCount: goingByPost.get(p.id) ?? 0,
        }
      : null;

    const pageSummary = toPageSummary(
      {
        id: p.page_id, slug: p.page_slug, name: p.page_name, bio: p.page_bio, kind: p.page_kind,
        audience: p.page_audience, mandatory: p.page_mandatory, verified: p.page_verified,
        avatar_file_id: p.page_avatar, cover_file_id: p.page_cover, accent: p.page_accent,
        follower_count: p.page_followers, post_count: p.page_posts, created_by: null, created_at: p.created_at,
        my_follow: p.page_following, my_notify: p.page_notify, my_editor_role: p.editor_role,
      },
      actor,
    );

    const isAuthor = p.author_id === actor.id;
    const isPageAdmin = p.editor_role !== null || actor.roleLevel === 'ADMIN';
    const canModerate = can(actor, 'MODERATION_ACT') || isPageAdmin;
    let canComment = false;
    if (p.comment_policy !== 'closed' && can(actor, 'FEED_COMMENT')) {
      canComment = p.comment_policy === 'open' || p.page_following || isPageAdmin;
    }
    if (isPageAdmin) canComment = p.comment_policy !== 'closed' ? canComment || can(actor, 'FEED_COMMENT') : canComment;

    out.set(p.id, {
      id: p.id,
      page: pageSummary,
      author: { id: p.author_id, name: p.author_name, avatarUrl: p.author_avatar, roleName: p.author_role },
      body: p.body,
      format: p.format,
      media: p.media ?? [],
      linkPreview: p.link_preview ?? null,
      type: p.type,
      poll,
      event,
      audience: p.audience,
      status: p.status,
      scheduledAt: p.scheduled_at,
      publishedAt: p.published_at,
      pinned: p.pinned,
      commentPolicy: p.comment_policy,
      editedAt: p.edited_at,
      reactions,
      commentCount: p.comment_count,
      shareCount: p.share_count,
      viewCount: p.view_count,
      uniqueReach: p.unique_reach,
      bookmarked: p.bookmarked,
      canComment,
      canEdit: isAuthor || isPageAdmin,
      canModerate,
      createdAt: p.created_at,
    });
  }
  return out;
}

export async function getPostView(actor: FeedActor, postId: string): Promise<FeedPostView> {
  const map = await hydratePosts(actor, [postId]);
  const view = map.get(postId);
  if (!view) throw new FeedError('Post not found.', 404);
  if (view.status !== 'published' && !view.canEdit) throw new FeedError('Post not found.', 404);
  if (view.status === 'published') assertVisible(actor, view.audience);
  return view;
}

/** For the worker sweep — publish scheduled posts whose time has come. */
export async function publishDueScheduledPosts(): Promise<{ published: string[] }> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM feed_posts WHERE status = 'scheduled' AND deleted_at IS NULL AND scheduled_at <= now() LIMIT 200`,
  );
  const published: string[] = [];
  for (const r of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await onPublished(client, r.id);
      await client.query('COMMIT');
      published.push(r.id);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`[feed] scheduled publish ${r.id} failed:`, e);
    } finally {
      client.release();
    }
  }
  return { published };
}

export { visibleAudiences };
