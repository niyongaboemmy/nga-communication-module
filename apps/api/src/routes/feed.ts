import { Router, type Request, type Response, type NextFunction } from 'express';
import { ok, fail } from '@tupo/shared';
import { feedAudienceRoom, feedPostRoom, feedReelRoom } from '@tupo/shared';
import type { FeedActor } from '@tupo/feed';
import * as feed from '@tupo/feed';
import { FeedError } from '@tupo/feed';
import { notifyAndPush } from '@tupo/notify';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { emitToRooms, emitToUsers } from '../services/chatRealtime.js';
import { audit } from '../services/userService.js';
import { activity } from '../activity/relay.js';

/**
 * Feed REST (SRS §8 "Feed").
 *
 * The socket only carries live updates outward; every write comes through here.
 * All the rules live in `@tupo/feed` — this file authorises the caller, calls
 * the domain, then fans the result out over the existing chat relay
 * (`feedpost:<id>` rooms) and raises notifications.
 */
const router = Router();
router.use(authMiddleware);

const actorOf = (req: Request): FeedActor => {
  const u = (req as AuthenticatedRequest).user!;
  return { id: u.id, roleLevel: u.roleLevel, permissions: u.permissions };
};

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try { await fn(req, res); }
    catch (err) {
      if (err instanceof FeedError) return res.status(err.status).json(fail(err.message));
      next(err);
    }
  };

/** Push a post's current view to everyone watching it. */
async function broadcastPost(actor: FeedActor, postId: string): Promise<void> {
  try {
    const post = await feed.getPostView(actor, postId);
    emitToRooms([feedPostRoom(postId)], 'feed:post_updated', { postId, post });
  } catch { /* deleted or now invisible — the delete event already went out */ }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * The feed
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  const actor = actorOf(req);
  // Lazily make sure mandatory pages are followed (FR-FEED-1).
  await feed.ensureMandatoryFollows(actor.id, actor.roleLevel).catch(() => {});
  const page = await feed.getFeed(actor, {
    cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null,
    sort: req.query.sort === 'top' ? 'top' : 'recent',
    filter: (['all', 'following', 'announcements', 'bookmarks'] as const)
      .find((f) => f === req.query.filter) ?? 'all',
  });
  res.json(ok(page));
}));

router.get('/bookmarks', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  const page = await feed.getFeed(actorOf(req), {
    cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null, filter: 'bookmarks',
  });
  res.json(ok(page));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Pages
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/pages', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  const pages = await feed.pages.listPages(actorOf(req), {
    mine: req.query.mine === '1' || req.query.mine === 'true',
    kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
    q: typeof req.query.q === 'string' ? req.query.q : undefined,
  });
  res.json(ok({ pages }));
}));

router.post('/pages', authorizePermission('FEED_PAGE_MANAGE'), wrap(async (req, res) => {
  const page = await feed.pages.createPage(actorOf(req), req.body ?? {});
  await audit({ actorId: actorOf(req).id, action: 'feed.page.create', targetType: 'feed_page', targetId: page.id });
  res.status(201).json(ok({ page }));
}));

router.get('/pages/:id', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  res.json(ok({ page: await feed.pages.getPage(actorOf(req), req.params.id!) }));
}));

/*
 * The page-scoped routes below gate on FEED_VIEW, not FEED_PAGE_MANAGE.
 *
 * FEED_PAGE_MANAGE is the permission to *create* pages; it says nothing about
 * any particular page, and requiring it here had it backwards twice over. It
 * let every holder through to pages they had no part in (the service then
 * waved them past, because the only role holding it is ADMIN), while locking
 * out the people who actually own a page — a teacher made owner of their
 * department's page could not change its logo, because owning a page was worth
 * less than a permission about making them.
 *
 * Authority over a specific page now lives entirely in the service, in
 * assertPageOwner / assertPageGovernance, where the page is actually loaded.
 */
router.patch('/pages/:id', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  const page = await feed.pages.updatePage(actorOf(req), req.params.id!, req.body ?? {});
  res.json(ok({ page }));
}));

router.delete('/pages/:id', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  await feed.pages.deletePage(actorOf(req), req.params.id!);
  await audit({ actorId: actorOf(req).id, action: 'feed.page.delete', targetType: 'feed_page', targetId: req.params.id! });
  res.json(ok({ deleted: true }));
}));

router.post('/pages/:id/follow', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  const notify = req.body?.notify !== false;
  res.json(ok({ page: await feed.pages.follow(actorOf(req), req.params.id!, notify) }));
}));

router.delete('/pages/:id/follow', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  res.json(ok({ page: await feed.pages.unfollow(actorOf(req), req.params.id!) }));
}));

router.post('/pages/:id/notify', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  await feed.pages.setNotify(actorOf(req), req.params.id!, Boolean(req.body?.notify));
  res.json(ok({ updated: true }));
}));

router.post('/pages/:id/editors', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  await feed.pages.addEditor(
    actorOf(req), req.params.id!, String(req.body?.userId ?? ''),
    req.body?.role === 'owner' ? 'owner' : 'editor', String(req.body?.title ?? ''),
  );
  res.json(ok({ page: await feed.pages.getPage(actorOf(req), req.params.id!) }));
}));

router.patch('/pages/:id/editors/:userId', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  const patch: { role?: 'owner' | 'editor'; title?: string } = {};
  if (req.body?.role !== undefined) patch.role = req.body.role === 'owner' ? 'owner' : 'editor';
  if (req.body?.title !== undefined) patch.title = String(req.body.title);
  await feed.pages.updateEditor(actorOf(req), req.params.id!, req.params.userId!, patch);
  res.json(ok({ page: await feed.pages.getPage(actorOf(req), req.params.id!) }));
}));

router.delete('/pages/:id/editors/:userId', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  await feed.pages.removeEditor(actorOf(req), req.params.id!, req.params.userId!);
  res.json(ok({ page: await feed.pages.getPage(actorOf(req), req.params.id!) }));
}));

router.get('/pages/:id/posts', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  const page = await feed.getFeed(actorOf(req), {
    pageId: req.params.id!,
    cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null,
    sort: req.query.sort === 'top' ? 'top' : 'recent',
  });
  res.json(ok(page));
}));

/*
 * Same shape as the routes above: an editor of the page reads its own numbers
 * without needing an institution-wide permission, and pageAnalytics decides.
 * FEED_ANALYTICS_VIEW remains a genuinely cross-page permission — it is how an
 * administrator compares pages they do not run — so it is checked there, not
 * here.
 */
router.get('/pages/:id/analytics', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  const range = (['7d', '30d', 'all'] as const).find((r) => r === req.query.range) ?? '30d';
  res.json(ok({ analytics: await feed.analytics.pageAnalytics(actorOf(req), req.params.id!, range) }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Posts
 * ────────────────────────────────────────────────────────────────────────── */

router.post('/pages/:id/posts', authorizePermission('FEED_POST'), wrap(async (req, res) => {
  const actor = actorOf(req);
  const result = await feed.posts.createPost(actor, { ...(req.body ?? {}), pageId: req.params.id! });
  await audit({ actorId: actor.id, action: 'feed.post.create', targetType: 'feed_post', targetId: result.postId, metadata: { status: result.status } });
  // A draft is not a post yet; it is counted when it is published (below).
  if (result.status !== 'draft') {
    activity().trackFor(req, 'tupo.feed.post', { post_id: result.postId, page_id: req.params.id!, status: result.status });
  }

  if (result.status === 'published') {
    const post = await feed.getPostView(actor, result.postId);
    // The author's timeline row exists; tell everyone whose timeline it hit.
    const followers = await notifyFollowersOfPost(result.postId, actor.id, post.page.name, post.type);
    emitToUsers([actor.id, ...followers.emitIds], 'feed:post_new', { post });
    // The home feed now shows every audience-visible post, not just followed
    // pages (FR-FEED-7) — broadcast to the audience band so it appears live
    // for everyone who can see it, not only this page's followers.
    emitToRooms([feedAudienceRoom(post.audience)], 'feed:post_new', { post });
  }
  res.status(201).json(ok(result));
}));

router.patch('/posts/:id', authorizePermission('FEED_POST'), wrap(async (req, res) => {
  const actor = actorOf(req);
  await feed.posts.editPost(actor, req.params.id!, req.body ?? {});
  await audit({ actorId: actor.id, action: 'feed.post.edit', targetType: 'feed_post', targetId: req.params.id! });
  await broadcastPost(actor, req.params.id!);
  res.json(ok({ post: await feed.getPostView(actor, req.params.id!).catch(() => null) }));
}));

router.post('/posts/:id/pin', authorizePermission('FEED_POST'), wrap(async (req, res) => {
  const actor = actorOf(req);
  const pinned = Boolean(req.body?.pinned);
  await feed.posts.setPinned(actor, req.params.id!, pinned);
  await audit({ actorId: actor.id, action: pinned ? 'feed.post.pin' : 'feed.post.unpin', targetType: 'feed_post', targetId: req.params.id! });
  await broadcastPost(actor, req.params.id!);
  res.json(ok({ post: await feed.getPostView(actor, req.params.id!) }));
}));

router.post('/posts/:id/publish', authorizePermission('FEED_POST'), wrap(async (req, res) => {
  const actor = actorOf(req);
  await feed.posts.publishPost(actor, req.params.id!);
  const post = await feed.getPostView(actor, req.params.id!);
  activity().trackFor(req, 'tupo.feed.post', { post_id: req.params.id!, page_id: post.page.id, status: 'published' });
  const followers = await notifyFollowersOfPost(req.params.id!, actor.id, post.page.name, post.type);
  emitToUsers([actor.id, ...followers.emitIds], 'feed:post_new', { post });
  emitToRooms([feedAudienceRoom(post.audience)], 'feed:post_new', { post });
  res.json(ok({ post }));
}));

router.post('/posts/:id/unpublish', authorizePermission('FEED_POST'), wrap(async (req, res) => {
  const actor = actorOf(req);
  await feed.posts.unpublishPost(actor, req.params.id!);
  emitToRooms([feedPostRoom(req.params.id!)], 'feed:post_deleted', { postId: req.params.id!, byModerator: false });
  res.json(ok({ unpublished: true }));
}));

router.delete('/posts/:id', authorizePermission('FEED_POST', 'MODERATION_ACT'), wrap(async (req, res) => {
  const actor = actorOf(req);
  const byModerator = actor.permissions.has('MODERATION_ACT');
  await feed.posts.deletePost(actor, req.params.id!, byModerator);
  await audit({ actorId: actor.id, action: 'feed.post.delete', targetType: 'feed_post', targetId: req.params.id!, metadata: { byModerator } });
  emitToRooms([feedPostRoom(req.params.id!)], 'feed:post_deleted', { postId: req.params.id!, byModerator });
  res.json(ok({ deleted: true }));
}));

router.post('/posts/:id/view', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  const counts = await feed.engagement.recordView(actorOf(req), req.params.id!);
  if (counts) emitToRooms([feedPostRoom(req.params.id!)], 'feed:counter', { postId: req.params.id!, ...counts });
  res.json(ok(counts ?? {}));
}));

router.post('/posts/:id/share', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  const shareCount = await feed.engagement.recordShare(actorOf(req), req.params.id!);
  emitToRooms([feedPostRoom(req.params.id!)], 'feed:counter', { postId: req.params.id!, shareCount });
  res.json(ok({ shareCount }));
}));

router.post('/posts/:id/bookmark', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  await feed.engagement.bookmark(actorOf(req), req.params.id!);
  res.json(ok({ bookmarked: true }));
}));

router.delete('/posts/:id/bookmark', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  await feed.engagement.unbookmark(actorOf(req), req.params.id!);
  res.json(ok({ bookmarked: false }));
}));

router.get('/posts/:id', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  res.json(ok({ post: await feed.getPostView(actorOf(req), req.params.id!) }));
}));

/* ── Reactions ─────────────────────────────────────────────────────────── */

router.post('/posts/:id/reactions', authorizePermission('FEED_COMMENT'), wrap(async (req, res) => {
  const actor = actorOf(req);
  const emoji = req.body?.emoji ?? null;
  const r = await feed.reactions.reactToPost(actor, req.params.id!, emoji);
  emitToRooms([feedPostRoom(req.params.id!)], 'feed:reaction', { postId: req.params.id!, reactions: r.summary });
  if (r.added && r.postAuthorId !== actor.id) {
    await notifyAndPush([r.postAuthorId], {
      kind: 'feed.reaction', title: 'New reaction',
      body: `${nameOf(req)} reacted to your post`,
      link: `/app/feed/post/${req.params.id}`, subjectType: 'feed_post', subjectId: req.params.id!,
    }).catch(() => {});
  }
  res.json(ok({ reactions: r.summary }));
}));

router.delete('/posts/:id/reactions', authorizePermission('FEED_COMMENT'), wrap(async (req, res) => {
  const r = await feed.reactions.reactToPost(actorOf(req), req.params.id!, null);
  emitToRooms([feedPostRoom(req.params.id!)], 'feed:reaction', { postId: req.params.id!, reactions: r.summary });
  res.json(ok({ reactions: r.summary }));
}));

router.post('/comments/:id/reactions', authorizePermission('FEED_COMMENT'), wrap(async (req, res) => {
  const r = await feed.reactions.reactToComment(actorOf(req), req.params.id!, req.body?.emoji ?? null);
  emitToRooms([feedPostRoom(r.postId)], 'feed:comment_reaction', {
    postId: r.postId, commentId: req.params.id!, reactionCount: r.reactionCount,
  });
  res.json(ok({ reactionCount: r.reactionCount }));
}));

router.delete('/comments/:id/reactions', authorizePermission('FEED_COMMENT'), wrap(async (req, res) => {
  const r = await feed.reactions.reactToComment(actorOf(req), req.params.id!, null);
  emitToRooms([feedPostRoom(r.postId)], 'feed:comment_reaction', {
    postId: r.postId, commentId: req.params.id!, reactionCount: r.reactionCount,
  });
  res.json(ok({ reactionCount: r.reactionCount }));
}));

/* ── Comments ─────────────────────────────────────────────────────────── */

router.get('/posts/:id/comments', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  const page = await feed.comments.listComments(actorOf(req), req.params.id!, {
    cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null,
  });
  res.json(ok(page));
}));

router.get('/comments/:id/replies', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  const page = await feed.comments.listReplies(actorOf(req), req.params.id!, {
    cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null,
  });
  res.json(ok(page));
}));

router.post('/posts/:id/comments', authorizePermission('FEED_COMMENT'), wrap(async (req, res) => {
  const actor = actorOf(req);
  const result = await feed.comments.addComment(actor, req.params.id!, req.body ?? {});
  emitToRooms([feedPostRoom(req.params.id!)], 'feed:comment_new', { postId: req.params.id!, comment: result.comment });

  const targets = new Set<string>();
  if (result.postAuthorId !== actor.id) targets.add(result.postAuthorId);
  if (result.parentAuthorId && result.parentAuthorId !== actor.id) targets.add(result.parentAuthorId);
  for (const uid of targets) {
    const isReply = uid === result.parentAuthorId;
    await notifyAndPush([uid], {
      kind: isReply ? 'feed.reply' : 'feed.comment',
      title: isReply ? 'New reply' : 'New comment',
      body: `${nameOf(req)}: ${result.comment.body.slice(0, 120) || 'commented'}`,
      link: `/app/feed/post/${req.params.id}`, subjectType: 'feed_post', subjectId: req.params.id!,
    }).catch(() => {});
  }
  res.status(201).json(ok({ comment: result.comment }));
}));

router.patch('/comments/:id', authorizePermission('FEED_COMMENT'), wrap(async (req, res) => {
  const comment = await feed.comments.editComment(actorOf(req), req.params.id!, String(req.body?.body ?? ''));
  emitToRooms([feedPostRoom(comment.postId)], 'feed:comment_updated', { postId: comment.postId, comment });
  res.json(ok({ comment }));
}));

router.delete('/comments/:id', authorizePermission('FEED_COMMENT', 'MODERATION_ACT'), wrap(async (req, res) => {
  const actor = actorOf(req);
  const byModerator = actor.permissions.has('MODERATION_ACT');
  const r = await feed.comments.deleteComment(actor, req.params.id!, byModerator);
  emitToRooms([feedPostRoom(r.postId)], 'feed:comment_deleted', {
    postId: r.postId, commentId: req.params.id!, parentId: r.parentId, byModerator,
  });
  res.json(ok({ deleted: true }));
}));

/* ── Polls & events ───────────────────────────────────────────────────── */

router.post('/posts/:id/vote', authorizePermission('FEED_COMMENT'), wrap(async (req, res) => {
  const choices = Array.isArray(req.body?.choices) ? req.body.choices.map(Number) : [];
  const r = await feed.polls.votePoll(actorOf(req), req.params.id!, choices);
  emitToRooms([feedPostRoom(req.params.id!)], 'feed:poll_updated', { postId: req.params.id!, poll: r.poll });
  res.json(ok({ poll: r.poll }));
}));

router.post('/posts/:id/rsvp', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  const r = await feed.engagement.rsvpEvent(actorOf(req), req.params.id!, req.body?.going !== false);
  await broadcastPost(actorOf(req), req.params.id!);
  res.json(ok(r));
}));

/* ── Moderation ───────────────────────────────────────────────────────── */

router.post('/posts/:id/report', authorizePermission('REPORT_SUBMIT'), wrap(async (req, res) => {
  const r = await feed.moderation.reportTarget(actorOf(req), {
    targetType: 'post', targetId: req.params.id!, reason: String(req.body?.reason ?? 'other'), note: req.body?.note,
  });
  res.status(201).json(ok(r));
}));

router.post('/comments/:id/report', authorizePermission('REPORT_SUBMIT'), wrap(async (req, res) => {
  const r = await feed.moderation.reportTarget(actorOf(req), {
    targetType: 'comment', targetId: req.params.id!, reason: String(req.body?.reason ?? 'other'), note: req.body?.note,
  });
  res.status(201).json(ok(r));
}));

router.get('/moderation', authorizePermission('MODERATION_QUEUE_VIEW'), wrap(async (req, res) => {
  const status = (['open', 'actioned', 'dismissed'] as const).find((s) => s === req.query.status) ?? 'open';
  res.json(ok({ reports: await feed.moderation.listQueue(actorOf(req), { status }) }));
}));

router.post('/moderation/:id/act', authorizePermission('MODERATION_ACT'), wrap(async (req, res) => {
  const actor = actorOf(req);
  const action = req.body?.action === 'remove' ? 'remove' : req.body?.action === 'warn' ? 'warn' : 'dismiss';
  const r = await feed.moderation.act(actor, req.params.id!, action, req.body?.note);
  await audit({
    actorId: actor.id, action: `feed.moderation.${action}`,
    targetType: r.targetType === 'post' ? 'feed_post' : 'feed_comment', targetId: r.targetId,
  });
  if (action === 'remove') {
    if (r.targetType === 'post') {
      emitToRooms([feedPostRoom(r.targetId)], 'feed:post_deleted', { postId: r.targetId, byModerator: true });
    } else if (r.postId) {
      emitToRooms([feedPostRoom(r.postId)], 'feed:comment_deleted', {
        postId: r.postId, commentId: r.targetId, parentId: r.parentId, byModerator: true,
      });
    }
  }
  if ((action === 'remove' || action === 'warn') && r.authorId) {
    await notifyAndPush([r.authorId], {
      kind: 'feed.mention',
      title: action === 'remove' ? 'A post was removed' : 'A moderator reviewed your content',
      body: action === 'remove'
        ? 'One of your posts was removed by a moderator for breaching the community rules.'
        : 'A moderator has reviewed content you posted. Please keep to the community rules.',
      link: '/app/feed', subjectType: 'feed_moderation', subjectId: r.targetId,
    }).catch(() => {});
  }
  res.json(ok({ acted: true }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Reels — short vertical videos, published by a person (FR-FEED-13)
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/reels', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  const page = await feed.reels.getReels(
    actorOf(req),
    typeof req.query.cursor === 'string' ? req.query.cursor : null,
    Number(req.query.limit) || undefined,
  );
  res.json(ok(page));
}));

router.post('/reels', authorizePermission('FEED_REEL_POST'), wrap(async (req, res) => {
  const actor = actorOf(req);
  const { reelId } = await feed.reels.createReel(actor, req.body ?? {});
  await audit({ actorId: actor.id, action: 'feed.reel.create', targetType: 'feed_reel', targetId: reelId });
  const reel = await feed.reels.getReel(actor, reelId);
  emitToRooms([feedAudienceRoom(reel.audience)], 'feed:reel_new', { reel });
  res.status(201).json(ok({ reelId, reel }));
}));

router.get('/reels/:id', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  res.json(ok({ reel: await feed.reels.getReel(actorOf(req), req.params.id!) }));
}));

router.delete('/reels/:id', authorizePermission('FEED_REEL_POST', 'MODERATION_ACT'), wrap(async (req, res) => {
  const actor = actorOf(req);
  await feed.reels.deleteReel(actor, req.params.id!);
  await audit({ actorId: actor.id, action: 'feed.reel.delete', targetType: 'feed_reel', targetId: req.params.id! });
  emitToRooms([feedReelRoom(req.params.id!)], 'feed:reel_deleted', { reelId: req.params.id! });
  res.json(ok({ deleted: true }));
}));

router.post('/reels/:id/view', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  const counts = await feed.reels.recordView(actorOf(req), req.params.id!);
  if (counts) emitToRooms([feedReelRoom(req.params.id!)], 'feed:reel_counter', { reelId: req.params.id!, ...counts });
  res.json(ok(counts ?? {}));
}));

router.post('/reels/:id/like', authorizePermission('FEED_COMMENT'), wrap(async (req, res) => {
  const r = await feed.reels.toggleLike(actorOf(req), req.params.id!);
  emitToRooms([feedReelRoom(req.params.id!)], 'feed:reel_counter', { reelId: req.params.id!, likeCount: r.likeCount });
  res.json(ok({ liked: r.liked, likeCount: r.likeCount }));
}));

router.get('/reels/:id/comments', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  res.json(ok({ comments: await feed.reels.listComments(actorOf(req), req.params.id!) }));
}));

router.post('/reels/:id/comments', authorizePermission('FEED_COMMENT'), wrap(async (req, res) => {
  const comment = await feed.reels.addComment(actorOf(req), req.params.id!, req.body?.body ?? '');
  emitToRooms([feedReelRoom(req.params.id!)], 'feed:reel_comment_new', { reelId: req.params.id!, comment });
  res.status(201).json(ok({ comment }));
}));

router.delete('/reels/comments/:commentId', authorizePermission('FEED_COMMENT', 'MODERATION_ACT'), wrap(async (req, res) => {
  const { reelId } = await feed.reels.deleteComment(actorOf(req), req.params.commentId!);
  res.json(ok({ deleted: true, reelId }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Stories — ephemeral 24-hour statuses, grouped by author (FR-FEED-14)
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/stories', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  res.json(ok({ groups: await feed.stories.getActiveStories(actorOf(req)) }));
}));

router.post('/stories', authorizePermission('FEED_STORY_POST'), wrap(async (req, res) => {
  const actor = actorOf(req);
  const { storyId } = await feed.stories.createStory(actor, req.body ?? {});
  await audit({ actorId: actor.id, action: 'feed.story.create', targetType: 'feed_story', targetId: storyId });
  const story = await feed.stories.getStory(actor, storyId);
  emitToRooms([feedAudienceRoom(story.audience)], 'feed:story_new', { story });
  res.status(201).json(ok({ storyId, story }));
}));

router.get('/stories/:id', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  res.json(ok({ story: await feed.stories.getStory(actorOf(req), req.params.id!) }));
}));

router.delete('/stories/:id', authorizePermission('FEED_STORY_POST', 'MODERATION_ACT'), wrap(async (req, res) => {
  const actor = actorOf(req);
  const { authorId } = await feed.stories.deleteStory(actor, req.params.id!);
  await audit({ actorId: actor.id, action: 'feed.story.delete', targetType: 'feed_story', targetId: req.params.id! });
  emitToRooms([feedAudienceRoom('everyone'), feedAudienceRoom('staff'), feedAudienceRoom('students'), feedAudienceRoom('parents')],
    'feed:story_deleted', { storyId: req.params.id!, authorId });
  res.json(ok({ deleted: true }));
}));

router.post('/stories/:id/view', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  const counts = await feed.stories.recordView(actorOf(req), req.params.id!);
  res.json(ok(counts ?? {}));
}));

router.get('/stories/:id/viewers', authorizePermission('FEED_VIEW'), wrap(async (req, res) => {
  res.json(ok({ viewers: await feed.stories.getViewers(actorOf(req), req.params.id!) }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Helpers
 * ────────────────────────────────────────────────────────────────────────── */

function nameOf(req: Request): string {
  return (req as AuthenticatedRequest).user?.name ?? 'Someone';
}

/**
 * Notify the followers of a page who asked for it, and hand back the ids to
 * emit `feed:post_new` to (their timelines already have the row).
 */
async function notifyFollowersOfPost(
  postId: string, authorId: string, pageName: string, type: string,
): Promise<{ emitIds: string[] }> {
  const { getPool } = await import('@tupo/db');
  const { rows } = await getPool().query<{ user_id: string; notify: boolean }>(
    `SELECT f.user_id, f.notify
       FROM feed_page_followers f
       JOIN feed_posts p ON p.page_id = f.page_id
      WHERE p.id = $1`,
    [postId],
  );
  const emitIds = rows.map((r) => r.user_id).filter((id) => id !== authorId);
  const notifyIds = rows.filter((r) => r.notify && r.user_id !== authorId).map((r) => r.user_id);
  if (notifyIds.length) {
    await notifyAndPush(notifyIds, {
      kind: type === 'announcement' ? 'feed.announcement' : 'feed.published',
      title: type === 'announcement' ? `📣 ${pageName}` : pageName,
      body: type === 'announcement' ? 'posted an announcement' : 'shared a new post',
      link: `/app/feed/post/${postId}`, subjectType: 'feed_post', subjectId: postId,
    }).catch(() => {});
  }
  return { emitIds };
}

export default router;
