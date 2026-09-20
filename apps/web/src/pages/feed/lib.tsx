import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ThumbsUp, Heart, PartyPopper, Handshake, Lightbulb, MessageCircleQuestion, ImageOff, type LucideIcon,
} from 'lucide-react';
import { FEED_REACTIONS, FEED_REACTION_META } from '@tupo/shared';
import type { FeedReaction } from '@tupo/shared';
import { inlineUrl, bustTicket } from '../chat/uploads';

export { FEED_REACTIONS, FEED_REACTION_META };

/* ── Reactions as icons ───────────────────────────────────────────────────
      One glyph per reaction, drawn everywhere a reaction shows — the Like
      button, the picker, the count discs, the burst — so the feed has a
      single reaction language instead of emoji that render differently on
      every platform. `solid` marks glyphs that still read as a silhouette
      when fully filled; the rest keep their internal lines and get a tinted
      wash instead. */

const REACTION_ICONS: Record<FeedReaction, { Icon: LucideIcon; solid: boolean }> = {
  like:       { Icon: ThumbsUp, solid: true },
  love:       { Icon: Heart, solid: true },
  celebrate:  { Icon: PartyPopper, solid: false },
  support:    { Icon: Handshake, solid: false },
  insightful: { Icon: Lightbulb, solid: false },
  curious:    { Icon: MessageCircleQuestion, solid: false },
};

/**
 * A reaction glyph. Inactive: an outline in the surrounding text colour.
 * Active: stroked and filled in the reaction's tint — the "fill on click"
 * the Like button does.
 */
export const ReactionIcon: React.FC<{
  reaction: FeedReaction; active?: boolean; size?: number; className?: string;
}> = ({ reaction, active = false, size = 18, className = '' }) => {
  const { Icon, solid } = REACTION_ICONS[reaction];
  return (
    <Icon
      size={size}
      strokeWidth={active ? 2.25 : 2}
      fill={active ? 'currentColor' : 'none'}
      fillOpacity={active ? (solid ? 1 : 0.22) : 0}
      className={`feed-react-icon ${className}`}
      style={active ? { color: FEED_REACTION_META[reaction].tint } : undefined}
      aria-hidden
    />
  );
};

/** The tinted disc with a white glyph — the unit of the picker and the count row. */
export const ReactionDisc: React.FC<{ reaction: FeedReaction; size?: number; className?: string; style?: React.CSSProperties }> = ({
  reaction, size = 18, className = '', style,
}) => {
  const { Icon } = REACTION_ICONS[reaction];
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full text-white ${className}`}
      style={{ width: size, height: size, background: FEED_REACTION_META[reaction].tint, ...style }}
      aria-hidden
    >
      <Icon size={Math.round(size * 0.56)} strokeWidth={2.5} />
    </span>
  );
};

/* ── Time ─────────────────────────────────────────────────────────────── */

export function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return '1m';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fullTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/* ── Media URLs — the browser resolves a file id to a short-lived ticket,
      exactly as chat does. ─────────────────────────────────────────────── */

const urlCache = new Map<string, string>();

/**
 * `retryKey` is not read inside the effect — its only job is to sit in the
 * dependency array so bumping it (after `invalidateMediaUrl` clears the
 * caches) forces a fresh `inlineUrl` call instead of quietly handing back the
 * same URL that just failed to load.
 */
export function useMediaUrl(fileId: string | null | undefined, enabled = true, retryKey = 0): string | undefined {
  const [url, setUrl] = useState<string | undefined>(fileId ? urlCache.get(fileId) : undefined);
  useEffect(() => {
    if (!fileId || !enabled) return;
    const cached = urlCache.get(fileId);
    if (cached) { setUrl(cached); return; }
    let alive = true;
    inlineUrl(fileId).then((u) => { if (alive) { urlCache.set(fileId, u); setUrl(u); } }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, enabled, retryKey]);
  return url;
}

/** Clears both the resolved-URL cache here and the ticket cache in chat's
 *  uploads module, so the next `useMediaUrl` call mints a genuinely fresh URL
 *  instead of replaying one that just failed to load. */
export function invalidateMediaUrl(fileId: string): void {
  urlCache.delete(fileId);
  bustTicket(fileId);
}

/**
 * True once the element has entered (or nearly entered) the viewport, and
 * stays true afterward — a feed image that has been seen once should not
 * unmount its network request just because the user scrolled past it.
 * `rootMargin` starts the fetch a little before the image is actually
 * visible, the same "prefetch just ahead of scroll" behaviour Facebook and
 * Instagram's feeds use instead of firing every request on mount.
 */
export function useInViewport<T extends HTMLElement>(rootMargin = '600px'): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (inView) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { setInView(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) { setInView(true); io.disconnect(); }
    }, { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [inView, rootMargin]);
  return [ref, inView];
}

const MEDIA_MAX_RETRIES = 2;

/**
 * `useMediaUrl` plus the failure handling a real feed needs: up to two
 * automatic retries against a busted cache (most failures are a dropped
 * connection or a momentarily-bad ticket, not a genuinely missing file), then
 * a "tap to reload" state instead of a permanently broken image.
 */
export function useResilientMediaUrl(
  fileId: string | null | undefined, enabled = true,
): { url: string | undefined; broken: boolean; onError: () => void; retry: () => void } {
  const [retryKey, setRetryKey] = useState(0);
  const [broken, setBroken] = useState(false);
  const url = useMediaUrl(fileId, enabled, retryKey);

  useEffect(() => { setBroken(false); setRetryKey(0); }, [fileId]);

  const onError = useCallback(() => {
    if (!fileId) return;
    if (retryKey < MEDIA_MAX_RETRIES) {
      invalidateMediaUrl(fileId);
      setRetryKey((k) => k + 1);
    } else {
      setBroken(true);
    }
  }, [fileId, retryKey]);

  const retry = useCallback(() => {
    if (fileId) invalidateMediaUrl(fileId);
    setBroken(false);
    setRetryKey(0);
  }, [fileId]);

  return { url: broken ? undefined : url, broken, onError, retry };
}

/**
 * A lazy, resilient, fixed-box image — the shared primitive for every media
 * tile, cover photo and thumbnail in the feed. Its network request only
 * fires once the box nears the viewport (`useInViewport`), it shows a
 * shimmering placeholder while that request is in flight, and a failed load
 * gets a couple of silent retries before falling back to a "tap to reload"
 * state — never a permanently broken image icon.
 */
export const FeedImage: React.FC<{
  fileId?: string | null;
  alt?: string;
  className?: string;
  imgClassName?: string;
  onClick?: (e: React.MouseEvent) => void;
  /** Skip the viewport gate — the image is already known to be on screen
   *  (an open lightbox/modal), so there is nothing to wait for. */
  eager?: boolean;
}> = ({ fileId, alt = '', className = '', imgClassName = '', onClick, eager }) => {
  const [ref, inView] = useInViewport<HTMLDivElement>();
  const { url, broken, onError, retry } = useResilientMediaUrl(fileId, eager || inView);

  return (
    <div ref={ref} className={`relative overflow-hidden ${className}`}>
      {url && (
        <img
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          onClick={onClick}
          onError={onError}
          className={`h-full w-full object-cover ${imgClassName}`}
        />
      )}
      {!url && !broken && <span className="feed-skeleton absolute inset-0" aria-hidden />}
      {broken && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); retry(); }}
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-surface-light text-text-secondary-light dark:bg-card-dark dark:text-text-secondary-dark"
        >
          <ImageOff size={18} />
          <span className="text-[11px] font-medium">Tap to reload</span>
        </button>
      )}
    </div>
  );
};

/* ── Rich-text linkify — #hashtags, @mentions and bare links become anchors,
      everything else is escaped. Safe: output is assembled from React nodes,
      never dangerouslySetInnerHTML. ────────────────────────────────────── */

const TOKEN = /(\s|^)(#[\p{L}0-9_]{1,50}|@[\p{L}0-9_.-]{2,40})|(https?:\/\/[^\s<]+)/gu;

export function renderRichText(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0; let key = 0;
  for (const m of text.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) nodes.push(text.slice(last, idx));
    const lead = m[1] ?? '';
    const tag = m[2];
    const link = m[3];
    if (lead) nodes.push(lead);
    if (tag?.startsWith('#')) {
      nodes.push(<a key={key++} href={`/app/feed?tag=${encodeURIComponent(tag.slice(1))}`} className="font-medium text-blue-600 hover:underline dark:text-blue-400">{tag}</a>);
    } else if (tag?.startsWith('@')) {
      nodes.push(<span key={key++} className="font-medium text-blue-600 dark:text-blue-400">{tag}</span>);
    } else if (link) {
      nodes.push(<a key={key++} href={link} target="_blank" rel="noopener noreferrer nofollow" className="text-blue-600 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-500 dark:text-blue-400">{link.replace(/^https?:\/\//, '')}</a>);
    }
    last = idx + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/* ── Reaction picker — the Facebook pill: tinted discs that balloon on
      hover, each with a label bubble, staggered spring entrance. ─────────── */

export const ReactionPicker: React.FC<{
  onPick: (r: FeedReaction) => void;
  onClose: () => void;
  align?: 'left' | 'center';
}> = ({ onPick, onClose, align = 'left' }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Pick a reaction"
      onMouseLeave={onClose}
      className={`feed-picker-in absolute bottom-full z-40 mb-1.5 flex items-center gap-0.5 rounded-full bg-white px-1.5 py-1 shadow-[0_12px_28px_rgba(0,0,0,0.2),0_2px_4px_rgba(0,0,0,0.1)] ring-1 ring-black/5 dark:bg-elevated-dark dark:ring-white/10 ${
        align === 'center' ? 'left-1/2 -translate-x-1/2' : 'left-0'
      }`}
    >
      {FEED_REACTIONS.map((r, i) => (
        <button
          key={r}
          role="menuitem"
          aria-label={FEED_REACTION_META[r].label}
          onClick={() => onPick(r)}
          className="feed-face-in group relative grid h-10 w-10 origin-bottom place-items-center rounded-full transition-transform duration-150 ease-out hover:z-10 hover:-translate-y-2.5 hover:scale-[1.35] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          style={{ animationDelay: `${i * 30}ms` }}
        >
          <ReactionDisc reaction={r} size={32} className="shadow-sm ring-2 ring-white dark:ring-elevated-dark" />
          <span className="pointer-events-none absolute bottom-full mb-1 whitespace-nowrap rounded-md bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100 dark:bg-black">
            {FEED_REACTION_META[r].label}
          </span>
        </button>
      ))}
    </div>
  );
};

/**
 * The overlapping colour-coded reaction discs Facebook shows next to the
 * count — a real blue thumb / red heart disc, not a bare emoji.
 */
export const ReactionBubbles: React.FC<{ reactions: FeedReaction[]; size?: number }> = ({ reactions, size = 18 }) => (
  <span className="flex" style={{ marginRight: reactions.length ? 4 : 0 }}>
    {reactions.map((r, i) => (
      <ReactionDisc
        key={r} reaction={r} size={size}
        className="ring-2 ring-white dark:ring-card-dark"
        style={{ marginLeft: i ? -size * 0.32 : 0, zIndex: reactions.length - i }}
      />
    ))}
  </span>
);

/** A short burst of the reaction's glyph floating up from the button when it lands. */
export const ReactionBurst: React.FC<{ reaction: FeedReaction; seed: number }> = ({ reaction, seed }) => (
  <span className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden>
    {[0, 1, 2].map((i) => (
      <span
        key={`${seed}-${i}`}
        className="feed-emoji-fly absolute left-1/2 top-0"
        style={{
          marginLeft: `${(i - 1) * 12}px`,
          animationDelay: `${i * 70}ms`,
          ['--spin' as string]: `${(i - 1) * 18}deg`,
        }}
      >
        <ReactionIcon reaction={reaction} active size={18} />
      </span>
    ))}
  </span>
);

/**
 * Close a popover on an outside pointer-down or Escape. Returns the ref to
 * anchor on. The menus used to close on `mouseleave` alone, which a touch
 * screen never fires — a menu opened on a phone stayed open until its own
 * button was tapped again.
 */
export function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open, onClose]);
  return ref;
}

/**
 * Facebook's "hover the Like button and the reactions appear" — with a short
 * intent delay on desktop so a passing cursor doesn't trigger it, and a
 * long-press on touch.
 */
export function usePressToOpen(onOpen: () => void, onLeaveClose?: () => void) {
  const enter = useRef<number | undefined>(undefined);
  const press = useRef<number | undefined>(undefined);
  const clear = () => { window.clearTimeout(enter.current); window.clearTimeout(press.current); };
  return {
    onMouseEnter: () => { clear(); enter.current = window.setTimeout(onOpen, 320); },
    onMouseLeave: () => { clear(); onLeaveClose?.(); },
    onTouchStart: () => { clear(); press.current = window.setTimeout(onOpen, 380); },
    onTouchEnd: clear,
    onTouchMove: clear,
  };
}

/** Double-tap / double-click handler that also passes the pointer position. */
export function useDoubleTap(onDouble: (x: number, y: number) => void) {
  const last = useRef(0);
  return (e: React.MouseEvent) => {
    const now = Date.now();
    if (now - last.current < 300) { onDouble(e.clientX, e.clientY); last.current = 0; }
    else last.current = now;
  };
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
