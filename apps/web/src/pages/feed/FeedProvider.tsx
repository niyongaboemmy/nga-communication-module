import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import type {
  FeedCommentView, FeedFilter, FeedPostView, FeedReaction, FeedReactionSummary, FeedSort,
} from '@tupo/shared';
import { useAuth } from '../../context/AuthContext';
import { usePermissions } from '../../hooks/usePermissions';
import { getSocket, onSocket } from '../../lib/socket';
import * as api from './api';
import { cacheGet, cacheSet } from '../../lib/localStore';

/**
 * One store for every post the Feed has loaded, keyed by id, plus the socket
 * plumbing that keeps them live (FR-FEED-12).
 *
 * List screens (home, a page, saved, a permalink) each keep only an ordered
 * array of ids and read the bodies from here, so a reaction that arrives over
 * the socket updates the card wherever it is currently rendered.
 */

type PostMap = Record<string, FeedPostView>;

interface FeedCtx {
  posts: PostMap;
  getPost: (id: string) => FeedPostView | undefined;
  ingest: (list: FeedPostView[]) => void;
  patch: (id: string, next: Partial<FeedPostView> | ((p: FeedPostView) => FeedPostView)) => void;
  remove: (id: string) => void;
  /** Tell the gateway which posts this client currently has on screen. */
  watch: (ids: string[]) => void;
  /** Optimistic reaction toggle with rollback. */
  react: (id: string, emoji: FeedReaction) => Promise<void>;
  toggleBookmark: (id: string) => Promise<void>;
  vote: (id: string, choices: number[]) => Promise<void>;
  rsvp: (id: string, going: boolean) => Promise<void>;
  onNewPost: (cb: (post: FeedPostView) => void) => () => void;
  onCommentEvent: (
    cb: (e:
      | { type: 'new'; postId: string; comment: FeedCommentView }
      | { type: 'updated'; postId: string; comment: FeedCommentView }
      | { type: 'deleted'; postId: string; commentId: string; parentId: string | null }
      | { type: 'reaction'; postId: string; commentId: string; reactionCount: number }
    ) => void,
  ) => () => void;
  currentUserId: string;
}

const Ctx = createContext<FeedCtx | null>(null);
export const useFeed = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFeed outside <FeedProvider>');
  return v;
};

/**
 * A post that arrived over the socket was built for whoever caused the event
 * (the author, an editor, a reactor), so its personal fields are theirs.
 * Keep this reader's own (X-01): edit/moderate/pin rights, bookmark, their
 * reaction, their votes, their RSVP and their relationship with the page.
 */
function keepMine(incoming: FeedPostView, prev: FeedPostView | undefined, me: string): FeedPostView {
  if (!prev) {
    // A brand-new post: nothing is known about this reader yet beyond whether
    // they wrote it. Everything personal starts neutral.
    // The author can always edit their own post; anything wider (page editor,
    // moderator) arrives with the next fetch.
    const mine = incoming.author.id === me;
    return {
      ...incoming,
      canEdit: mine,
      canPin: false,
      canModerate: false,
      bookmarked: false,
      reactions: { ...incoming.reactions, mine: null },
      poll: incoming.poll ? { ...incoming.poll, myVotes: [] } : incoming.poll,
      event: incoming.event ? { ...incoming.event, going: false } : incoming.event,
    };
  }
  return {
    ...incoming,
    canEdit: prev.canEdit,
    canPin: prev.canPin,
    canModerate: prev.canModerate,
    canComment: prev.canComment,
    bookmarked: prev.bookmarked,
    reactions: { ...incoming.reactions, mine: prev.reactions.mine },
    poll: incoming.poll ? { ...incoming.poll, myVotes: prev.poll?.myVotes ?? [] } : incoming.poll,
    event: incoming.event ? { ...incoming.event, going: prev.event?.going ?? false } : incoming.event,
    page: { ...incoming.page, following: prev.page.following, myRole: prev.page.myRole },
  };
}

export const FeedProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const { can: canPerm, roleName } = usePermissions();
  // Whether this reader may moderate comments — their own rights, never the
  // rights of whoever wrote the comment a broadcast carries.
  const moderatorRef = useRef(false);
  moderatorRef.current = canPerm('MODERATION_ACT') || roleName === 'Admin';
  const [posts, setPosts] = useState<PostMap>({});
  const watched = useRef<Set<string>>(new Set());
  const newPostCbs = useRef(new Set<(p: FeedPostView) => void>());
  const commentCbs = useRef(new Set<Parameters<FeedCtx['onCommentEvent']>[0]>());

  const getPost = useCallback((id: string) => posts[id], [posts]);

  const ingest = useCallback((list: FeedPostView[]) => {
    if (!list.length) return;
    setPosts((prev) => {
      const next = { ...prev };
      for (const p of list) next[p.id] = { ...next[p.id], ...p };
      return next;
    });
  }, []);

  const patch = useCallback<FeedCtx['patch']>((id, next) => {
    setPosts((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      const updated = typeof next === 'function' ? next(cur) : { ...cur, ...next };
      return { ...prev, [id]: updated };
    });
  }, []);

  const remove = useCallback((id: string) => {
    setPosts((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const watch = useCallback((ids: string[]) => {
    const socket = getSocket();
    if (!socket) return;
    const fresh = ids.filter((id) => id && !watched.current.has(id));
    if (!fresh.length) return;
    fresh.forEach((id) => watched.current.add(id));
    socket.emit('feed:subscribe', { postIds: [...watched.current].slice(-200) });
  }, []);

  /* ── Socket wiring ──────────────────────────────────────────────────── */
  useEffect(() => {
    if (!user) return;
    const ownComment = (c: FeedCommentView): FeedCommentView => ({
      ...c,
      canEdit: c.author.id === user.id,
      canModerate: moderatorRef.current,
      myReaction: c.author.id === user.id ? c.myReaction : null,
    });
    const offs = [
      onSocket('feed:post_new', ({ post }) => {
        const view = keepMine(post, undefined, user.id);
        setPosts((p) => ({ ...p, [post.id]: p[post.id] ? keepMine(post, p[post.id], user.id) : view }));
        newPostCbs.current.forEach((cb) => cb(view));
      }),
      onSocket('feed:post_updated', ({ postId, post }) =>
        setPosts((p) => (p[postId] ? { ...p, [postId]: keepMine(post, p[postId], user.id) } : p))),
      onSocket('feed:post_deleted', ({ postId }) => remove(postId)),
      onSocket('feed:reaction', ({ postId, reactions, actorId }) => patch(postId, (cur) => ({
        ...cur,
        // Someone else's reaction moves the totals, never this reader's own choice.
        reactions: actorId === user.id ? reactions : { ...reactions, mine: cur.reactions.mine },
      }))),
      onSocket('feed:poll_updated', ({ postId, poll, actorId }) => patch(postId, (cur) => ({
        ...cur,
        poll: actorId === user.id ? poll : { ...poll, myVotes: cur.poll?.myVotes ?? [] },
      }))),
      onSocket('feed:counter', ({ postId, ...counts }) => patch(postId, (cur) => ({ ...cur, ...counts }))),
      onSocket('feed:comment_new', (e) => {
        patch(e.postId, (cur) => ({ ...cur, commentCount: cur.commentCount + 1 }));
        const comment = ownComment(e.comment);
        commentCbs.current.forEach((cb) => cb({ type: 'new', ...e, comment }));
      }),
      onSocket('feed:comment_updated', (e) =>
        commentCbs.current.forEach((cb) => cb({ type: 'updated', ...e, comment: ownComment(e.comment) }))),
      onSocket('feed:comment_deleted', (e) => {
        patch(e.postId, (cur) => ({ ...cur, commentCount: Math.max(0, cur.commentCount - 1) }));
        commentCbs.current.forEach((cb) => cb({ type: 'deleted', ...e }));
      }),
      onSocket('feed:comment_reaction', (e) => commentCbs.current.forEach((cb) => cb({ type: 'reaction', ...e }))),
    ];
    return () => offs.forEach((off) => off());
  }, [user, patch, remove]);

  // Re-assert subscriptions after a reconnect.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const resub = () => {
      if (watched.current.size) socket.emit('feed:subscribe', { postIds: [...watched.current].slice(-200) });
    };
    socket.on('connect', resub);
    return () => { socket.off('connect', resub); };
  }, [user]);

  const react = useCallback<FeedCtx['react']>(async (id, emoji) => {
    const cur = posts[id];
    if (!cur) return;
    const wasMine = cur.reactions.mine;
    const target: FeedReaction | null = wasMine === emoji ? null : emoji;
    const optimistic = applyReactionLocally(cur.reactions, wasMine, target);
    patch(id, (p) => ({ ...p, reactions: optimistic }));
    try {
      const summary = await api.reactToPost(id, target);
      patch(id, (p) => ({ ...p, reactions: summary }));
    } catch {
      patch(id, (p) => ({ ...p, reactions: cur.reactions }));
    }
  }, [posts, patch]);

  const toggleBookmark = useCallback<FeedCtx['toggleBookmark']>(async (id) => {
    const cur = posts[id];
    if (!cur) return;
    const next = !cur.bookmarked;
    patch(id, { bookmarked: next });
    try { next ? await api.bookmarkPost(id) : await api.unbookmarkPost(id); }
    catch { patch(id, { bookmarked: cur.bookmarked }); }
  }, [posts, patch]);

  // Optimistic (P-04): the vote and the RSVP show at once; the server's answer
  // replaces them, and a refusal puts them back and is rethrown to the caller.
  const vote = useCallback<FeedCtx['vote']>(async (id, choices) => {
    const before = posts[id]?.poll;
    if (before) {
      const had = new Set(before.myVotes), will = new Set(choices);
      patch(id, (p) => ({ ...p, poll: {
        ...before,
        myVotes: choices,
        totalVoters: before.totalVoters + (had.size === 0 ? 1 : 0),
        options: before.options.map((o, i) => ({ ...o, votes: o.votes + (will.has(i) ? 1 : 0) - (had.has(i) ? 1 : 0) })),
      } }));
    }
    try {
      const poll = await api.votePoll(id, choices);
      patch(id, (p) => ({ ...p, poll }));
    } catch (err) {
      if (before) patch(id, (p) => ({ ...p, poll: before }));
      throw err;
    }
  }, [posts, patch]);

  const rsvp = useCallback<FeedCtx['rsvp']>(async (id, going) => {
    const before = posts[id]?.event;
    if (before) {
      patch(id, (p) => (p.event ? { ...p, event: {
        ...p.event, going, goingCount: Math.max(0, before.goingCount + (going === before.going ? 0 : going ? 1 : -1)),
      } } : p));
    }
    try {
      const r = await api.rsvpEvent(id, going);
      patch(id, (p) => (p.event ? { ...p, event: { ...p.event, going: r.going, goingCount: r.goingCount } } : p));
    } catch (err) {
      if (before) patch(id, (p) => ({ ...p, event: before }));
      throw err;
    }
  }, [posts, patch]);

  const onNewPost = useCallback((cb: (p: FeedPostView) => void) => {
    newPostCbs.current.add(cb);
    return () => newPostCbs.current.delete(cb);
  }, []);
  const onCommentEvent = useCallback((cb: Parameters<FeedCtx['onCommentEvent']>[0]) => {
    commentCbs.current.add(cb);
    return () => commentCbs.current.delete(cb);
  }, []);

  const value = useMemo<FeedCtx>(() => ({
    posts, getPost, ingest, patch, remove, watch, react, toggleBookmark, vote, rsvp,
    onNewPost, onCommentEvent, currentUserId: user?.id ?? '',
  }), [posts, getPost, ingest, patch, remove, watch, react, toggleBookmark, vote, rsvp, onNewPost, onCommentEvent, user]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

function applyReactionLocally(
  s: FeedReactionSummary, was: FeedReaction | null, now: FeedReaction | null,
): FeedReactionSummary {
  const byEmoji = { ...s.byEmoji };
  if (was) byEmoji[was] = Math.max(0, (byEmoji[was] ?? 1) - 1);
  if (now) byEmoji[now] = (byEmoji[now] ?? 0) + 1;
  const total = s.total + (now ? 1 : 0) - (was ? 1 : 0);
  const top = (Object.entries(byEmoji) as Array<[FeedReaction, number]>)
    .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e);
  return { ...s, byEmoji, total: Math.max(0, total), top, mine: now };
}

/**
 * A tiny hook for a list screen: keeps an ordered id array, pages, and feeds
 * the ids into the socket watcher. `loader` returns one page.
 */
export function useFeedList(
  loader: (cursor?: string) => Promise<{ items: FeedPostView[]; nextCursor: string | null }>,
  deps: React.DependencyList,
  /** Keep the first page on the device under this key, and show it first (P-03). */
  cacheKey?: string,
) {
  const { ingest, watch, onNewPost } = useFeed();
  const [ids, setIds] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  /** A failed "load more" (D-07): the posts already shown stay, with a retry. */
  const [moreError, setMoreError] = useState<string | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const cacheKeyRef = useRef(cacheKey);
  cacheKeyRef.current = cacheKey;
  /** Set once the network answers, so a slower cache read never overwrites it. */
  const fresh = useRef(false);
  const shownFromCache = useRef(false);

  const load = useCallback(async (reset: boolean) => {
    reset ? setLoading(true) : setMore(true);
    if (reset) setError(null);
    setMoreError(null);
    try {
      const page = await loaderRef.current(reset ? undefined : cursor ?? undefined);
      if (reset) {
        fresh.current = true;
        if (cacheKeyRef.current) void cacheSet(cacheKeyRef.current, page);
      }
      ingest(page.items);
      const pageIds = page.items.map((p) => p.id);
      setIds((prev) => (reset ? pageIds : [...prev, ...pageIds.filter((id) => !prev.includes(id))]));
      setCursor(page.nextCursor);
      watch(pageIds);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not load the feed.';
      // Shown from the device and now offline: keep the posts rather than an error.
      if (reset && !shownFromCache.current) setError(message); else if (!reset) setMoreError(message);
    } finally {
      setLoading(false); setMore(false);
    }
  }, [cursor, ingest, watch]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setIds([]); setCursor(null);
    fresh.current = false;
    shownFromCache.current = false;
    let stale = false;
    const key = cacheKeyRef.current;
    if (key) {
      void cacheGet<{ items: FeedPostView[]; nextCursor: string | null }>(key).then((cached) => {
        if (stale || fresh.current || !cached?.items.length) return;
        shownFromCache.current = true;
        // A request that failed before this read finished (offline) does not
        // keep its error over the copy on the device.
        setError(null);
        ingest(cached.items);
        setIds(cached.items.map((p) => p.id));
        setCursor(cached.nextCursor);
        setLoading(false);
      });
    }
    void load(true);
    return () => { stale = true; };
  }, deps);

  // New posts that arrive live get spliced to the top (home only passes a cb).
  const prepend = useCallback((id: string) => setIds((prev) => (prev.includes(id) ? prev : [id, ...prev])), []);

  return { ids, loading, error, moreError, more, hasMore: cursor !== null, loadMore: () => load(false), reload: () => load(true), prepend, onNewPost };
}
