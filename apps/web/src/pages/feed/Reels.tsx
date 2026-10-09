import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Heart, MessageCircle, Volume2, VolumeX, Plus, X, Loader2, MoreHorizontal, Trash2, Eye, Video, ImageOff,
  Play, Pause, Share2, Link2, ChevronUp, ChevronDown, Keyboard, SkipForward, Repeat, Send, ArrowLeft,
} from 'lucide-react';
import type { FeedMediaItem, FeedReelCommentView, FeedReelView } from '@tupo/shared';
import { FEED_AUDIENCES, FEED_LIMITS } from '@tupo/shared';
import type { FeedAudience } from '@tupo/shared';
import { Avatar, EmptyState } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { useNotify } from '../../context/NotificationContext';
import { onSocket, getSocket } from '../../lib/socket';
import { uploadFile, probeMedia, validateFile } from '../chat/uploads';
import { useResilientMediaUrl, useInViewport, firstName, relativeTime, useDismiss } from './lib';
import * as api from './api';

/**
 * Reels (FR-FEED-13) — a TikTok/Instagram-style vertical, snap-scroll feed of
 * short videos, published by a person directly rather than through a page.
 *
 * Interaction model (Instagram/Facebook parity):
 *  - tap = play/pause, double-tap = like (heart bloom), hold = nothing (loop)
 *  - scrub bar along the bottom, mute is global and remembered
 *  - ↑ ↓ / j k move between reels, Space pause, M mute, L like, C comments,
 *    S share, ? shortcuts, Esc closes whatever is open
 *  - "Autoplay next" (remembered) advances at the end instead of looping
 *  - a reel someone posts arrives live as "up next" (slotted right after the
 *    one being watched, so nothing jumps); deleted ones vanish;
 *    `/app/feed/reels/:reelId` deep-links straight to one
 */

const VIEW_AFTER_MS = 2000; // a "view" is ≥2 s of watching, not a scroll-past
const PREF_MUTED = 'tupo.reels.muted';
const PREF_AUTO_NEXT = 'tupo.reels.autoNext';

const readPref = (key: string, fallback: boolean) => {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; }
};
const writePref = (key: string, v: boolean) => { try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* private mode */ } };

export const Reels: React.FC = () => {
  const { user } = useAuth();
  const { confirm, notify } = useNotify();
  const { reelId: deepLinkId } = useParams<{ reelId?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // Came from inside the app → go back there; landed on a shared link → feed.
  const fromApp = Boolean((location.state as { fromApp?: boolean } | null)?.fromApp);
  const goBack = () => { if (fromApp) navigate(-1); else navigate('/app/feed'); };
  const [items, setItems] = useState<FeedReelView[]>([]);
  const [arrived, setArrived] = useState<FeedReelView | null>(null); // the latest live reel, for the "up next" pill
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [muted, setMutedState] = useState(() => readPref(PREF_MUTED, true));
  const [autoNext, setAutoNextState] = useState(() => readPref(PREF_AUTO_NEXT, false));
  const [paused, setPaused] = useState(false);
  const [commentsFor, setCommentsFor] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const likeFns = useRef(new Map<string, () => void>());

  const setMuted = (v: boolean) => { setMutedState(v); writePref(PREF_MUTED, v); };
  const setAutoNext = (v: boolean) => { setAutoNextState(v); writePref(PREF_AUTO_NEXT, v); };

  const load = useCallback(async (reset: boolean) => {
    if (reset) setLoading(true); else setLoadingMore(true);
    try {
      const page = await api.getReels(reset ? undefined : cursor ?? undefined);
      let list = page.items;
      if (reset && deepLinkId) {
        // A shared link opens on that reel, with the rest of the feed below it.
        const pinned = list.find((r) => r.id === deepLinkId) ?? await api.getReel(deepLinkId).catch(() => null);
        if (pinned) list = [pinned, ...list.filter((r) => r.id !== pinned.id)];
        else notify({ title: 'That reel is no longer available', tone: 'error' });
      }
      setItems((prev) => reset ? list : [...prev, ...list.filter((r) => !prev.some((p) => p.id === r.id))]);
      setCursor(page.nextCursor);
    } finally {
      setLoading(false); setLoadingMore(false);
    }
  }, [cursor, deepLinkId, notify]);

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

  // Moving to another reel resumes playback and closes the sheet.
  useEffect(() => { setPaused(false); setCommentsFor(null); }, [activeId]);

  // Keep the URL honest so refresh/share lands on the reel being watched.
  useEffect(() => {
    if (!activeId || loading) return;
    navigate(`/app/feed/reels/${activeId}`, { replace: true, state: fromApp ? { fromApp: true } : undefined });
  }, [activeId, loading, navigate, fromApp]);

  useEffect(() => {
    if (!activeId) return;
    const t = window.setTimeout(() => void api.recordReelView(activeId), VIEW_AFTER_MS);
    const socket = getSocket();
    socket?.emit('feed:subscribe', { postIds: [activeId], kind: 'reel' });
    return () => {
      window.clearTimeout(t);
      socket?.emit('feed:unsubscribe', { postIds: [activeId], kind: 'reel' });
    };
  }, [activeId]);

  useEffect(() => onSocket('feed:reel_counter', (p) => {
    setItems((prev) => prev.map((r) => r.id === p.reelId
      ? { ...r, likeCount: p.likeCount ?? r.likeCount, commentCount: p.commentCount ?? r.commentCount, viewCount: p.viewCount ?? r.viewCount, uniqueReach: p.uniqueReach ?? r.uniqueReach, liked: p.liked ?? r.liked }
      : r));
  }), []);
  useEffect(() => onSocket('feed:reel_comment_new', (p) => {
    setItems((prev) => prev.map((r) => r.id === p.reelId ? { ...r, commentCount: r.commentCount + 1 } : r));
  }), []);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  useEffect(() => onSocket('feed:reel_new', ({ reel }) => {
    if (reel.author.id === user?.id) return; // the composer already put ours in
    setItems((prev) => {
      if (prev.some((r) => r.id === reel.id)) return prev;
      const at = prev.findIndex((r) => r.id === activeIdRef.current);
      // Slot it in as "up next" so the reel being watched doesn't move.
      return at < 0 ? [reel, ...prev] : [...prev.slice(0, at + 1), reel, ...prev.slice(at + 1)];
    });
    setArrived(reel);
  }), [user?.id]);
  useEffect(() => {
    if (!arrived) return;
    const t = window.setTimeout(() => setArrived(null), 6000);
    return () => window.clearTimeout(t);
  }, [arrived]);
  useEffect(() => onSocket('feed:reel_deleted', ({ reelId }) => {
    setItems((prev) => prev.filter((r) => r.id !== reelId));
    setArrived((a) => (a?.id === reelId ? null : a));
  }), []);

  /* ── Navigation ─────────────────────────────────────────────────────── */

  const activeIndex = useMemo(() => items.findIndex((r) => r.id === activeId), [items, activeId]);

  const scrollToIndex = useCallback((idx: number) => {
    const root = containerRef.current;
    if (!root) return;
    const clamped = Math.max(0, Math.min(items.length - 1, idx));
    root.scrollTo({ top: clamped * root.clientHeight, behavior: 'smooth' });
  }, [items.length]);

  const onLike = useCallback(async (reel: FeedReelView) => {
    setItems((prev) => prev.map((r) => r.id === reel.id ? { ...r, liked: !r.liked, likeCount: r.likeCount + (r.liked ? -1 : 1) } : r));
    try {
      const r = await api.likeReel(reel.id);
      setItems((prev) => prev.map((x) => x.id === reel.id ? { ...x, liked: r.liked, likeCount: r.likeCount } : x));
    } catch {
      setItems((prev) => prev.map((r2) => r2.id === reel.id ? reel : r2));
    }
  }, []);

  const onDelete = async (reelId: string) => {
    if (!window.confirm('Delete this reel? This cannot be undone.')) return;
    await api.deleteReel(reelId).catch(() => {});
    setItems((prev) => prev.filter((r) => r.id !== reelId));
    confirm('Reel deleted');
  };

  const share = useCallback(async (reel: FeedReelView) => {
    const url = `${window.location.origin}/app/feed/reels/${reel.id}`;
    const title = `${reel.author.name} on Tupo${reel.caption ? `: ${reel.caption.slice(0, 80)}` : ''}`;
    try {
      if (navigator.share) { await navigator.share({ title, url }); return; }
      await navigator.clipboard.writeText(url);
      confirm('Link copied');
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return;
      notify({ title: 'Could not share that reel', tone: 'error' });
    }
  }, [confirm, notify]);

  /* ── Keyboard ───────────────────────────────────────────────────────── */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        // Esc from the comment box closes the sheet; every other key is typing.
        if (e.key === 'Escape' && commentsFor) { (e.target as HTMLElement).blur(); setCommentsFor(null); }
        return;
      }
      if (composerOpen) return;
      const active = items[activeIndex];
      switch (e.key) {
        case 'ArrowDown': case 'j': e.preventDefault(); scrollToIndex(activeIndex + 1); break;
        case 'ArrowUp': case 'k': e.preventDefault(); scrollToIndex(activeIndex - 1); break;
        case ' ': e.preventDefault(); setPaused((p) => !p); break;
        case 'm': setMuted(!muted); break;
        case 'l': if (active) likeFns.current.get(active.id)?.(); break;
        case 'c': if (active) setCommentsFor((c) => (c === active.id ? null : active.id)); break;
        case 's': if (active) void share(active); break;
        case '?': setHelpOpen((h) => !h); break;
        case 'Escape':
          if (helpOpen) setHelpOpen(false);
          else if (commentsFor) setCommentsFor(null);
          else goBack();
          break;
        default: return;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [items, activeIndex, scrollToIndex, muted, share, composerOpen, helpOpen, commentsFor]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      {loading ? (
        <div className="grid h-full place-items-center text-white"><Loader2 className="animate-spin" size={28} /></div>
      ) : items.length === 0 ? (
        <div className="dark grid h-full place-items-center px-6 text-white">
          <EmptyState title="No reels yet" hint="Be the first to share a short video." />
        </div>
      ) : (
        <div ref={containerRef} className="feed-reels-scroll h-full snap-y snap-mandatory overflow-y-scroll">
          {items.map((reel, i) => (
            <ReelSlide
              key={reel.id}
              reel={reel}
              active={reel.id === activeId}
              muted={muted}
              paused={paused}
              loop={!autoNext}
              commentsOpen={commentsFor === reel.id}
              onTogglePause={() => setPaused((p) => !p)}
              onToggleMute={() => setMuted(!muted)}
              onLike={() => void onLike(reel)}
              onShare={() => void share(reel)}
              onComments={(open) => setCommentsFor(open ? reel.id : null)}
              onEnded={() => { if (autoNext) scrollToIndex(i + 1); }}
              onDelete={reel.canDelete ? () => void onDelete(reel.id) : undefined}
              isMine={reel.author.id === user?.id}
              registerLike={(fn) => { likeFns.current.set(reel.id, fn); return () => { likeFns.current.delete(reel.id); }; }}
            />
          ))}
          {cursor && (
            <LoadMoreObserver root={containerRef} loading={loadingMore} onHit={() => void load(false)} />
          )}
        </div>
      )}

      <button onClick={goBack} aria-label="Back" title="Esc" className="absolute left-4 top-4 z-20 flex items-center gap-1.5 rounded-full bg-white/15 py-2 pl-2.5 pr-3.5 text-sm font-semibold text-white backdrop-blur hover:bg-white/25">
        <ArrowLeft size={18} /> <span className="hidden sm:inline">Back</span>
      </button>

      {/* Top-right controls */}
      <div className="absolute right-4 top-4 z-20 flex items-center gap-2">
        <button
          onClick={() => setAutoNext(!autoNext)}
          title={autoNext ? 'Autoplay next: on' : 'Autoplay next: off (loops)'}
          aria-pressed={autoNext}
          className={`hidden items-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold text-white backdrop-blur sm:flex ${autoNext ? 'bg-blue-600/80 hover:bg-blue-600' : 'bg-white/15 hover:bg-white/25'}`}
        >
          {autoNext ? <SkipForward size={14} /> : <Repeat size={14} />} {autoNext ? 'Auto next' : 'Loop'}
        </button>
        <button onClick={() => setHelpOpen((h) => !h)} aria-label="Keyboard shortcuts" title="?" className="hidden h-9 w-9 place-items-center rounded-full bg-white/15 text-white backdrop-blur hover:bg-white/25 sm:grid">
          <Keyboard size={16} />
        </button>
        <button
          onClick={() => setComposerOpen(true)}
          className="flex items-center gap-1.5 rounded-full bg-white/15 px-3.5 py-2 text-sm font-semibold text-white backdrop-blur hover:bg-white/25"
        >
          <Plus size={16} /> Create
        </button>
      </div>

      {/* Desktop up/down paddles, like Instagram's web reels */}
      {items.length > 1 && (
        <div className="absolute right-4 top-1/2 z-20 hidden -translate-y-1/2 flex-col gap-2 sm:flex">
          <button onClick={() => scrollToIndex(activeIndex - 1)} disabled={activeIndex <= 0} aria-label="Previous reel" className="grid h-10 w-10 place-items-center rounded-full bg-white/15 text-white backdrop-blur hover:bg-white/25 disabled:opacity-30"><ChevronUp size={20} /></button>
          <button onClick={() => scrollToIndex(activeIndex + 1)} disabled={activeIndex >= items.length - 1 && !cursor} aria-label="Next reel" className="grid h-10 w-10 place-items-center rounded-full bg-white/15 text-white backdrop-blur hover:bg-white/25 disabled:opacity-30"><ChevronDown size={20} /></button>
        </div>
      )}

      {arrived && (
        <button
          onClick={() => { const i = items.findIndex((r) => r.id === arrived.id); if (i >= 0) scrollToIndex(i); setArrived(null); }}
          className="feed-pill-in absolute left-1/2 top-4 z-20 flex items-center gap-2 rounded-full bg-blue-600 py-1.5 pl-1.5 pr-4 text-sm font-semibold text-white shadow-lg"
        >
          <Avatar name={arrived.author.name} src={arrived.author.avatarUrl ?? undefined} size={24} />
          New reel from {firstName(arrived.author.name)} · up next <ChevronDown size={14} />
        </button>
      )}

      {helpOpen && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/70 p-6 animate-fade-in" onClick={() => setHelpOpen(false)}>
          <div className="w-full max-w-xs rounded-2xl bg-elevated-dark p-4 text-sm text-white" onClick={(e) => e.stopPropagation()}>
            <p className="mb-3 flex items-center gap-2 font-semibold"><Keyboard size={16} /> Shortcuts</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              {([
                ['↑ ↓', 'Previous / next reel'],
                ['Space', 'Pause / play'],
                ['M', 'Mute / unmute'],
                ['L', 'Like'],
                ['C', 'Comments'],
                ['S', 'Share'],
                ['Esc', 'Close / back'],
              ] as const).map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt><kbd className="rounded bg-white/15 px-1.5 py-0.5 font-mono text-xs">{k}</kbd></dt>
                  <dd className="text-white/80">{v}</dd>
                </React.Fragment>
              ))}
            </dl>
            <p className="mt-3 text-xs text-white/50">Tap to pause · double-tap to like · drag the bar to scrub.</p>
          </div>
        </div>
      )}

      {composerOpen && (
        <ReelComposer
          onClose={() => setComposerOpen(false)}
          onPosted={(reel) => {
            setItems((prev) => [reel, ...prev]);
            setComposerOpen(false);
            requestAnimationFrame(() => containerRef.current?.scrollTo({ top: 0 }));
          }}
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

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60); const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

const ReelSlide: React.FC<{
  reel: FeedReelView; active: boolean; muted: boolean; paused: boolean; loop: boolean; commentsOpen: boolean;
  onTogglePause: () => void; onToggleMute: () => void; onLike: () => void; onShare: () => void;
  onComments: (open: boolean) => void; onEnded: () => void; onDelete?: () => void; isMine: boolean;
  registerLike: (fn: () => void) => () => void;
}> = ({
  reel, active, muted, paused, loop, commentsOpen, onTogglePause, onToggleMute, onLike, onShare, onComments, onEnded, onDelete, isMine, registerLike,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [slideRef, nearView] = useInViewport<HTMLDivElement>();
  const { url: mediaUrl, broken, onError, retry } = useResilientMediaUrl(reel.media.fileId, active || nearView);
  const { confirm } = useNotify();
  const [menuOpen, setMenuOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [captionOpen, setCaptionOpen] = useState(false);
  const [flash, setFlash] = useState<'play' | 'pause' | null>(null);
  const [bloom, setBloom] = useState<{ x: number; y: number; id: number } | null>(null);
  const [likePop, setLikePop] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const menuRef = useDismiss(menuOpen, useCallback(() => setMenuOpen(false), []));
  const tapTimer = useRef<number | null>(null);
  const lastTap = useRef(0);
  const barRef = useRef<HTMLDivElement>(null);

  // Play/pause follows "am I the centred slide" and the page-level pause.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (active && !paused) v.play().catch(() => {});
    else v.pause();
    if (!active) { v.currentTime = 0; setProgress(0); }
  }, [active, paused, mediaUrl]);

  const like = useCallback(() => {
    setLikePop(true);
    window.setTimeout(() => setLikePop(false), 450);
    onLike();
  }, [onLike]);
  useEffect(() => registerLike(like), [registerLike, like]);

  const likeIfNot = useCallback(() => {
    if (!reel.liked) like(); else { setLikePop(true); window.setTimeout(() => setLikePop(false), 450); }
  }, [reel.liked, like]);

  // Tap → pause/play (after a short wait to rule out a double-tap);
  // double-tap → like with a heart blooming where the finger landed.
  const onCanvasTap = (e: React.MouseEvent) => {
    const now = performance.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      if (tapTimer.current) { window.clearTimeout(tapTimer.current); tapTimer.current = null; }
      const rect = e.currentTarget.getBoundingClientRect();
      setBloom({ x: e.clientX - rect.left, y: e.clientY - rect.top, id: now });
      likeIfNot();
      return;
    }
    lastTap.current = now;
    tapTimer.current = window.setTimeout(() => {
      tapTimer.current = null;
      setFlash(paused ? 'play' : 'pause');
      window.setTimeout(() => setFlash(null), 500);
      onTogglePause();
    }, 280);
  };

  const seekTo = (clientX: number) => {
    const bar = barRef.current; const v = videoRef.current;
    if (!bar || !v || !duration) return;
    const rect = bar.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    v.currentTime = frac * duration;
    setProgress(frac);
  };

  const copyLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}/app/feed/reels/${reel.id}`).then(() => confirm('Link copied')).catch(() => {});
    setMenuOpen(false);
  };

  const showCaptionToggle = reel.caption.length > 90 || reel.caption.includes('\n');

  return (
    <div ref={slideRef} data-reel-id={reel.id} className="relative flex h-full w-full snap-start snap-always items-center justify-center">
      {/* Desktop keeps a phone-shaped column; the frame fills the width on mobile. */}
      <div className="relative h-full w-full sm:aspect-[9/16] sm:h-[calc(100%-1rem)] sm:w-auto sm:max-w-full sm:overflow-hidden sm:rounded-2xl sm:bg-neutral-950">
        {mediaUrl && (
          <video
            ref={videoRef}
            src={mediaUrl}
            className="h-full w-full touch-manipulation object-contain"
            loop={loop}
            muted={muted}
            playsInline
            preload={active || nearView ? 'auto' : 'metadata'}
            onClick={onCanvasTap}
            onError={onError}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
            onTimeUpdate={(e) => { if (!scrubbing && e.currentTarget.duration) setProgress(e.currentTarget.currentTime / e.currentTarget.duration); }}
            onWaiting={() => setBuffering(true)}
            onPlaying={() => setBuffering(false)}
            onCanPlay={() => setBuffering(false)}
            onEnded={onEnded}
          />
        )}
        {!mediaUrl && !broken && <span className="feed-skeleton absolute inset-0" aria-hidden />}
        {broken && (
          <button onClick={(e) => { e.stopPropagation(); retry(); }} className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black text-white/70">
            <ImageOff size={28} /> <span className="text-sm font-medium">Couldn't load this reel. Tap to retry.</span>
          </button>
        )}
        <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30" />

        {/* Feedback layers: buffering ring, play/pause flash, double-tap heart */}
        {active && buffering && !paused && (
          <span className="pointer-events-none absolute inset-0 grid place-items-center"><Loader2 className="animate-spin text-white/80" size={34} /></span>
        )}
        {flash && (
          <span key={flash} className="feed-story-sent pointer-events-none absolute inset-0 grid place-items-center">
            <span className="grid h-20 w-20 place-items-center rounded-full bg-black/50 text-white backdrop-blur">
              {flash === 'pause' ? <Pause size={36} fill="currentColor" /> : <Play size={36} fill="currentColor" className="ml-1" />}
            </span>
          </span>
        )}
        {paused && active && !flash && (
          <span className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="grid h-16 w-16 place-items-center rounded-full bg-black/40 text-white/90"><Play size={30} fill="currentColor" className="ml-1" /></span>
          </span>
        )}
        {bloom && (
          <Heart key={bloom.id} size={96} fill="currentColor" onAnimationEnd={() => setBloom(null)}
            className="feed-heart-bloom pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2 text-white drop-shadow-lg"
            style={{ left: bloom.x, top: bloom.y }} />
        )}

        <button onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'} title="M" className="absolute right-4 top-16 z-10 grid h-9 w-9 place-items-center rounded-full bg-black/40 text-white sm:top-4">
          {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </button>

        {/* Right action rail — sits above the floating chat button */}
        <div className="absolute bottom-28 right-3 z-10 flex flex-col items-center gap-4 text-white sm:bottom-24">
          <ActionButton onClick={like} active={reel.liked} label={reel.liked ? 'Unlike' : 'Like'} hint="L">
            <Heart size={26} fill={reel.liked ? 'currentColor' : 'none'} className={`${reel.liked ? 'text-rose-500' : ''} ${likePop ? 'feed-thumb-pop' : ''}`} />
            <span className="text-xs font-semibold">{reel.likeCount}</span>
          </ActionButton>
          <ActionButton onClick={() => onComments(true)} label="Comments" hint="C">
            <MessageCircle size={25} />
            <span className="text-xs font-semibold">{reel.commentCount}</span>
          </ActionButton>
          <ActionButton onClick={onShare} label="Share" hint="S">
            <Share2 size={24} />
            <span className="text-xs font-semibold">Share</span>
          </ActionButton>
          <ActionButton label={`${reel.viewCount} views · ${reel.uniqueReach} people`}>
            <Eye size={24} />
            <span className="text-xs font-semibold">{reel.viewCount}</span>
          </ActionButton>
          <div ref={menuRef} className="relative">
            <ActionButton onClick={() => setMenuOpen((v) => !v)} label="More"><MoreHorizontal size={24} /></ActionButton>
            {menuOpen && (
              <div className="absolute bottom-0 right-full mr-2 w-44 rounded-xl bg-white p-1 text-text-primary-light shadow-xl animate-pop dark:bg-elevated-dark dark:text-text-primary-dark">
                <button onClick={copyLink} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-surface-light dark:hover:bg-card-dark">
                  <Link2 size={14} /> Copy link
                </button>
                {(isMine || onDelete) && onDelete && (
                  <button onClick={() => { setMenuOpen(false); onDelete(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">
                    <Trash2 size={14} /> Delete
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Author + caption */}
        <div className="absolute inset-x-3 bottom-8 z-10 max-w-[78%] text-white sm:bottom-9">
          <div className="mb-1.5 flex items-center gap-2">
            <Avatar name={reel.author.name} src={reel.author.avatarUrl ?? undefined} size={32} />
            <span className="text-sm font-semibold">{isMine ? 'You' : reel.author.name}</span>
            <span className="text-xs text-white/70">{relativeTime(reel.createdAt)}</span>
          </div>
          {reel.caption && (
            <p className={`whitespace-pre-line text-sm leading-snug ${captionOpen ? 'max-h-40 overflow-y-auto' : 'line-clamp-2'}`}>
              {reel.caption}
            </p>
          )}
          {showCaptionToggle && (
            <button onClick={() => setCaptionOpen((c) => !c)} className="mt-0.5 text-xs font-semibold text-white/70 hover:text-white">
              {captionOpen ? 'less' : '… more'}
            </button>
          )}
        </div>

        {/* Scrub bar — drag anywhere along it to seek */}
        <div
          ref={barRef}
          className="absolute inset-x-0 bottom-0 z-10 flex h-6 cursor-pointer items-end"
          role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setScrubbing(true); seekTo(e.clientX); }}
          onPointerMove={(e) => { if (scrubbing) seekTo(e.clientX); }}
          onPointerUp={(e) => { e.currentTarget.releasePointerCapture(e.pointerId); setScrubbing(false); }}
          onPointerCancel={() => setScrubbing(false)}
        >
          <div className={`relative w-full bg-white/25 transition-[height] ${scrubbing ? 'h-1.5' : 'h-[3px]'}`}>
            <div className="h-full origin-left bg-white" style={{ transform: `scaleX(${progress})` }} />
          </div>
          {(scrubbing || paused) && duration > 0 && (
            <span className="absolute bottom-3 left-3 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">
              {fmtTime(progress * duration)} / {fmtTime(duration)}
            </span>
          )}
        </div>

        {commentsOpen && <ReelComments reel={reel} onClose={() => onComments(false)} />}
      </div>
    </div>
  );
};

const ActionButton: React.FC<{ onClick?: () => void; active?: boolean; label: string; hint?: string; children: React.ReactNode }> = ({ onClick, active, label, hint, children }) => (
  <button
    onClick={onClick}
    disabled={!onClick}
    aria-label={label}
    title={hint ? `${label} (${hint})` : label}
    className={`flex flex-col items-center gap-1 transition-transform active:scale-90 ${active ? 'text-rose-500' : ''} ${!onClick ? 'cursor-default opacity-90' : 'hover:scale-105'}`}
  >
    {children}
  </button>
);

/* ── Comments sheet ───────────────────────────────────────────────────── */

const ReelComments: React.FC<{ reel: FeedReelView; onClose: () => void }> = ({ reel, onClose }) => {
  const { user } = useAuth();
  const [comments, setComments] = useState<FeedReelCommentView[] | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api.listReelComments(reel.id).then(setComments).catch(() => setComments([])); }, [reel.id]);

  // Other people's comments land live while the sheet is open.
  useEffect(() => onSocket('feed:reel_comment_new', (p) => {
    if (p.reelId !== reel.id) return;
    setComments((prev) => (prev && !prev.some((c) => c.id === p.comment.id) ? [...prev, p.comment] : prev));
  }), [reel.id]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [comments?.length]);

  const submit = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const comment = await api.addReelComment(reel.id, text);
      setComments((prev) => (prev?.some((c) => c.id === comment.id) ? prev : [...(prev ?? []), comment]));
      setBody('');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Delete this comment?')) return;
    await api.deleteReelComment(id).catch(() => {});
    setComments((prev) => (prev ?? []).filter((c) => c.id !== id));
  };

  const count = comments?.length ?? reel.commentCount;

  return (
    <div className="absolute inset-0 z-20 flex items-end bg-black/50 animate-fade-in" onClick={onClose}>
      <div className="flex h-[70%] w-full flex-col rounded-t-2xl bg-white animate-pop dark:bg-elevated-dark" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border-light px-4 py-3 dark:border-border-dark/40">
          <p className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">{count} {count === 1 ? 'comment' : 'comments'}</p>
          <button onClick={onClose} aria-label="Close" title="Esc" className="text-text-primary-light dark:text-text-primary-dark"><X size={18} /></button>
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto p-3">
          {comments === null && <Loader2 className="mx-auto animate-spin text-text-secondary-light" size={20} />}
          {comments?.length === 0 && <p className="py-8 text-center text-sm text-text-secondary-light dark:text-text-secondary-dark">No comments yet. Say something nice!</p>}
          {comments?.map((c) => (
            <div key={c.id} className="feed-card-in flex items-start gap-2.5 py-2">
              <Avatar name={c.author.name} src={c.author.avatarUrl ?? undefined} size={30} />
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  <span className="font-semibold text-text-primary-light dark:text-text-primary-dark">{c.author.id === user?.id ? 'You' : c.author.name}</span>{' '}
                  <span className="text-text-secondary-light dark:text-text-secondary-dark">{relativeTime(c.createdAt)}</span>
                </p>
                <p className="whitespace-pre-line break-words text-sm text-text-primary-light dark:text-text-primary-dark">{c.body}</p>
              </div>
              {c.canDelete && <button onClick={() => void remove(c.id)} aria-label="Delete comment" className="text-text-secondary-light hover:text-red-500"><Trash2 size={13} /></button>}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-border-light p-3 dark:border-border-dark/40">
          <Avatar name={user?.name ?? '?'} src={user?.avatarUrl} size={30} />
          <input
            ref={inputRef}
            autoFocus
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, FEED_LIMITS.REEL_COMMENT_BODY_MAX))}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }}
            placeholder={`Reply to ${firstName(reel.author.name)}…`}
            className="flex-1 rounded-full border border-border-light bg-surface-light px-3.5 py-2 text-sm outline-none dark:border-border-dark/60 dark:bg-card-dark"
          />
          <button onClick={() => void submit()} disabled={!body.trim() || busy} aria-label="Post comment" className="grid h-9 w-9 place-items-center rounded-full bg-blue-600 text-white disabled:opacity-40">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ── Composer ─────────────────────────────────────────────────────────── */

const ReelComposer: React.FC<{ onClose: () => void; onPosted: (reel: FeedReelView) => void }> = ({ onClose, onPosted }) => {
  const [caption, setCaption] = useState('');
  const [audience, setAudience] = useState<FeedAudience>('everyone');
  const [media, setMedia] = useState<{ fileId?: string; previewUrl?: string; progress: number; error?: string; durationMs?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFile = async (file: File) => {
    setError(null);
    const invalid = validateFile(file);
    if (invalid) { setError(invalid); return; }
    if (!file.type.startsWith('video/')) { setError('A reel needs a video file.'); return; }
    const probe = await probeMedia(file);
    if (probe.durationMs && probe.durationMs > FEED_LIMITS.REEL_MAX_DURATION_SECONDS * 1000) {
      setError(`That video is ${Math.round(probe.durationMs / 1000)}s — reels can be at most ${FEED_LIMITS.REEL_MAX_DURATION_SECONDS}s.`);
      return;
    }
    setMedia({ previewUrl: probe.previewUrl, progress: 0, durationMs: probe.durationMs });
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
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) void addFile(f); }}
              className={`flex h-56 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-text-secondary-light transition-colors hover:border-blue-400 hover:text-blue-600 dark:text-text-secondary-dark ${dragging ? 'border-blue-500 bg-blue-50 text-blue-600 dark:bg-blue-900/20' : 'border-border-light dark:border-border-dark/60'}`}
            >
              <Video size={28} /> <span className="text-sm font-medium">{dragging ? 'Drop it here' : 'Choose or drop a video'}</span>
              <span className="text-xs">up to {FEED_LIMITS.REEL_MAX_DURATION_SECONDS}s, vertical works best</span>
            </button>
          ) : (
            <div className="relative mx-auto h-72 w-40 overflow-hidden rounded-xl bg-black">
              {media.previewUrl && <video src={media.previewUrl} className="h-full w-full object-cover" muted autoPlay loop />}
              {media.progress < 1 && !media.error && (
                <div className="absolute inset-0 grid place-items-center bg-black/40">
                  <span className="grid place-items-center gap-1 text-white">
                    <Loader2 className="animate-spin" />
                    <span className="text-xs font-semibold tabular-nums">{Math.round(media.progress * 100)}%</span>
                  </span>
                  <span className="absolute inset-x-0 bottom-0 h-1 bg-white/30"><span className="block h-full bg-white" style={{ width: `${media.progress * 100}%` }} /></span>
                </div>
              )}
              {media.error && <p className="absolute inset-x-0 bottom-0 bg-red-600/90 px-2 py-1 text-center text-[11px] font-medium text-white">Upload failed</p>}
              {media.durationMs && <span className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold text-white">{fmtTime(media.durationMs / 1000)}</span>}
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
