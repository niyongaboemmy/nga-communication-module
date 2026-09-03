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

/* ── Reaction picker — hover / long-press to open, staggered pop-in. ──── */

export const ReactionPicker: React.FC<{
  onPick: (r: FeedReaction) => void;
  onClose: () => void;
  anchorClassName?: string;
}> = ({ onPick, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Pick a reaction"
      className="feed-reaction-picker animate-pop absolute bottom-full left-0 z-30 mb-2 flex items-center gap-1 rounded-full border border-border-light bg-white p-1.5 shadow-xl dark:border-border-dark/60 dark:bg-elevated-dark"
    >
      {FEED_REACTIONS.map((r, i) => (
        <button
          key={r}
          role="menuitem"
          title={FEED_REACTION_META[r].label}
          onClick={() => onPick(r)}
          className="feed-reaction-pop grid h-9 w-9 place-items-center rounded-full text-xl transition-transform duration-150 hover:-translate-y-1 hover:scale-125"
          style={{ animationDelay: `${i * 28}ms` }}
        >
          <span aria-hidden>{FEED_REACTION_META[r].emoji}</span>
        </button>
      ))}
    </div>
  );
};

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

export function usePressToOpen(onOpen: () => void) {
  const timer = useRef<number | undefined>(undefined);
  return {
    onMouseEnter: onOpen,
    onTouchStart: () => { timer.current = window.setTimeout(onOpen, 350); },
    onTouchEnd: () => window.clearTimeout(timer.current),
    onTouchMove: () => window.clearTimeout(timer.current),
  };
}
