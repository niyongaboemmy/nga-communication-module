/**
 * Comments (FR-FEED-5, 9) — exactly one level of nesting.
 *
 * A reply always attaches to a *top-level* comment: replying to a reply
 * re-parents to that reply's parent, so the tree can never be deeper than
 * post → comment → reply.
 */
import { getPool, snowflake } from '@tupo/db';
import type { AddCommentPayload, FeedCommentView, FeedMediaItem, FeedPerson, FeedReaction } from '@tupo/shared';
import { FEED_LIMITS, FEED_REACTIONS } from '@tupo/shared';
import { FeedError } from './errors.js';
import { type FeedActor, can, clampLimit, decodeCursor, encodeCursor } from './common.js';

interface CommentRow {
  id: string;
  post_id: string;
  parent_id: string | null;
  author_id: string;
  body: string;
  media: FeedMediaItem[];
  reaction_count: number;
  reply_count: number;
  edited_at: string | null;
  created_at: string;
  author_name: string;
  author_avatar: string | null;
  author_role: string | null;
  my_reaction: string | null;
}

const COMMENT_SELECT = `
  SELECT c.id, c.post_id, c.parent_id, c.author_id, c.body, c.media, c.reaction_count,
         c.reply_count, c.edited_at, c.created_at,
         u.name AS author_name, u.avatar_url AS author_avatar, u.role AS author_role,
         cr.emoji AS my_reaction
    FROM feed_comments c
    JOIN users u ON u.id = c.author_id
    LEFT JOIN feed_comment_reactions cr ON cr.comment_id = c.id AND cr.user_id = $1
   WHERE c.deleted_at IS NULL`;

interface PostGuardRow {
  id: string; author_id: string; comment_policy: string; page_id: string;
  editor_role: string | null; following: boolean; status: string;
}

async function loadPostGuard(actor: FeedActor, postId: string): Promise<PostGuardRow> {
  const { rows } = await getPool().query<PostGuardRow>(
    `SELECT fp.id, fp.author_id, fp.comment_policy, fp.page_id, fp.status,
            e.role AS editor_role, (f.user_id IS NOT NULL) AS following
       FROM feed_posts fp
       LEFT JOIN feed_page_editors e ON e.page_id = fp.page_id AND e.user_id = $2
       LEFT JOIN feed_page_followers f ON f.page_id = fp.page_id AND f.user_id = $2
      WHERE fp.id = $1 AND fp.deleted_at IS NULL`,
    [postId, actor.id],
  );
  if (!rows[0]) throw new FeedError('Post not found.', 404);
  return rows[0];
}

function assertCanComment(actor: FeedActor, guard: PostGuardRow): void {
  if (guard.status !== 'published') throw new FeedError('Post not found.', 404);
  if (!can(actor, 'FEED_COMMENT')) throw new FeedError('You cannot comment.', 403);
  const isPageAdmin = guard.editor_role !== null || actor.roleLevel === 'ADMIN';
  if (guard.comment_policy === 'closed' && !isPageAdmin) throw new FeedError('Comments are turned off for this post.', 403);
  if (guard.comment_policy === 'followers' && !guard.following && !isPageAdmin) {
    throw new FeedError('Only followers of the page can comment on this post.', 403);
  }
}

function toView(actor: FeedActor, r: CommentRow): FeedCommentView {
  const isPageAdmin = actor.roleLevel === 'ADMIN';
  return {
    id: r.id,
    postId: r.post_id,
    parentId: r.parent_id,
    author: { id: r.author_id, name: r.author_name, avatarUrl: r.author_avatar, roleName: r.author_role },
    body: r.body,
    media: r.media ?? [],
    reactionCount: r.reaction_count,
    myReaction: r.my_reaction && (FEED_REACTIONS as readonly string[]).includes(r.my_reaction)
      ? (r.my_reaction as FeedReaction) : null,
    replyCount: r.reply_count,
    editedAt: r.edited_at,
    createdAt: r.created_at,
    canEdit: r.author_id === actor.id,
    canModerate: can(actor, 'MODERATION_ACT') || isPageAdmin,
  };
}

export interface AddCommentResult {
  comment: FeedCommentView;
  postAuthorId: string;
  parentAuthorId: string | null;
  pageId: string;
}

export async function addComment(
  actor: FeedActor, postId: string, payload: AddCommentPayload,
): Promise<AddCommentResult> {
  const guard = await loadPostGuard(actor, postId);
  assertCanComment(actor, guard);

  const body = (payload.body ?? '').trim().slice(0, FEED_LIMITS.COMMENT_BODY_MAX);
  if (!body && !(payload.media ?? []).length) throw new FeedError('A comment cannot be empty.', 400);

  let parentId: string | null = null;
  let parentAuthorId: string | null = null;
  if (payload.parentId) {
    const { rows } = await getPool().query<{ id: string; parent_id: string | null; author_id: string }>(
      `SELECT id, parent_id, author_id FROM feed_comments WHERE id = $1 AND post_id = $2 AND deleted_at IS NULL`,
      [payload.parentId, postId],
    );
    if (!rows[0]) throw new FeedError('The comment you replied to is gone.', 404);
    parentId = rows[0].parent_id ?? rows[0].id;   // re-parent replies-to-replies
    const { rows: pa } = await getPool().query<{ author_id: string }>(
      'SELECT author_id FROM feed_comments WHERE id = $1', [parentId],
    );
    parentAuthorId = pa[0]?.author_id ?? null;
  }

  const id = snowflake();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO feed_comments (id, post_id, parent_id, author_id, body, media)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, postId, parentId, actor.id, body, JSON.stringify((payload.media ?? []).slice(0, 4))],
    );
    if (parentId) {
      await client.query(
        `UPDATE feed_comments SET reply_count = (SELECT count(*) FROM feed_comments WHERE parent_id = $1 AND deleted_at IS NULL) WHERE id = $1`,
        [parentId],
      );
    }
    await client.query(
      `UPDATE feed_posts SET comment_count = (SELECT count(*) FROM feed_comments WHERE post_id = $1 AND deleted_at IS NULL), updated_at = now() WHERE id = $1`,
      [postId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await getPool().query<CommentRow>(`${COMMENT_SELECT} AND c.id = $2`, [actor.id, id]);
  return {
    comment: toView(actor, rows[0]!),
    postAuthorId: guard.author_id,
    parentAuthorId,
    pageId: guard.page_id,
  };
}

export interface CommentPage { items: FeedCommentView[]; nextCursor: string | null; }

export async function listComments(
  actor: FeedActor, postId: string, opts: { cursor?: string | null; limit?: number } = {},
): Promise<CommentPage> {
  await loadPostGuard(actor, postId); // 404s if the post is gone
  const limit = clampLimit(opts.limit, 12);
  const before = decodeCursor(opts.cursor);
  const params: unknown[] = [actor.id, postId];
  let keyset = '';
  if (before) { params.push(before.key, before.id); keyset = `AND (c.created_at, c.id) > ($3::timestamptz, $4)`; }
  params.push(limit + 1);

  const { rows } = await getPool().query<CommentRow>(
    `${COMMENT_SELECT} AND c.post_id = $2 AND c.parent_id IS NULL ${keyset}
      ORDER BY c.created_at ASC, c.id ASC LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > limit;
  const top = rows.slice(0, limit).map((r) => toView(actor, r));

  // First two replies per top-level comment, oldest first.
  if (top.length) {
    const { rows: replies } = await getPool().query<CommentRow>(
      `SELECT * FROM (
         ${COMMENT_SELECT} AND c.parent_id = ANY($2)
       ) c ORDER BY c.created_at ASC`,
      [actor.id, top.map((t) => t.id)],
    );
    const byParent = new Map<string, FeedCommentView[]>();
    for (const r of replies) {
      const list = byParent.get(r.parent_id!) ?? [];
      if (list.length < 2) list.push(toView(actor, r));
      byParent.set(r.parent_id!, list);
    }
    for (const t of top) t.replies = byParent.get(t.id) ?? [];
  }

  const last = rows[limit - 1];
  return {
    items: top,
    nextCursor: hasMore && last ? encodeCursor({ key: last.created_at, id: last.id }) : null,
  };
}

export async function listReplies(
  actor: FeedActor, commentId: string, opts: { cursor?: string | null; limit?: number } = {},
): Promise<CommentPage> {
  const limit = clampLimit(opts.limit, 10);
  const before = decodeCursor(opts.cursor);
  const params: unknown[] = [actor.id, commentId];
  let keyset = '';
  if (before) { params.push(before.key, before.id); keyset = `AND (c.created_at, c.id) > ($3::timestamptz, $4)`; }
  params.push(limit + 1);
  const { rows } = await getPool().query<CommentRow>(
    `${COMMENT_SELECT} AND c.parent_id = $2 ${keyset} ORDER BY c.created_at ASC, c.id ASC LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => toView(actor, r));
  const last = rows[limit - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor({ key: last.created_at, id: last.id }) : null };
}

async function loadCommentForWrite(actor: FeedActor, commentId: string, moderator = false): Promise<CommentRow & { editor_role: string | null }> {
  const { rows } = await getPool().query<CommentRow & { editor_role: string | null }>(
    `SELECT c.id, c.post_id, c.parent_id, c.author_id, c.body, c.media, c.reaction_count,
            c.reply_count, c.edited_at, c.created_at,
            u.name AS author_name, u.avatar_url AS author_avatar, u.role AS author_role,
            NULL::text AS my_reaction, e.role AS editor_role
       FROM feed_comments c
       JOIN users u ON u.id = c.author_id
       JOIN feed_posts fp ON fp.id = c.post_id
       LEFT JOIN feed_page_editors e ON e.page_id = fp.page_id AND e.user_id = $1
      WHERE c.id = $2 AND c.deleted_at IS NULL`,
    [actor.id, commentId],
  );
  const c = rows[0];
  if (!c) throw new FeedError('Comment not found.', 404);
  const isPageAdmin = c.editor_role !== null || actor.roleLevel === 'ADMIN';
  const isModerator = moderator && (can(actor, 'MODERATION_ACT') || isPageAdmin);
  if (c.author_id !== actor.id && !isPageAdmin && !isModerator) {
    throw new FeedError('You cannot change this comment.', 403);
  }
  return c;
}

export async function editComment(actor: FeedActor, commentId: string, body: string): Promise<FeedCommentView> {
  await loadCommentForWrite(actor, commentId);
  const trimmed = (body ?? '').trim().slice(0, FEED_LIMITS.COMMENT_BODY_MAX);
  if (!trimmed) throw new FeedError('A comment cannot be empty.', 400);
  await getPool().query('UPDATE feed_comments SET body = $2, edited_at = now() WHERE id = $1', [commentId, trimmed]);
  const { rows } = await getPool().query<CommentRow>(`${COMMENT_SELECT} AND c.id = $2`, [actor.id, commentId]);
  return toView(actor, rows[0]!);
}

export interface DeleteCommentResult { postId: string; parentId: string | null; byModerator: boolean; }

export async function deleteComment(actor: FeedActor, commentId: string, byModerator = false): Promise<DeleteCommentResult> {
  const c = await loadCommentForWrite(actor, commentId, byModerator);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE feed_comments SET deleted_at = now() WHERE id = $1', [commentId]);
    // Replies to a deleted top-level comment go with it.
    if (!c.parent_id) await client.query('UPDATE feed_comments SET deleted_at = now() WHERE parent_id = $1', [commentId]);
    if (c.parent_id) {
      await client.query(
        `UPDATE feed_comments SET reply_count = (SELECT count(*) FROM feed_comments WHERE parent_id = $1 AND deleted_at IS NULL) WHERE id = $1`,
        [c.parent_id],
      );
    }
    await client.query(
      `UPDATE feed_posts SET comment_count = (SELECT count(*) FROM feed_comments WHERE post_id = $1 AND deleted_at IS NULL) WHERE id = $1`,
      [c.post_id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { postId: c.post_id, parentId: c.parent_id, byModerator };
}

/** For the moderation preview. */
export async function getCommentPreview(commentId: string): Promise<CommentRow | null> {
  const { rows } = await getPool().query<CommentRow>(
    `SELECT c.id, c.post_id, c.parent_id, c.author_id, c.body, c.media, c.reaction_count,
            c.reply_count, c.edited_at, c.created_at,
            u.name AS author_name, u.avatar_url AS author_avatar, u.role AS author_role,
            NULL::text AS my_reaction
       FROM feed_comments c JOIN users u ON u.id = c.author_id WHERE c.id = $1`,
    [commentId],
  );
  return rows[0] ?? null;
}
