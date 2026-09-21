import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Clapperboard, ChevronLeft, ChevronRight, Heart, Play, Eye, Volume2, VolumeX } from 'lucide-react';
import type { FeedReelView } from '@tupo/shared';
import { Avatar } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { getSocket, onSocket } from '../../lib/socket';
import { useResilientMediaUrl, useInViewport, firstName } from './lib';
import * as api from './api';

/**
 * "Reels and short videos" — the Facebook-style sampler card that sits a few
 * posts down the home feed. A handful of the newest reels, hover (or tap) to
 * preview them muted, click to open the full-screen player on that reel.
 * New reels arrive live at the front; deleted ones drop out.
 */

const SAMPLE_SIZE = 8;

export const ReelsStrip: React.FC = () => {
  const { user } = useAuth();
  const [reels, setReels] = useState<FeedReelView[] | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [muted, setMuted] = useState(true);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [canScroll, setCanScroll] = useState({ left: false, right: false });

  useEffect(() => {
    api.getReels().then((page) => setReels(page.items.slice(0, SAMPLE_SIZE))).catch(() => setReels([]));
  }, []);

  useEffect(() => {
    const offNew = onSocket('feed:reel_new', ({ reel }) => {
      setReels((prev) => (prev?.some((r) => r.id === reel.id) ? prev : [reel, ...(prev ?? [])].slice(0, SAMPLE_SIZE)));
      if (reel.author.id !== user?.id) {
        setFresh((f) => new Set(f).add(reel.id));
        window.setTimeout(() => setFresh((f) => { const n = new Set(f); n.delete(reel.id); return n; }), 5000);
      }
    });
    const offDel = onSocket('feed:reel_deleted', ({ reelId }) => setReels((prev) => prev?.filter((r) => r.id !== reelId) ?? prev));
    const offCount = onSocket('feed:reel_counter', (p) => setReels((prev) => prev?.map((r) => r.id === p.reelId
      ? { ...r, likeCount: p.likeCount ?? r.likeCount, viewCount: p.viewCount ?? r.viewCount, commentCount: p.commentCount ?? r.commentCount }
      : r) ?? prev));
    return () => { offNew(); offDel(); offCount(); };
  }, [user?.id]);

  // Join the reels' rooms so likes/views tick live on the card too.
  const ids = (reels ?? []).map((r) => r.id).join(',');
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !ids) return;
    const postIds = ids.split(',');
    socket.emit('feed:subscribe', { postIds, kind: 'reel' });
    return () => { socket.emit('feed:unsubscribe', { postIds, kind: 'reel' }); };
  }, [ids]);

  const updateArrows = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setCanScroll({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  useEffect(() => { updateArrows(); }, [reels?.length, updateArrows]);
  const nudge = (dir: 1 | -1) => scroller.current?.scrollBy({ left: dir * 300, behavior: 'smooth' });

  if (!reels || reels.length === 0) return null;

  return (
    <section className="feed-card feed-card-in overflow-hidden" aria-label="Reels">
      <header className="flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-[#fde7f3] text-pink-600 dark:bg-pink-900/30 dark:text-pink-300"><Clapperboard size={16} /></span>
        <div className="min-w-0 flex-1 leading-tight">
          <h3 className="text-[15px] font-semibold text-text-primary-light dark:text-text-primary-dark">Reels and short videos</h3>
          <p className="text-xs text-text-secondary-light dark:text-text-secondary-dark">Hover to preview · tap to watch</p>
        </div>
        <button onClick={() => setMuted((m) => !m)} aria-label={muted ? 'Unmute previews' : 'Mute previews'} className="grid h-8 w-8 place-items-center rounded-full text-text-secondary-light hover:bg-black/5 dark:text-text-secondary-dark dark:hover:bg-white/10">
          {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        <Link to="/app/feed/reels" state={{ fromApp: true }} className="rounded-full px-3 py-1.5 text-sm font-semibold text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-900/25">See all</Link>
      </header>

      <div className="relative">
        <div ref={scroller} onScroll={updateArrows} className="feed-hl-scroll flex gap-2 overflow-x-auto px-4 pb-4">
          {reels.map((reel) => (
            <ReelTile
              key={reel.id}
              reel={reel}
              fresh={fresh.has(reel.id)}
              muted={muted}
              previewing={previewing === reel.id}
              onPreview={(on) => setPreviewing((p) => (on ? reel.id : p === reel.id ? null : p))}
            />
          ))}
          <Link
            to="/app/feed/reels"
            state={{ fromApp: true }}
            className="group flex h-60 w-36 shrink-0 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-light bg-surface-light text-text-secondary-light transition-colors hover:border-pink-400 hover:text-pink-600 dark:border-border-dark/60 dark:bg-card-dark dark:text-text-secondary-dark"
          >
            <span className="grid h-11 w-11 place-items-center rounded-full bg-white shadow transition-transform group-hover:scale-110 dark:bg-elevated-dark"><ChevronRight size={20} /></span>
            <span className="text-sm font-semibold">See more</span>
          </Link>
        </div>
        {canScroll.left && (
          <button onClick={() => nudge(-1)} aria-label="Scroll left" className="absolute left-1.5 top-1/2 z-10 hidden h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-white/90 text-text-primary-light shadow-md hover:bg-white sm:grid dark:bg-elevated-dark/90 dark:text-text-primary-dark"><ChevronLeft size={18} /></button>
        )}
        {canScroll.right && (
          <button onClick={() => nudge(1)} aria-label="Scroll right" className="absolute right-1.5 top-1/2 z-10 hidden h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-white/90 text-text-primary-light shadow-md hover:bg-white sm:grid dark:bg-elevated-dark/90 dark:text-text-primary-dark"><ChevronRight size={18} /></button>
        )}
      </div>
    </section>
  );
};

const ReelTile: React.FC<{
  reel: FeedReelView; fresh: boolean; muted: boolean; previewing: boolean; onPreview: (on: boolean) => void;
}> = ({ reel, fresh, muted, previewing, onPreview }) => {
  const navigate = useNavigate();
  const [ref, inView] = useInViewport<HTMLDivElement>('200px');
  const { url, broken } = useResilientMediaUrl(reel.media.fileId, inView);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (previewing) v.play().catch(() => {});
    else { v.pause(); v.currentTime = 0; setProgress(0); }
  }, [previewing, url]);

  // Touch has no hover: first tap previews, second tap opens.
  const onTap = () => {
    const coarse = window.matchMedia('(hover: none)').matches;
    if (coarse && !previewing) { onPreview(true); return; }
    navigate(`/app/feed/reels/${reel.id}`, { state: { fromApp: true } });
  };

  return (
    <div
      ref={ref}
      role="link"
      tabIndex={0}
      aria-label={`Reel by ${reel.author.name}`}
      onClick={onTap}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/app/feed/reels/${reel.id}`, { state: { fromApp: true } }); } }}
      onMouseEnter={() => onPreview(true)}
      onMouseLeave={() => onPreview(false)}
      onFocus={() => onPreview(true)}
      onBlur={() => onPreview(false)}
      className={`group relative h-60 w-36 shrink-0 cursor-pointer overflow-hidden rounded-xl bg-neutral-900 text-white outline-none transition-transform hover:scale-[1.02] focus-visible:ring-2 focus-visible:ring-blue-500 ${fresh ? 'feed-story-arrive' : ''}`}
    >
      {url && !broken ? (
        <video
          ref={videoRef}
          src={url}
          className="h-full w-full object-cover"
          muted={muted}
          loop
          playsInline
          preload="metadata"
          onTimeUpdate={(e) => { const v = e.currentTarget; if (v.duration) setProgress(v.currentTime / v.duration); }}
        />
      ) : (
        <span className="feed-skeleton absolute inset-0" aria-hidden />
      )}
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/30" />

      {fresh && <span className="feed-pill-in absolute left-1/2 top-2 z-10 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">New</span>}

      {!previewing && (
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-black/40 backdrop-blur transition-transform group-hover:scale-110"><Play size={20} fill="currentColor" className="ml-0.5" /></span>
        </span>
      )}

      <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/40 px-1.5 py-0.5 text-[11px] font-semibold backdrop-blur">
        <Eye size={11} /> {reel.viewCount}
      </span>

      <span className="absolute inset-x-2 bottom-2 space-y-1">
        {reel.caption && <span className="line-clamp-2 text-[11px] leading-tight">{reel.caption}</span>}
        <span className="flex items-center gap-1.5">
          <Avatar name={reel.author.name} src={reel.author.avatarUrl ?? undefined} size={20} />
          <span className="truncate text-xs font-semibold">{firstName(reel.author.name)}</span>
          <span className="ml-auto flex items-center gap-0.5 text-[11px] font-semibold"><Heart size={11} fill={reel.liked ? 'currentColor' : 'none'} className={reel.liked ? 'text-rose-400' : ''} /> {reel.likeCount}</span>
        </span>
      </span>

      <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white/25"><span className="block h-full origin-left bg-white" style={{ transform: `scaleX(${progress})` }} /></span>
    </div>
  );
};
