import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Monitor, MonitorUp, Square, Volume2 } from 'lucide-react';

/**
 * The presenting affordances, split in two because they answer two different
 * questions.
 *
 * `PresentPicker` answers "what do I want to share?" *before* the browser's own
 * picker opens — a whole screen, one window, or a tab, and whether to bring the
 * audio. Chromium honours `displaySurface` as a preselection, so choosing here
 * means one fewer decision inside a dialog the page cannot style.
 *
 * `PresentingBar` answers "am I still sharing?", which is the question people
 * actually get wrong. The browser's own indicator is easy to lose behind a
 * window, and presenting the wrong thing to a class is the failure mode worth
 * designing against — so this sits over the stage the whole time it runs.
 */

export interface PresentPickerProps {
  onStart: (opts: { preferSurface?: 'monitor' | 'window' | 'browser'; withAudio?: boolean }) => void;
  onClose: () => void;
}

const SURFACES = [
  {
    key: 'monitor' as const,
    icon: Monitor,
    label: 'Your entire screen',
    hint: 'Everything you can see, including other windows.',
  },
  {
    key: 'window' as const,
    icon: Square,
    label: 'A window',
    hint: 'One application only — nothing else is visible.',
  },
  {
    key: 'browser' as const,
    icon: MonitorUp,
    label: 'A browser tab',
    hint: 'Sharpest for slides, and the only option that can carry tab audio.',
  },
];

export const PresentPicker: React.FC<PresentPickerProps> = ({ onStart, onClose }) => {
  const [withAudio, setWithAudio] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Choose what to present"
      className="animate-pop absolute bottom-full left-1/2 z-50 mb-3 w-72 -translate-x-1/2 rounded-2xl border border-white/10 bg-slate-900/95 p-2 backdrop-blur-md"
    >
      <h3 className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/40">Present</h3>

      {SURFACES.map(({ key, icon: Icon, label, hint }) => (
        <button
          key={key}
          onClick={() => {
            onStart({ preferSurface: key, withAudio });
            onClose();
          }}
          className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors duration-150 hover:bg-white/10"
        >
          <Icon size={16} className="mt-0.5 shrink-0 text-blue-300" />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-white">{label}</span>
            <span className="block text-[11px] leading-relaxed text-white/40">{hint}</span>
          </span>
        </button>
      ))}

      <div className="my-1 h-px bg-white/10" />

      <label className="flex cursor-pointer items-start gap-2.5 rounded-xl px-2.5 py-2 hover:bg-white/5">
        <input
          type="checkbox"
          checked={withAudio}
          onChange={(e) => setWithAudio(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-sm text-white">
            <Volume2 size={13} /> Share audio too
          </span>
          <span className="block text-[11px] leading-relaxed text-white/40">
            For a video or a slide with sound. Best with a browser tab.
          </span>
        </span>
      </label>
    </div>
  );
};

/**
 * "You are presenting" — shown for as long as it is true.
 *
 * Deliberately not dismissible. The whole point is that someone who has
 * forgotten they are sharing finds out before they open their email.
 */
export const PresentingBar: React.FC<{
  /** What this client is sharing, so the presenter can see their own output. */
  screenStream: MediaStream | null;
  onStop: () => void;
}> = ({ screenStream, onStop }) => {
  const [preview, setPreview] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = preview ? screenStream : null;
    if (preview) void el.play().catch(() => {});
  }, [preview, screenStream]);

  return (
    <div className="absolute left-1/2 top-3 z-30 -translate-x-1/2">
      <div className="flex items-center gap-2 rounded-full border border-blue-500/40 bg-blue-600/25 px-3 py-1.5 backdrop-blur-sm">
        <span className="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
        <span className="text-xs font-medium text-blue-100">You are presenting</span>

        <button
          onClick={() => setPreview((p) => !p)}
          className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] text-blue-200/80 transition-colors duration-150 hover:bg-white/10 hover:text-white"
        >
          {preview ? 'Hide' : 'See what they see'}
          <ChevronDown size={11} className={preview ? 'rotate-180' : ''} />
        </button>

        <button
          onClick={onStop}
          className="rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-medium text-white transition-colors duration-150 hover:bg-red-600"
        >
          Stop
        </button>
      </div>

      {/* A small self-view. Sharing a screen that shows the meeting creates an
 infinite tunnel, so it is opt-in and small rather than always on. */}
      {preview && (
        <div className="mt-2 overflow-hidden rounded-xl border border-white/15 bg-slate-950">
          <video ref={videoRef} autoPlay playsInline muted className="h-36 w-64 object-contain" />
        </div>
      )}
    </div>
  );
};

/** What everyone else sees while somebody is presenting. */
export const PresenterBadge: React.FC<{ name: string }> = ({ name }) => (
  <div className="absolute left-1/2 top-3 z-30 -translate-x-1/2">
    <span className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm">
      <MonitorUp size={12} className="text-blue-400" />
      {name} is presenting
    </span>
  </div>
);
