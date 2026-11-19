import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, FileText, Download, Play, ImageOff, Volume2, VolumeX, Loader2 } from 'lucide-react';
import type { FeedMediaItem } from '@tupo/shared';
import { FeedImage, useInViewport, useResilientMediaUrl } from './lib';
import { downloadFile } from '../chat/uploads';
import { useNotify } from '../../context/NotificationContext';

/* ── Aspect ratios ─────────────────────────────────────────────────────────
   Social feeds show a photo in its own shape, within limits: nothing wider
   than 1.91:1 and nothing taller than 4:5 (Instagram's and Facebook's
   bounds). Anything outside is cropped to the bound; the full picture is one
   tap away in the viewer. */

const WIDEST = 1.91;
const TALLEST = 0.8;
const clampRatio = (r: number) => Math.min(WIDEST, Math.max(TALLEST, r));

type Ratios = Record<string, number>;
type Shape = 'landscape' | 'portrait' | 'square';
const shapeOf = (r: number | undefined): Shape =>
  r === undefined || (r > 0.9 && r < 1.1) ? 'square' : r > 1 ? 'landscape' : 'portrait';

/** Width/height per file: the stored dimensions first, then the decoded
 *  media's real size once it loads (older posts have none stored). */
function useRatios(items: FeedMediaItem[]): [Ratios, (fileId: string, w: number, h: number) => void] {
  const [measured, setMeasured] = useState<Ratios>({});
  const report = useCallback((fileId: string, w: number, h: number) => {
    if (!w || !h) return;
    setMeasured((m) => (m[fileId] === w / h ? m : { ...m, [fileId]: w / h }));
  }, []);
  const ratios: Ratios = {};
  for (const it of items) {
    const stored = it.w && it.h ? it.w / it.h : undefined;
    const r = measured[it.fileId] ?? stored;
    if (r) ratios[it.fileId] = r;
  }
  return [ratios, report];
}

/* ── Tiles ─────────────────────────────────────────────────────────────── */

/** "12 KB", "3.4 MB" — a small file no longer reads "0.0 MB" (F-06). */
export function readableSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const isPdf = (item: FeedMediaItem) => /\.pdf$/i.test(item.name ?? '');

/**
 * A document in a post (F-06). Tapping it opens a preview in the app when the
 * browser can show the file (PDF); the download button says what it is doing
 * and says so if it fails, instead of the old silent button.
 */
const DocumentRow: React.FC<{ item: FeedMediaItem }> = ({ item }) => {
  const { notify } = useNotify();
  const [downloading, setDownloading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const canPreview = isPdf(item);
  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try { await downloadFile(item.fileId, item.name ?? 'file'); }
    catch { notify({ title: 'The download did not work', body: 'Check your connection and try again.', tone: 'error' }); }
    finally { setDownloading(false); }
  };
  return (
    <>
      <div className="flex w-full items-center gap-3 rounded-xl border border-border-light bg-surface-light p-2 dark:border-border-dark/50 dark:bg-card-dark/40">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); if (canPreview) setPreviewing(true); else void download(); }}
          aria-label={canPreview ? `Preview ${item.name ?? 'document'}` : `Download ${item.name ?? 'document'}`}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-left transition-colors hover:bg-blue-50 dark:hover:bg-blue-900/20"
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300">
            <FileText size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-text-primary-light dark:text-text-primary-dark">{item.name ?? 'Document'}</span>
            <span className="text-xs text-text-secondary-light dark:text-text-secondary-dark">
              {[canPreview ? 'PDF · tap to preview' : 'Document', readableSize(item.size)].filter(Boolean).join(' · ')}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void download(); }}
          disabled={downloading}
          aria-label={downloading ? 'Downloading…' : `Download ${item.name ?? 'document'}`}
          aria-busy={downloading}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-text-secondary-light hover:bg-blue-50 hover:text-blue-600 disabled:opacity-70 dark:text-text-secondary-dark dark:hover:bg-blue-900/20"
        >
          {downloading ? <Loader2 size={17} className="animate-spin" /> : <Download size={17} />}
        </button>
      </div>
      {previewing && <DocumentPreview item={item} onClose={() => setPreviewing(false)} onDownload={() => void download()} downloading={downloading} />}
    </>
  );
};

/** The browser's own PDF viewer, in a full-screen sheet with Download and Close. */
const DocumentPreview: React.FC<{ item: FeedMediaItem; onClose: () => void; onDownload: () => void; downloading: boolean }> = ({
  item, onClose, onDownload, downloading,
}) => {
  const { url, broken, retry } = useResilientMediaUrl(item.fileId, true);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={`Preview of ${item.name ?? 'document'}`} className="fixed inset-0 z-[120] flex flex-col bg-black/85">
      <div className="flex items-center gap-2 px-3 py-2 text-white sm:px-5" style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}>
        <FileText size={18} className="shrink-0 opacity-80" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.name ?? 'Document'}</span>
        <button type="button" onClick={onDownload} disabled={downloading} aria-label="Download"
          className="grid h-10 w-10 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-60">
          {downloading ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
        </button>
        <button type="button" onClick={onClose} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-full bg-white/10 hover:bg-white/20">
          <X size={20} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1 px-0 pb-0 sm:px-6 sm:pb-6">
        {url && <iframe title={item.name ?? 'Document'} src={url} onLoad={() => setLoaded(true)} className="h-full w-full rounded-none bg-white sm:rounded-lg" />}
        {(!url || !loaded) && !broken && (
          <div className="absolute inset-0 grid place-items-center" role="status" aria-label="Loading the document">
            <Loader2 size={28} className="animate-spin text-white/80" />
          </div>
        )}
        {broken && (
          <button type="button" onClick={retry} className="absolute inset-0 grid place-items-center text-sm font-medium text-white/80">
            Couldn't load the document. Tap to retry.
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
};

interface TileProps {
  item: FeedMediaItem;
  onOpen: () => void;
  onDims: (fileId: string, w: number, h: number) => void;
  /** Very tall pictures (letters, screenshots) read from the top, so crop
   *  their bottom rather than their middle. */
  anchorTop?: boolean;
  overlay?: number;
  style?: React.CSSProperties;
  className?: string;
}

/** One picture or video cell. It always fills the box its parent gives it. */
const Tile: React.FC<TileProps> = ({ item, onOpen, onDims, anchorTop, overlay, style, className = '' }) => {
  // A video carries its own controls (F-03), which cannot sit inside a button:
  // its tile is a plain box whose full-area "Play video" button opens the viewer.
  if (item.kind === 'video') {
    return (
      <div data-testid="feed-media-tile" className={`group relative block h-full w-full overflow-hidden bg-slate-100 dark:bg-white/5 ${className}`} style={style}>
        <VideoFill item={item} onDims={onDims} onOpen={onOpen} />
        {overlay ? (
          <span className="pointer-events-none absolute inset-0 grid place-items-center bg-black/50 text-3xl font-semibold text-white">+{overlay}</span>
        ) : null}
      </div>
    );
  }
  const label = `Open photo${item.name ? `: ${item.name}` : ''}`;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
      aria-label={label}
      data-testid="feed-media-tile"
      className={`group relative block h-full w-full overflow-hidden bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:bg-white/5 ${className}`}
      style={style}
    >
      <FeedImage
        thumb
        fileId={item.fileId}
        alt={item.name ?? ''}
        className="absolute inset-0"
        imgClassName={`transition-[filter] duration-200 group-hover:brightness-[0.94] ${anchorTop ? 'object-top' : ''}`}
        onDims={(w, h) => onDims(item.fileId, w, h)}
      />
      {overlay ? (
        <span className="absolute inset-0 grid place-items-center bg-black/50 text-3xl font-semibold text-white">+{overlay}</span>
      ) : null}
    </button>
  );
};

/** In-post video (U-21): plays muted and looped while mostly on screen and
 *  pauses when scrolled away, as on Facebook — unless the person asked for
 *  less motion or less data, when it stays a still frame with a play badge.
 *  Lazy and resilient like `FeedImage`. */
const autoplayAllowed = () => {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !(conn?.saveData || conn?.effectiveType === '2g' || conn?.effectiveType === 'slow-2g');
};

/* ── Sound and position, shared by every video in the feed (F-03, F-04) ──
   One switch for sound, remembered on this device, and at most one video
   heard at a time. The last position of each video, so the viewer continues
   where the post left off instead of starting again. */
const SOUND_KEY = 'tupo.feed.sound';
let audibleId: string | null = null;
let soundOn = (() => { try { return localStorage.getItem(SOUND_KEY) === 'on'; } catch { return false; } })();
const soundListeners = new Set<() => void>();
let soundVersion = 0;
function setSound(fileId: string | null, on: boolean) {
  soundOn = on;
  audibleId = on ? fileId : null;
  try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* not remembered */ }
  soundVersion += 1;
  soundListeners.forEach((l) => l());
}
function useSound(fileId: string): { audible: boolean; toggle: () => void } {
  useSyncExternalStore((cb) => { soundListeners.add(cb); return () => { soundListeners.delete(cb); }; }, () => soundVersion);
  const audible = soundOn && audibleId === fileId;
  return { audible, toggle: () => setSound(fileId, !audible) };
}
/** Last known playback position per file, read by the viewer (F-04). */
export const videoPositions = new Map<string, number>();

const clock = (s: number) => (Number.isFinite(s) && s >= 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');

const VideoFill: React.FC<{ item: FeedMediaItem; onDims: TileProps['onDims']; onOpen: () => void }> = ({ item, onDims, onOpen }) => {
  const [ref, inView] = useInViewport<HTMLSpanElement>();
  const { url, broken, onError, retry } = useResilientMediaUrl(item.fileId, inView);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [time, setTime] = useState({ t: 0, d: 0 });
  const { audible, toggle } = useSound(item.fileId);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !url) return;
    const io = new IntersectionObserver(([e]) => {
      const visible = Boolean(e && e.intersectionRatio >= 0.6);
      // Sound left on: the next video to come into view is the one heard.
      if (visible && soundOn && audibleId === null) setSound(item.fileId, true);
      if (visible && autoplayAllowed()) void v.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
      else if (!visible) {
        v.pause();
        setPlaying(false);
        // Scrolled away with the sound on: the sound goes with it.
        if (audibleId === item.fileId) setSound(null, soundOn);
      }
    }, { threshold: [0, 0.6, 1] });
    io.observe(v);
    return () => { io.disconnect(); v.pause(); };
  }, [url, item.fileId]);

  // Sound follows the shared switch; turning it on also starts a still video.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !audible;
    if (audible && v.paused) void v.play().then(() => setPlaying(true)).catch(() => {});
  }, [audible, url]);

  const remaining = time.d ? Math.max(0, time.d - time.t) : 0;
  return (
    <span ref={ref} className="absolute inset-0">
      {url && (
        <video
          ref={videoRef}
          src={url}
          className="h-full w-full object-cover"
          muted playsInline loop preload="metadata"
          data-autoplaying={playing ? 'true' : 'false'}
          onError={onError}
          onLoadedMetadata={(e) => {
            onDims(item.fileId, e.currentTarget.videoWidth, e.currentTarget.videoHeight);
            setTime({ t: 0, d: e.currentTarget.duration });
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            videoPositions.set(item.fileId, v.currentTime);
            setTime({ t: v.currentTime, d: v.duration });
          }}
          onWaiting={() => setBuffering(true)}
          onPlaying={() => { setBuffering(false); setPlaying(true); }}
          onCanPlay={() => setBuffering(false)}
          onPause={() => setPlaying(false)}
        />
      )}
      {/* The whole video opens the viewer, at the same moment (F-04). */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpen(); }}
        aria-label="Play video"
        className="absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
      >
        {url && !playing && !buffering && (
          <span className="absolute inset-0 grid place-items-center bg-black/20">
            <span className="grid h-14 w-14 place-items-center rounded-full bg-black/55 text-white ring-2 ring-white/80 backdrop-blur-sm">
              <Play size={24} className="ml-1" fill="currentColor" />
            </span>
          </span>
        )}
      </button>
      {buffering && (
        <span role="status" aria-label="Loading video" className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="h-10 w-10 animate-spin rounded-full border-[3px] border-white/40 border-t-white" />
        </span>
      )}
      {url && time.d > 0 && (
        <>
          {/* Time left and the sound switch, as on Facebook. */}
          <span data-testid="video-time-left" className="pointer-events-none absolute bottom-2.5 left-2.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">
            {clock(remaining)}
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggle(); }}
            aria-label={audible ? 'Mute video' : 'Unmute video'}
            aria-pressed={audible}
            className="absolute bottom-2 right-2 grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            {audible ? <Volume2 size={17} /> : <VolumeX size={17} />}
          </button>
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-white/25" aria-hidden="true">
            <span data-testid="video-progress" className="block h-full bg-blue-500" style={{ width: `${Math.min(100, (time.t / time.d) * 100)}%` }} />
          </span>
        </>
      )}
      {!url && !broken && <span className="feed-skeleton absolute inset-0" />}
      {broken && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); retry(); }}
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-slate-100 text-text-secondary-light dark:bg-white/5 dark:text-text-secondary-dark"
        >
          <ImageOff size={18} /> <span className="text-[11px] font-medium">Tap to reload</span>
        </button>
      )}
    </span>
  );
};

/* ── Collage ───────────────────────────────────────────────────────────────
   The familiar Facebook layouts: one photo in its own shape; two side by side
   (or stacked when they are wide); three or four as a hero plus a strip — the
   hero on top when it is wide, on the left when it is tall; five or more as
   two over three with "+N" on the last cell. */

interface Cell { col: string; row: string }
interface Layout { aspect: string; cols: string; rows: string; cells: Cell[] }

function collageLayout(count: number, first: Shape): Layout {
  const c = (col: string, row: string): Cell => ({ col, row });
  if (count === 2) {
    if (first === 'landscape') return { aspect: '1 / 1', cols: '1fr', rows: '1fr 1fr', cells: [c('1', '1'), c('1', '2')] };
    return { aspect: first === 'square' ? '2 / 1' : '1 / 1', cols: '1fr 1fr', rows: '1fr', cells: [c('1', '1'), c('2', '1')] };
  }
  if (count === 3) {
    if (first === 'landscape') return { aspect: '1 / 1', cols: '1fr 1fr', rows: '3fr 2fr', cells: [c('1 / 3', '1'), c('1', '2'), c('2', '2')] };
    return { aspect: '1 / 1', cols: '1fr 1fr', rows: '1fr 1fr', cells: [c('1', '1 / 3'), c('2', '1'), c('2', '2')] };
  }
  if (count === 4) {
    if (first === 'landscape') return { aspect: '1 / 1', cols: '1fr 1fr 1fr', rows: '2fr 1fr', cells: [c('1 / 4', '1'), c('1', '2'), c('2', '2'), c('3', '2')] };
    if (first === 'portrait') return { aspect: '1 / 1', cols: '2fr 1fr', rows: '1fr 1fr 1fr', cells: [c('1', '1 / 4'), c('2', '1'), c('2', '2'), c('2', '3')] };
    return { aspect: '1 / 1', cols: '1fr 1fr', rows: '1fr 1fr', cells: [c('1', '1'), c('2', '1'), c('1', '2'), c('2', '2')] };
  }
  return {
    aspect: '1 / 1', cols: 'repeat(6, 1fr)', rows: '3fr 2fr',
    cells: [c('1 / 4', '1'), c('4 / 7', '1'), c('1 / 3', '2'), c('3 / 5', '2'), c('5 / 7', '2')],
  };
}

export const MediaGallery: React.FC<{ media: FeedMediaItem[]; bleed?: boolean }> = ({ media, bleed = false }) => {
  const [viewer, setViewer] = useState<number | null>(null);
  const visual = media.filter((m) => m.kind !== 'document');
  const docs = media.filter((m) => m.kind === 'document');
  const [ratios, report] = useRatios(visual);
  if (!media.length) return null;

  const round = bleed ? '' : 'overflow-hidden rounded-xl';

  const collage = (() => {
    if (visual.length === 0) return null;
    if (visual.length === 1) {
      const item = visual[0]!;
      const r = ratios[item.fileId];
      return (
        <div className={`w-full ${round}`} style={{ aspectRatio: String(r ? clampRatio(r) : 1) }} data-testid="feed-media-single">
          <Tile item={item} onOpen={() => setViewer(0)} onDims={report} anchorTop={r !== undefined && r < TALLEST} />
        </div>
      );
    }
    const layout = collageLayout(visual.length, shapeOf(ratios[visual[0]!.fileId]));
    const shown = visual.slice(0, layout.cells.length);
    const extra = visual.length - shown.length;
    return (
      <div
        className={`grid w-full gap-[2px] ${round}`}
        style={{ aspectRatio: layout.aspect, gridTemplateColumns: layout.cols, gridTemplateRows: layout.rows }}
        data-testid="feed-media-collage"
      >
        {shown.map((m, idx) => (
          <Tile
            key={m.fileId}
            item={m}
            onOpen={() => setViewer(idx)}
            onDims={report}
            overlay={idx === shown.length - 1 && extra > 0 ? extra : undefined}
            style={{ gridColumn: layout.cells[idx]!.col, gridRow: layout.cells[idx]!.row }}
          />
        ))}
      </div>
    );
  })();

  return (
    <div className={bleed ? 'space-y-1' : 'mt-3 space-y-2'}>
      {collage}
      {docs.length > 0 && (
        <div className={bleed ? 'space-y-2 px-3 pt-2 sm:px-4' : 'space-y-2'}>
          {docs.map((d) => <DocumentRow key={d.fileId} item={d} />)}
        </div>
      )}
      {viewer !== null && <MediaViewer items={visual} index={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
};

/* ── Full-screen viewer ────────────────────────────────────────────────────
   Portalled to <body> so no transformed/contained ancestor (the card's
   entrance animation, a sticky column) can shrink `position: fixed` down to
   the card. Black, edge to edge on a phone; swipe between items, swipe down
   to close, pinch or double-tap to zoom, drag to pan while zoomed. */

interface Zoom { s: number; x: number; y: number }
const NO_ZOOM: Zoom = { s: 1, x: 0, y: 0 };
const MAX_ZOOM = 4;

type Gesture =
  | { kind: 'pending'; x0: number; y0: number; t0: number; base: Zoom }
  | { kind: 'swipe' | 'dismiss' | 'pan'; x0: number; y0: number; t0: number; base: Zoom }
  | { kind: 'pinch'; d0: number; base: Zoom };

const MediaViewer: React.FC<{ items: FeedMediaItem[]; index: number; onClose: () => void }> = ({ items, index, onClose }) => {
  const [i, setI] = useState(index);
  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [chrome, setChrome] = useState(true);
  const stageRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const tapTimer = useRef<number | undefined>(undefined);

  const count = items.length;
  const item = items[i]!;
  const go = useCallback((d: number) => {
    setI((c) => Math.min(count - 1, Math.max(0, c + d)));
  }, [count]);

  useEffect(() => { setZoom(NO_ZOOM); }, [i]);

  // Keyboard, scroll lock, focus in and back out.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    document.addEventListener('keydown', key);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', key);
      document.body.style.overflow = overflow;
      window.clearTimeout(tapTimer.current);
      opener?.focus?.({ preventScroll: true });
    };
  }, [go, onClose]);

  const clampPan = useCallback((z: Zoom): Zoom => {
    const el = stageRef.current;
    if (!el || z.s <= 1) return NO_ZOOM;
    const mx = (el.clientWidth * (z.s - 1)) / 2;
    const my = (el.clientHeight * (z.s - 1)) / 2;
    return { s: z.s, x: Math.min(mx, Math.max(-mx, z.x)), y: Math.min(my, Math.max(-my, z.y)) };
  }, []);

  /** Double-tap: zoom in to 2.5× around the tapped point, or back out. */
  const toggleZoomAt = useCallback((cx: number, cy: number) => {
    setZoom((z) => {
      if (z.s > 1) return NO_ZOOM;
      const el = stageRef.current;
      if (!el) return z;
      const rect = el.getBoundingClientRect();
      const s = 2.5;
      const dx = cx - (rect.left + rect.width / 2);
      const dy = cy - (rect.top + rect.height / 2);
      return clampPan({ s, x: -dx * (s - 1), y: -dy * (s - 1) });
    });
  }, [clampPan]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // The arrow buttons live on the stage; their clicks are not gestures.
    if ((e.target as HTMLElement).closest('button:not([data-viewer-media])')) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: 'pinch', d0: Math.hypot(a!.x - b!.x, a!.y - b!.y), base: zoom };
      stageRef.current?.setPointerCapture(e.pointerId);
      setDragging(true);
    } else if (pointers.current.size === 1) {
      gesture.current = { kind: 'pending', x0: e.clientX, y0: e.clientY, t0: performance.now(), base: zoom };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;

    if (g.kind === 'pinch') {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const s = Math.min(MAX_ZOOM, Math.max(1, g.base.s * (Math.hypot(a.x - b.x, a.y - b.y) / g.d0)));
      setZoom(clampPan({ s, x: g.base.x * (s / g.base.s), y: g.base.y * (s / g.base.s) }));
      return;
    }

    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (g.kind === 'pending') {
      if (Math.hypot(dx, dy) < 8) return;
      // Decide once what this drag is, and only then capture the pointer —
      // capturing on press would swallow taps on a video's own controls.
      const kind = g.base.s > 1 ? 'pan' : Math.abs(dx) > Math.abs(dy) ? 'swipe' : dy > 0 ? 'dismiss' : null;
      if (!kind) { gesture.current = null; return; }
      gesture.current = { ...g, kind };
      stageRef.current?.setPointerCapture(e.pointerId);
      setDragging(true);
      return;
    }
    if (g.kind === 'pan') setZoom(clampPan({ s: g.base.s, x: g.base.x + dx, y: g.base.y + dy }));
    else if (g.kind === 'swipe') {
      const atEdge = (i === 0 && dx > 0) || (i === count - 1 && dx < 0);
      setDrag({ x: atEdge ? dx * 0.3 : dx, y: 0 });
    } else if (g.kind === 'dismiss') setDrag({ x: 0, y: Math.max(0, dy) });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    const p = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0) {
      // Lifting one finger of a pinch: carry on as a pan with the other.
      const [rest] = [...pointers.current.values()];
      if (rest) gesture.current = { kind: 'pan', x0: rest.x, y0: rest.y, t0: performance.now(), base: zoom };
      return;
    }
    gesture.current = null;
    setDragging(false);
    if (!g || !p) return;

    if (g.kind === 'swipe') {
      const dx = p.x - g.x0;
      const fast = Math.abs(dx) / Math.max(1, performance.now() - g.t0) > 0.5;
      const width = stageRef.current?.clientWidth ?? 400;
      if (dx < 0 && (dx < -width / 5 || fast)) go(1);
      else if (dx > 0 && (dx > width / 5 || fast)) go(-1);
    } else if (g.kind === 'dismiss') {
      if (p.y - g.y0 > 110) { onClose(); return; }
    } else if (g.kind === 'pending' && e.type === 'pointerup') {
      // A tap. Two in quick succession zoom; a single one on the picture
      // shows/hides the controls; a single one on the backdrop closes.
      const onMedia = (e.target as HTMLElement).closest('[data-viewer-media]');
      const now = performance.now();
      const prev = lastTap.current;
      if (prev && now - prev.t < 300 && Math.hypot(p.x - prev.x, p.y - prev.y) < 30) {
        window.clearTimeout(tapTimer.current);
        lastTap.current = null;
        if (onMedia && item.kind === 'image') toggleZoomAt(p.x, p.y);
      } else {
        lastTap.current = { t: now, x: p.x, y: p.y };
        window.clearTimeout(tapTimer.current);
        tapTimer.current = window.setTimeout(() => {
          if (!onMedia) onClose();
          else if (item.kind === 'image') setChrome((c) => !c);
        }, 260);
      }
    }
    setDrag({ x: 0, y: 0 });
  };

  const onWheel = (e: React.WheelEvent) => {
    if (item.kind !== 'image' || !(e.ctrlKey || e.metaKey || zoom.s > 1)) return;
    const s = Math.min(MAX_ZOOM, Math.max(1, zoom.s * Math.exp(-e.deltaY * 0.01)));
    setZoom(clampPan({ s, x: zoom.x * (s / zoom.s), y: zoom.y * (s / zoom.s) }));
  };

  const fade = Math.max(0.35, 1 - drag.y / 400); // backdrop thins as you swipe down to close

  return createPortal(
    <div
      className="feed-viewer-in fixed inset-0 z-[1000] flex h-[100dvh] w-screen flex-col overflow-hidden text-white"
      style={{ backgroundColor: `rgba(0,0,0,${fade})` }}
      role="dialog"
      aria-modal="true"
      aria-label={`Media viewer, ${i + 1} of ${count}`}
      data-testid="feed-media-viewer"
    >
      {/* Top bar */}
      <div
        className={`absolute inset-x-0 top-0 z-20 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 pb-8 transition-opacity duration-200 sm:px-5 ${chrome && drag.y === 0 ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        {count > 1 && <span className="text-sm font-medium tabular-nums text-white/90">{i + 1} / {count}</span>}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void downloadFile(item.fileId, item.name ?? (item.kind === 'video' ? 'video' : 'photo'))}
          aria-label="Download"
          className="grid h-10 w-10 place-items-center rounded-full bg-white/10 transition-colors hover:bg-white/20"
        >
          <Download size={19} />
        </button>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-10 w-10 place-items-center rounded-full bg-white/10 transition-colors hover:bg-white/20"
        >
          <X size={21} />
        </button>
      </div>

      {/* Stage: a track of full-viewport slides */}
      <div
        ref={stageRef}
        // Edge to edge on a phone; on a wide screen leave room for the top bar
        // and the thumbnail strip so neither sits on the picture.
        className={`relative min-h-0 flex-1 touch-none select-none ${count > 1 ? 'md:pb-24 md:pt-16' : 'md:py-16'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <div
          className="flex h-full"
          style={{
            transform: `translate3d(calc(${-i * 100}% + ${drag.x}px), ${drag.y}px, 0)`,
            transition: dragging ? 'none' : 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          {items.map((m, idx) => (
            <Slide
              key={m.fileId}
              item={m}
              active={idx === i}
              near={Math.abs(idx - i) <= 1}
              zoom={idx === i ? zoom : NO_ZOOM}
              animateZoom={!dragging}
              shrink={idx === i ? 1 - Math.min(0.25, drag.y / 1200) : 1}
            />
          ))}
        </div>

        {count > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              disabled={i === 0}
              aria-label="Previous"
              className={`absolute left-4 top-1/2 z-10 hidden h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-white/10 backdrop-blur transition hover:bg-white/20 disabled:pointer-events-none disabled:opacity-0 md:grid ${chrome ? '' : 'opacity-0'}`}
            >
              <ChevronLeft size={26} />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              disabled={i === count - 1}
              aria-label="Next"
              className={`absolute right-4 top-1/2 z-10 hidden h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-white/10 backdrop-blur transition hover:bg-white/20 disabled:pointer-events-none disabled:opacity-0 md:grid ${chrome ? '' : 'opacity-0'}`}
            >
              <ChevronRight size={26} />
            </button>
          </>
        )}
      </div>

      {/* Position: dots on a phone, thumbnails on a wider screen */}
      {count > 1 && (
        <div
          className={`absolute inset-x-0 bottom-0 z-20 flex justify-center bg-gradient-to-t from-black/70 to-transparent px-3 pt-8 transition-opacity duration-200 ${chrome && drag.y === 0 ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <div className="flex gap-1.5 md:hidden" aria-hidden>
            {items.map((m, idx) => (
              <span key={m.fileId} className={`h-1.5 rounded-full transition-all ${idx === i ? 'w-4 bg-white' : 'w-1.5 bg-white/45'}`} />
            ))}
          </div>
          <div className="hidden max-w-full gap-2 overflow-x-auto md:flex">
            {items.map((m, idx) => (
              <button
                key={m.fileId}
                type="button"
                onClick={() => setI(idx)}
                aria-label={`Show item ${idx + 1}`}
                aria-current={idx === i}
                className={`relative h-14 w-14 shrink-0 overflow-hidden rounded-md transition ${idx === i ? 'ring-2 ring-white' : 'opacity-50 hover:opacity-90'}`}
              >
                {m.kind === 'image'
                  ? <FeedImage fileId={m.fileId} className="absolute inset-0" eager />
                  : <span className="absolute inset-0 grid place-items-center bg-white/10"><Play size={16} fill="currentColor" /></span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
};

/** One slide of the viewer: the item scaled to fit the viewport, never
 *  cropped. Only the current slide and its neighbours fetch anything. */
const Slide: React.FC<{ item: FeedMediaItem; active: boolean; near: boolean; zoom: Zoom; animateZoom: boolean; shrink: number }> = ({
  item, active, near, zoom, animateZoom, shrink,
}) => {
  const { url, broken, onError, retry } = useResilientMediaUrl(item.fileId, near);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [waiting, setWaiting] = useState(false);

  useLayoutEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (active) void v.play().catch(() => {});
    else v.pause();
  }, [active, url]);

  const transform = `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.s * shrink})`;

  return (
    <div className={`flex h-full w-full shrink-0 items-center justify-center overflow-hidden ${active ? 'feed-viewer-pop' : ''}`} aria-hidden={!active}>
      {url && item.kind === 'image' && (
        <img
          src={url}
          alt={item.name ?? ''}
          draggable={false}
          onError={onError}
          data-viewer-media
          className="max-h-full max-w-full object-contain"
          style={{ transform, transition: animateZoom ? 'transform 220ms ease-out' : 'none', cursor: zoom.s > 1 ? 'grab' : 'zoom-in' }}
        />
      )}
      {url && item.kind === 'video' && (
        <video
          ref={videoRef}
          src={url}
          controls
          playsInline
          onError={onError}
          // Continue where the post's video was (F-04), and with sound.
          onLoadedMetadata={(e) => {
            const at = videoPositions.get(item.fileId);
            if (at && at < e.currentTarget.duration - 0.5) e.currentTarget.currentTime = at;
            e.currentTarget.muted = false;
          }}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onCanPlay={() => setWaiting(false)}
          data-viewer-media
          className="max-h-full max-w-full"
          style={{ transform: `scale(${shrink})` }}
        />
      )}
      {url && item.kind === 'video' && waiting && active && (
        <span role="status" aria-label="Loading video" className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="h-12 w-12 animate-spin rounded-full border-4 border-white/30 border-t-white" />
        </span>
      )}
      {!url && !broken && <div className="feed-skeleton aspect-[4/5] w-[min(80vw,24rem)] rounded-lg opacity-30" />}
      {broken && (
        <button
          type="button"
          data-viewer-media
          onClick={(e) => { e.stopPropagation(); retry(); }}
          className="flex h-64 w-[min(80vw,24rem)] flex-col items-center justify-center gap-2 rounded-lg bg-white/5 text-white/70"
        >
          <ImageOff size={28} /> <span className="text-sm font-medium">Couldn't load. Tap to retry.</span>
        </button>
      )}
    </div>
  );
};
