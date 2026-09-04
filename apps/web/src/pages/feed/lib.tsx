import React, { useEffect, useRef, useState } from 'react';
import { FEED_REACTIONS, FEED_REACTION_META } from '@tupo/shared';
import type { FeedReaction } from '@tupo/shared';
import { inlineUrl } from '../chat/uploads';

export { FEED_REACTIONS, FEED_REACTION_META };

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

export function useMediaUrl(fileId: string | null | undefined, enabled = true): string | undefined {
  const [url, setUrl] = useState<string | undefined>(fileId ? urlCache.get(fileId) : undefined);
  useEffect(() => {
    if (!fileId || !enabled) return;
    const cached = urlCache.get(fileId);
    if (cached) { setUrl(cached); return; }
    let alive = true;
    inlineUrl(fileId).then((u) => { if (alive) { urlCache.set(fileId, u); setUrl(u); } }).catch(() => {});
    return () => { alive = false; };
  }, [fileId, enabled]);
  return url;
}

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

/* ── Reaction picker — the Facebook pill: big faces that balloon on hover,
      each with a label bubble, staggered spring entrance. ───────────────── */

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
          className="feed-face-in group relative grid h-10 w-10 origin-bottom place-items-center rounded-full text-[26px] leading-none transition-transform duration-150 ease-out hover:z-10 hover:-translate-y-2.5 hover:scale-[1.45]"
          style={{ animationDelay: `${i * 30}ms` }}
        >
          <span aria-hidden>{FEED_REACTION_META[r].emoji}</span>
          <span className="pointer-events-none absolute bottom-full mb-1 rounded-md bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100 dark:bg-black">
            {FEED_REACTION_META[r].label}
          </span>
        </button>
      ))}
    </div>
  );
};

/**
 * The overlapping colour-coded reaction circles Facebook shows next to the
 * count — a real blue thumb / red heart disc, not a bare emoji.
 */
export const ReactionBubbles: React.FC<{ reactions: FeedReaction[]; size?: number }> = ({ reactions, size = 18 }) => (
  <span className="flex" style={{ marginRight: reactions.length ? 4 : 0 }}>
    {reactions.map((r, i) => (
      <span
        key={r}
        className="grid place-items-center rounded-full ring-2 ring-white dark:ring-card-dark"
        style={{
          width: size, height: size, fontSize: size * 0.62,
          background: FEED_REACTION_META[r].tint,
          marginLeft: i ? -size * 0.32 : 0, zIndex: reactions.length - i,
        }}
      >
        <span aria-hidden style={{ filter: 'saturate(1.3)' }}>{FEED_REACTION_META[r].emoji}</span>
      </span>
    ))}
  </span>
);

/** A short burst of emoji floating up from the button when a reaction lands. */
export const EmojiBurst: React.FC<{ emoji: string; seed: number }> = ({ emoji, seed }) => (
  <span className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden>
    {[0, 1, 2].map((i) => (
      <span
        key={`${seed}-${i}`}
        className="feed-emoji-fly absolute left-1/2 top-0 text-lg"
        style={{
          marginLeft: `${(i - 1) * 12}px`,
          animationDelay: `${i * 70}ms`,
          ['--spin' as string]: `${(i - 1) * 18}deg`,
        }}
      >
        {emoji}
      </span>
    ))}
  </span>
);

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
