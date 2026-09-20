import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Heart, MessageCircle, Volume2, VolumeX, Plus, X, Loader2, MoreHorizontal, Trash2, Eye, Video,
} from 'lucide-react';
import type { FeedMediaItem, FeedReelCommentView, FeedReelView } from '@tupo/shared';
import { FEED_AUDIENCES, FEED_LIMITS } from '@tupo/shared';
import type { FeedAudience } from '@tupo/shared';
import { Avatar, EmptyState } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { onSocket, getSocket } from '../../lib/socket';
import { uploadFile, probeMedia, validateFile } from '../chat/uploads';
import { useMediaUrl, firstName, relativeTime, useDismiss } from './lib';
import * as api from './api';

/**
 * Reels (FR-FEED-13) — a TikTok/Instagram-style vertical, snap-scroll feed of
 * short videos, published by a person directly rather than through a page.
 */
export const Reels: React.FC = () => {
  const { user } = useAuth();
  const [items, setItems] = useState<FeedReelView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (reset: boolean) => {
    if (reset) setLoading(true); else setLoadingMore(true);
    try {
      const page = await api.getReels(reset ? undefined : cursor ?? undefined);
      setItems((prev) => reset ? page.items : [...prev, ...page.items.filter((r) => !prev.some((p) => p.id === r.id))]);
      setCursor(page.nextCursor);
    } finally {
      setLoading(false); setLoadingMore(false);
    }
  }, [cursor]);

  useEffect(() => { void load(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Which slide is centred decides autoplay, view-counting and the live room.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const io = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) setActiveId(visible.target.getAttribute('data-reel-id'));
    }, { root, threshold: [0.6] });
    root.querySelectorAll('[data-reel-id]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [items.length]);

  useEffect(() => {
    if (!activeId) return;
    void api.recordReelView(activeId);
    const socket = getSocket();
    if (!socket) return;
    socket.emit('feed:subscribe', { postIds: [activeId], kind: 'reel' });
    return () => { socket.emit('feed:unsubscribe', { postIds: [activeId], kind: 'reel' }); };
  }, [activeId]);

  useEffect(() => onSocket('feed:reel_counter', (p) => {
    setItems((prev) => prev.map((r) => r.id === p.reelId
      ? { ...r, likeCount: p.likeCount ?? r.likeCount, commentCount: p.commentCount ?? r.commentCount, viewCount: p.viewCount ?? r.viewCount, liked: p.liked ?? r.liked }
      : r));
  }), []);
  useEffect(() => onSocket('feed:reel_comment_new', (p) => {
    setItems((prev) => prev.map((r) => r.id === p.reelId ? { ...r, commentCount: r.commentCount + 1 } : r));
  }), []);

  const onLike = async (reel: FeedReelView) => {
    setItems((prev) => prev.map((r) => r.id === reel.id ? { ...r, liked: !r.liked, likeCount: r.likeCount + (r.liked ? -1 : 1) } : r));
    try {
      const r = await api.likeReel(reel.id);
      setItems((prev) => prev.map((x) => x.id === reel.id ? { ...x, liked: r.liked, likeCount: r.likeCount } : x));
    } catch {
      setItems((prev) => prev.map((r2) => r2.id === reel.id ? reel : r2));
    }
  };

  const onDelete = async (reelId: string) => {
    await api.deleteReel(reelId).catch(() => {});
    setItems((prev) => prev.filter((r) => r.id !== reelId));
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      {loading ? (
        <div className="grid h-full place-items-center text-white"><Loader2 className="animate-spin" size={28} /></div>
      ) : items.length === 0 ? (
        <div className="grid h-full place-items-center px-6 text-white">
          <EmptyState title="No reels yet" hint="Be the first to share a short video." />
        </div>
      ) : (
        <div ref={containerRef} className="feed-reels-scroll h-full snap-y snap-mandatory overflow-y-scroll">
          {items.map((reel) => (
            <ReelSlide
              key={reel.id}
              reel={reel}
              active={reel.id === activeId}
              muted={muted}
              onToggleMute={() => setMuted((m) => !m)}
              onLike={() => void onLike(reel)}
              onDelete={reel.canDelete ? () => void onDelete(reel.id) : undefined}
              isMine={reel.author.id === user?.id}
            />
          ))}
          {cursor && (
            <LoadMoreObserver root={containerRef} loading={loadingMore} onHit={() => void load(false)} />
          )}
        </div>
      )}

      <button
        onClick={() => setComposerOpen(true)}
        className="absolute right-4 top-4 z-20 flex items-center gap-1.5 rounded-full bg-white/15 px-3.5 py-2 text-sm font-semibold text-white backdrop-blur hover:bg-white/25"
      >
        <Plus size={16} /> Create
      </button>

      {composerOpen && (
        <ReelComposer
          onClose={() => setComposerOpen(false)}
          onPosted={(reel) => { setItems((prev) => [reel, ...prev]); setComposerOpen(false); }}
        />
      )}
    </div>
  );
};

const LoadMoreObserver: React.FC<{ root: React.RefObject<HTMLDivElement | null>; loading: boolean; onHit: () => void }> = ({ root, loading, onHit }) => {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onHit);
  cb.current = onHit;
  useEffect(() => {
    if (!ref.current || !root.current) return;
    const io = new IntersectionObserver((e) => { if (e[0]?.isIntersecting) cb.current(); }, { root: root.current, rootMargin: '400px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [root]);
  return <div ref={ref} className="grid h-16 w-full place-items-center text-white/60">{loading && <Loader2 className="animate-spin" size={20} />}</div>;
};

/* ── One slide ────────────────────────────────────────────────────────── */

const ReelSlide: React.FC<{
  reel: FeedReelView; active: boolean; muted: boolean; onToggleMute: () => void;
  onLike: () => void; onDelete?: () => void; isMine: boolean;
}> = ({ reel, active, muted, onToggleMute, onLike, onDelete, isMine }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaUrl = useMediaUrl(reel.media.fileId);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useDismiss(menuOpen, useCallback(() => setMenuOpen(false), []));

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (active) v.play().catch(() => {}); else { v.pause(); v.currentTime = 0; }
  }, [active, mediaUrl]);

  return (
    <div data-reel-id={reel.id} className="relative flex h-full w-full snap-start snap-always items-center justify-center">
      {mediaUrl && (
        <video
          ref={videoRef}
          src={mediaUrl}
          className="h-full w-full object-contain sm:object-cover"
          loop
          muted={muted}
          playsInline
          onClick={onToggleMute}
        />
      )}
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30" />

      <button onClick={onToggleMute} className="absolute right-4 top-4 z-10 grid h-9 w-9 place-items-center rounded-full bg-black/40 text-white">
        {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
      </button>

      {(isMine || onDelete) && (
        <div ref={menuRef} className="absolute right-4 top-16 z-10">
          <button onClick={() => setMenuOpen((v) => !v)} className="grid h-9 w-9 place-items-center rounded-full bg-black/40 text-white"><MoreHorizontal size={17} /></button>
          {menuOpen && onDelete && (
            <div className="absolute right-0 top-full mt-1 w-40 rounded-xl bg-white p-1 shadow-xl dark:bg-elevated-dark">
              <button onClick={onDelete} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">
                <Trash2 size={14} /> Delete
              </button>
            </div>
          )}
        </div>
      )}

      {/* Right action rail */}
      <div className="absolute bottom-24 right-3 z-10 flex flex-col items-center gap-4 text-white sm:bottom-10">
        <ActionButton onClick={onLike} active={reel.liked}>
          <Heart size={26} fill={reel.liked ? 'currentColor' : 'none'} className={reel.liked ? 'text-rose-500' : ''} />
          <span className="text-xs font-semibold">{reel.likeCount}</span>
        </ActionButton>
        <ActionButton onClick={() => setCommentsOpen(true)}>
          <MessageCircle size={25} />
          <span className="text-xs font-semibold">{reel.commentCount}</span>
        </ActionButton>
        <ActionButton>
          <Eye size={24} />
          <span className="text-xs font-semibold">{reel.viewCount}</span>
        </ActionButton>
      </div>

      {/* Author + caption */}
      <div className="absolute inset-x-3 bottom-6 z-10 max-w-[80%] text-white sm:bottom-8">
        <div className="mb-1.5 flex items-center gap-2">
          <Avatar name={reel.author.name} src={reel.author.avatarUrl ?? undefined} size={32} />
          <span className="text-sm font-semibold">{reel.author.name}</span>
          <span className="text-xs text-white/70">{relativeTime(reel.createdAt)}</span>
        </div>
        {reel.caption && <p className="line-clamp-3 text-sm leading-snug">{reel.caption}</p>}
      </div>

      {commentsOpen && <ReelComments reel={reel} onClose={() => setCommentsOpen(false)} />}
    </div>
  );
};

const ActionButton: React.FC<{ onClick?: () => void; active?: boolean; children: React.ReactNode }> = ({ onClick, active, children }) => (
  <button onClick={onClick} disabled={!onClick} className={`flex flex-col items-center gap-1 ${active ? 'text-rose-500' : ''} ${!onClick ? 'cursor-default opacity-90' : ''}`}>
    {children}
  </button>
);

/* ── Comments sheet ───────────────────────────────────────────────────── */

const ReelComments: React.FC<{ reel: FeedReelView; onClose: () => void }> = ({ reel, onClose }) => {
  const [comments, setComments] = useState<FeedReelCommentView[] | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.listReelComments(reel.id).then(setComments).catch(() => setComments([])); }, [reel.id]);

  const submit = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const comment = await api.addReelComment(reel.id, text);
      setComments((prev) => [...(prev ?? []), comment]);
      setBody('');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await api.deleteReelComment(id).catch(() => {});
    setComments((prev) => (prev ?? []).filter((c) => c.id !== id));
  };

  return (
    <div className="absolute inset-0 z-20 flex items-end bg-black/50" onClick={onClose}>
      <div className="flex h-[70%] w-full flex-col rounded-t-2xl bg-white dark:bg-elevated-dark" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border-light px-4 py-3 dark:border-border-dark/40">
          <p className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">{reel.commentCount} comments</p>
          <button onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {comments === null && <Loader2 className="mx-auto animate-spin text-text-secondary-light" size={20} />}
          {comments?.length === 0 && <p className="py-8 text-center text-sm text-text-secondary-light dark:text-text-secondary-dark">No comments yet. Say something nice!</p>}
          {comments?.map((c) => (
            <div key={c.id} className="flex items-start gap-2.5 py-2">
              <Avatar name={c.author.name} src={c.author.avatarUrl ?? undefined} size={30} />
              <div className="min-w-0 flex-1">
                <p className="text-sm"><span className="font-semibold">{c.author.name}</span> <span className="text-text-secondary-light dark:text-text-secondary-dark">{relativeTime(c.createdAt)}</span></p>
                <p className="text-sm text-text-primary-light dark:text-text-primary-dark">{c.body}</p>
              </div>
              {c.canDelete && <button onClick={() => void remove(c.id)} aria-label="Delete comment" className="text-text-secondary-light hover:text-red-500"><Trash2 size={13} /></button>}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-border-light p-3 dark:border-border-dark/40">
          <input
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, FEED_LIMITS.REEL_COMMENT_BODY_MAX))}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            placeholder="Add a comment…"
            className="flex-1 rounded-full border border-border-light bg-surface-light px-3.5 py-2 text-sm outline-none dark:border-border-dark/60 dark:bg-card-dark"
          />
          <button onClick={() => void submit()} disabled={!body.trim() || busy} className="text-sm font-semibold text-blue-600 disabled:opacity-40">Post</button>
        </div>
      </div>
    </div>
  );
};

/* ── Composer ─────────────────────────────────────────────────────────── */

const ReelComposer: React.FC<{ onClose: () => void; onPosted: (reel: FeedReelView) => void }> = ({ onClose, onPosted }) => {
  const [caption, setCaption] = useState('');
  const [audience, setAudience] = useState<FeedAudience>('everyone');
  const [media, setMedia] = useState<{ fileId?: string; previewUrl?: string; progress: number; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFile = async (file: File) => {
    const invalid = validateFile(file);
    if (invalid) { setError(invalid); return; }
    if (!file.type.startsWith('video/')) { setError('A reel needs a video file.'); return; }
    const probe = await probeMedia(file);
    setMedia({ previewUrl: probe.previewUrl, progress: 0 });
    const handle = uploadFile(file, (p) => setMedia((m) => m && { ...m, progress: p.fraction }), probe);
    handle.promise
      .then((fileId) => setMedia((m) => m && { ...m, fileId, progress: 1 }))
      .catch((e) => setMedia((m) => m && { ...m, error: String(e), progress: 0 }));
  };

  const canSubmit = !busy && Boolean(media?.fileId);

  const submit = async () => {
    if (!media?.fileId || !canSubmit) return;
    setBusy(true); setError(null);
    try {
      const mediaItem: FeedMediaItem = { fileId: media.fileId, kind: 'video' };
      const { reel } = await api.createReel({ caption: caption.trim(), media: mediaItem, audience });
      onPosted(reel);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not publish your reel.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[95] grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-sm animate-pop overflow-hidden rounded-2xl bg-card-light dark:bg-elevated-dark" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border-light px-4 py-3 dark:border-border-dark/40">
          <h2 className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">Create reel</h2>
          <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full hover:bg-surface-light dark:hover:bg-card-dark"><X size={18} /></button>
        </div>

        <div className="p-4">
          {!media ? (
            <button
              onClick={() => fileInput.current?.click()}
              className="flex h-56 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border-light text-text-secondary-light hover:border-blue-400 hover:text-blue-600 dark:border-border-dark/60 dark:text-text-secondary-dark"
            >
              <Video size={28} /> <span className="text-sm font-medium">Choose a video</span>
              <span className="text-xs">up to {FEED_LIMITS.REEL_MAX_DURATION_SECONDS}s, vertical works best</span>
            </button>
          ) : (
            <div className="relative mx-auto h-72 w-40 overflow-hidden rounded-xl bg-black">
              {media.previewUrl && <video src={media.previewUrl} className="h-full w-full object-cover" muted autoPlay loop />}
              {media.progress < 1 && !media.error && <div className="absolute inset-0 grid place-items-center bg-black/40"><Loader2 className="animate-spin text-white" /></div>}
              <button onClick={() => setMedia(null)} aria-label="Remove" className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-white"><X size={13} /></button>
            </div>
          )}

          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value.slice(0, FEED_LIMITS.REEL_CAPTION_MAX))}
            placeholder="Write a caption…"
            rows={2}
            className="mt-3 w-full resize-none rounded-lg border border-border-light bg-surface-light px-3 py-2 text-sm outline-none dark:border-border-dark/60 dark:bg-card-dark/50"
          />

          <label className="mt-2 flex items-center gap-1.5 text-xs font-medium text-text-secondary-light dark:text-text-secondary-dark">
            Audience
            <select value={audience} onChange={(e) => setAudience(e.target.value as FeedAudience)} className="rounded-md border border-border-light bg-transparent px-1.5 py-1 dark:border-border-dark/60">
              {FEED_AUDIENCES.map((a) => <option key={a} value={a} className="dark:bg-elevated-dark">{a[0]!.toUpperCase() + a.slice(1)}</option>)}
            </select>
          </label>

          {error && <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end border-t border-border-light px-4 py-3 dark:border-border-dark/40">
          <button onClick={() => void submit()} disabled={!canSubmit} className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-5 py-1.5 text-sm font-semibold text-white disabled:opacity-40">
            {busy && <Loader2 size={14} className="animate-spin" />} Post
          </button>
        </div>
        <input ref={fileInput} type="file" hidden accept="video/*" onChange={(e) => e.target.files?.[0] && void addFile(e.target.files[0])} />
      </div>
    </div>
  );
};
