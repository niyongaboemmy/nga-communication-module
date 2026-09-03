import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import type {
  FeedCommentView, FeedFilter, FeedPostView, FeedReaction, FeedReactionSummary, FeedSort,
} from '@tupo/shared';
import { useAuth } from '../../context/AuthContext';
import { getSocket, onSocket } from '../../lib/socket';
import * as api from './api';

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

export const FeedProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
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
    const offs = [
      onSocket('feed:post_new', ({ post }) => {
        setPosts((p) => ({ ...p, [post.id]: post }));
        newPostCbs.current.forEach((cb) => cb(post));
      }),
      onSocket('feed:post_updated', ({ postId, post }) => setPosts((p) => (p[postId] ? { ...p, [postId]: post } : p))),
      onSocket('feed:post_deleted', ({ postId }) => remove(postId)),
      onSocket('feed:reaction', ({ postId, reactions }) => patch(postId, (cur) => ({ ...cur, reactions }))),
      onSocket('feed:poll_updated', ({ postId, poll }) => patch(postId, (cur) => ({ ...cur, poll }))),
      onSocket('feed:counter', ({ postId, ...counts }) => patch(postId, (cur) => ({ ...cur, ...counts }))),
      onSocket('feed:comment_new', (e) => {
        patch(e.postId, (cur) => ({ ...cur, commentCount: cur.commentCount + 1 }));
        commentCbs.current.forEach((cb) => cb({ type: 'new', ...e }));
      }),
      onSocket('feed:comment_updated', (e) => commentCbs.current.forEach((cb) => cb({ type: 'updated', ...e }))),
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

  const vote = useCallback<FeedCtx['vote']>(async (id, choices) => {
    const poll = await api.votePoll(id, choices);
    patch(id, (p) => ({ ...p, poll }));
  }, [patch]);

  const rsvp = useCallback<FeedCtx['rsvp']>(async (id, going) => {
    const r = await api.rsvpEvent(id, going);
    patch(id, (p) => (p.event ? { ...p, event: { ...p.event, going: r.going, goingCount: r.goingCount } } : p));
  }, [patch]);

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
) {
  const { ingest, watch, onNewPost } = useFeed();
  const [ids, setIds] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const load = useCallback(async (reset: boolean) => {
    reset ? setLoading(true) : setMore(true);
    setError(null);
    try {
      const page = await loaderRef.current(reset ? undefined : cursor ?? undefined);
      ingest(page.items);
      const pageIds = page.items.map((p) => p.id);
      setIds((prev) => (reset ? pageIds : [...prev, ...pageIds.filter((id) => !prev.includes(id))]));
      setCursor(page.nextCursor);
      watch(pageIds);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the feed.');
    } finally {
      setLoading(false); setMore(false);
    }
  }, [cursor, ingest, watch]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setIds([]); setCursor(null); void load(true); }, deps);

  // New posts that arrive live get spliced to the top (home only passes a cb).
  const prepend = useCallback((id: string) => setIds((prev) => (prev.includes(id) ? prev : [id, ...prev])), []);

  return { ids, loading, error, more, hasMore: cursor !== null, loadMore: () => load(false), reload: () => load(true), prepend, onNewPost };
}
