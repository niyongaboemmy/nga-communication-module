import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileText, Download, Play, Pause, X, ChevronLeft, ChevronRight, ImageOff,
} from 'lucide-react';
import { IconButton, Spinner } from '../../components/ui';
import { formatBytes } from './data';
import { downloadFile, useMediaUrl } from './uploads';
import type { Attachment } from './types';

/**
 * Attachments, as they appear inside a message.
 *
 * Media is rendered, not listed. An image posted in a chat is content — the
 * whole point of sending it is that people see it without a second action — and
 * a row saying "photo.jpg · 1.2 MB" is a worse version of every chat product
 * anyone has used.
 *
 * Everything here loads through a short-lived media ticket rather than a raw
 * URL, so an attachment is still authorised on every request. See
 * `uploads.ts → inlineUrl`.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Ticketed source
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Resolve a media URL for a file, once, when the element is actually shown.
 *
 * Deliberately lazy: a channel with three hundred images in its history would
 * otherwise mint three hundred tickets on mount, for pictures nobody has
 * scrolled to.
 */
/** Renders its children only once they have been scrolled near. */
const WhenVisible: React.FC<{
  children: (visible: boolean) => React.ReactNode;
  className?: string;
}> = ({ children, className }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) setVisible(true); },
      { rootMargin: '300px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  return <div ref={ref} className={className}>{children(visible)}</div>;
};

/* ────────────────────────────────────────────────────────────────────────── *
 * Lightbox
 * ────────────────────────────────────────────────────────────────────────── */

export const Lightbox: React.FC<{
  items: Attachment[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}> = ({ items, index, onIndex, onClose }) => {
  const current = items[index];
  const { url, failed } = useMediaUrl(current?.fileId ?? '', Boolean(current));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && index < items.length - 1) onIndex(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    };
    document.addEventListener('keydown', onKey);
    // The page behind must not scroll while a full-screen viewer is open.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [index, items.length, onIndex, onClose]);

  if (!current) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${current.name}, ${index + 1} of ${items.length}`}
      className="fixed inset-0 z-100 flex flex-col bg-black/92"
    >
      <header className="flex shrink-0 items-center gap-2 px-3 py-2 text-white">
        <span className="min-w-0 flex-1 truncate text-sm">{current.name}</span>
        <span className="shrink-0 text-xs opacity-70">
          {index + 1} / {items.length}
        </span>
        <button
          onClick={() => void downloadFile(current.fileId, current.name)}
          aria-label={`Download ${current.name}`}
          className="grid h-9 w-9 place-items-center rounded-full text-white/90 hover:bg-white/15"
        >
          <Download size={18} />
        </button>
        <button
          onClick={onClose}
          aria-label="Close viewer"
          className="grid h-9 w-9 place-items-center rounded-full text-white/90 hover:bg-white/15"
        >
          <X size={18} />
        </button>
      </header>

      {/* Clicking the backdrop closes; clicking the image itself does not, so a
          mis-aimed tap while panning a large picture is not a dismissal. */}
      <div className="grid min-h-0 flex-1 place-items-center p-4" onClick={onClose}>
        {failed ? (
          <p className="flex flex-col items-center gap-2 text-sm text-white/70">
            <ImageOff size={28} /> This file could not be loaded.
          </p>
        ) : !url ? (
          <Spinner className="text-white" />
        ) : current.kind === 'video' ? (
          <video
            src={url}
            controls
            autoPlay
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full rounded-lg"
          />
        ) : (
          <img
            src={url}
            alt={current.name}
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        )}
      </div>

      {items.length > 1 && (
        <>
          <button
            onClick={() => onIndex(index - 1)}
            disabled={index === 0}
            aria-label="Previous"
            className="absolute left-2 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-25"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            onClick={() => onIndex(index + 1)}
            disabled={index === items.length - 1}
            aria-label="Next"
            className="absolute right-2 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-25"
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────────── *
 * Voice notes
 * ────────────────────────────────────────────────────────────────────────── */

const SPEEDS = [1, 1.5, 2] as const;

/**
 * A voice note: waveform, scrub, and variable-speed playback (FR-MSG-20).
 *
 * The waveform is drawn from peaks computed by the sender's browser at record
 * time. Recomputing it here would mean every listener decoding the whole audio
 * file just to draw eighty bars.
 */
export const VoiceNote: React.FC<{ attachment: Attachment; onDark: boolean }> = (
  { attachment: a, onDark },
) => {
  const { url } = useMediaUrl(a.fileId, true);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);

  const duration = (a.durationMs ?? 0) / 1000;
  const peaks = a.waveform?.length ? a.waveform : Array.from({ length: 40 }, () => 0.35);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); } else { void el.play(); }
  };

  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!;
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const seek = (fraction: number) => {
    const el = audioRef.current;
    if (!el || !Number.isFinite(el.duration)) return;
    el.currentTime = el.duration * Math.min(Math.max(fraction, 0), 1);
  };

  const played = duration > 0 ? position / duration : 0;
  const mmss = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  return (
    <div className={`flex items-center gap-2 rounded-xl px-1 py-1 ${onDark ? '' : ''}`}>
      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setPosition(0); }}
          onTimeUpdate={(e) => setPosition((e.target as HTMLAudioElement).currentTime)}
        />
      )}

      <button
        onClick={toggle}
        disabled={!url}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${
          onDark ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-blue-600 text-white hover:bg-blue-700'
        } disabled:opacity-50`}
      >
        {playing ? <Pause size={14} /> : <Play size={14} className="translate-x-px" />}
      </button>

      {/* The waveform is the scrubber. A separate slider underneath would be a
          second control for the same thing in half the space. */}
      <button
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          seek((e.clientX - rect.left) / rect.width);
        }}
        aria-label="Seek"
        className="flex h-8 min-w-[7rem] flex-1 items-center gap-[2px]"
      >
        {peaks.map((peak, i) => {
          const reached = i / peaks.length <= played;
          return (
            <span
              key={i}
              style={{ height: `${Math.max(peak * 100, 12)}%` }}
              className={`w-full rounded-full transition-colors duration-75 ${
                onDark
                  ? (reached ? 'bg-white' : 'bg-white/35')
                  : (reached ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-600')
              }`}
            />
          );
        })}
      </button>

      <span className={`shrink-0 text-[11px] tabular-nums ${onDark ? 'text-white/80' : 'text-text-secondary-light dark:text-text-secondary-dark'}`}>
        {mmss(playing || position > 0 ? position : duration)}
      </span>

      <button
        onClick={cycleSpeed}
        aria-label={`Playback speed ${speed}×`}
        className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
          onDark ? 'bg-white/20 text-white' : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
        }`}
      >
        {speed}×
      </button>
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────────── *
 * The attachment block on a message
 * ────────────────────────────────────────────────────────────────────────── */

const ImageTile: React.FC<{
  attachment: Attachment;
  onOpen: () => void;
  className?: string;
}> = ({ attachment: a, onOpen, className = '' }) => (
  <WhenVisible className={className}>
    {(visible) => <ImageTileInner attachment={a} onOpen={onOpen} visible={visible} />}
  </WhenVisible>
);

const ImageTileInner: React.FC<{
  attachment: Attachment; onOpen: () => void; visible: boolean;
}> = ({ attachment: a, onOpen, visible }) => {
  const { url, failed } = useMediaUrl(a.fileId, visible);
  // The box is reserved from the dimensions the sender's browser measured, so
  // the log does not jump as pictures decode.
  const ratio = a.width && a.height ? a.width / a.height : 4 / 3;

  return (
    <button
      onClick={onOpen}
      aria-label={`Open ${a.name}`}
      style={{ aspectRatio: String(Math.min(Math.max(ratio, 0.5), 2.5)) }}
      className="group/img relative w-full overflow-hidden rounded-xl bg-slate-200 dark:bg-slate-700"
    >
      {failed ? (
        <span className="grid h-full w-full place-items-center text-slate-500">
          <ImageOff size={20} />
        </span>
      ) : url ? (
        <img
          src={url}
          alt={a.name}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-200 group-hover/img:scale-[1.02]"
        />
      ) : (
        <span className="grid h-full w-full place-items-center"><Spinner className="h-4 w-4" /></span>
      )}
    </button>
  );
};

export const MessageAttachments: React.FC<{
  attachments: Attachment[];
  onDark: boolean;
}> = ({ attachments, onDark }) => {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const media = attachments.filter((a) => a.kind === 'image' || a.kind === 'video');
  const voice = attachments.filter((a) => a.kind === 'audio');
  const documents = attachments.filter((a) => a.kind === 'document' || a.kind === 'other');

  const openAt = useCallback((fileId: string) => {
    setLightboxIndex(media.findIndex((m) => m.fileId === fileId));
  }, [media]);

  return (
    <>
      {/* One image goes large; several tile. Beyond four the grid stops being a
          preview and becomes a wall, so the rest are counted. */}
      {media.length > 0 && (
        <div
          className={`mt-1.5 grid gap-1 ${
            media.length === 1 ? 'max-w-sm grid-cols-1' : 'max-w-md grid-cols-2'
          }`}
        >
          {media.slice(0, 4).map((a, i) => (
            <div key={a.fileId} className="relative">
              <ImageTile attachment={a} onOpen={() => openAt(a.fileId)} />
              {a.kind === 'video' && (
                <span className="pointer-events-none absolute inset-0 grid place-items-center">
                  <span className="grid h-10 w-10 place-items-center rounded-full bg-black/55 text-white">
                    <Play size={18} className="translate-x-px" />
                  </span>
                </span>
              )}
              {i === 3 && media.length > 4 && (
                <span className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl bg-black/60 text-lg font-semibold text-white">
                  +{media.length - 4}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {voice.map((a) => (
        <div key={a.fileId} className="mt-1.5 min-w-[14rem]">
          <VoiceNote attachment={a} onDark={onDark} />
        </div>
      ))}

      {documents.map((a) => (
        <div
          key={a.fileId}
          className={`mt-2 flex items-center gap-2.5 rounded-xl px-2.5 py-2 ${
            onDark ? 'bg-white/15' : 'bg-surface-light dark:bg-card-dark/50'
          }`}
        >
          <FileText size={18} className="shrink-0 opacity-80" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{a.name}</span>
            <span className="block text-[11px] opacity-70">{formatBytes(a.size)}</span>
          </span>
          <button
            onClick={() => void downloadFile(a.fileId, a.name)}
            aria-label={`Download ${a.name}`}
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
              onDark ? 'hover:bg-white/20' : 'hover:bg-black/5 dark:hover:bg-white/10'
            }`}
          >
            <Download size={14} />
          </button>
        </div>
      ))}

      {lightboxIndex !== null && lightboxIndex >= 0 && (
        <Lightbox
          items={media}
          index={lightboxIndex}
          onIndex={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
};
