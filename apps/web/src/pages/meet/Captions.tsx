import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Languages, Loader2 } from 'lucide-react';
import type { MeetTranscriptSegment } from '@tupo/shared';
import * as meetApi from './api';

/**
 * The live caption bar.
 *
 * Overlaid on the stage rather than given a panel, because captions are read
 * *while looking at the speaker* — a side panel makes people choose between
 * reading and watching. Only the last few lines are shown; the full transcript
 * lives in the summary page.
 *
 * Translation is opt-in per viewer and per language, so a Kinyarwanda speaker
 * in an English meeting reads along without imposing a translation cost on
 * anyone else.
 */

const VISIBLE_LINES = 3;

/** A short list beats a long one here — this is a control bar, not a settings page. */
const LANGUAGES = [
  { code: '', label: 'Original' },
  { code: 'English', label: 'English' },
  { code: 'Kinyarwanda', label: 'Kinyarwanda' },
  { code: 'French', label: 'Français' },
  { code: 'Swahili', label: 'Kiswahili' },
];

export interface CaptionsOverlayProps {
  meetingId: string;
  segments: MeetTranscriptSegment[];
  aiAvailable: boolean;
}

export const CaptionsOverlay: React.FC<CaptionsOverlayProps> = ({
  meetingId, segments, aiAvailable,
}) => {
  const [targetLang, setTargetLang] = useState('');
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const requestedRef = useRef(new Set<string>());

  const recent = useMemo(() => segments.slice(-VISIBLE_LINES), [segments]);

  /**
   * Translate only *final* segments, and only once each.
   *
   * Interim segments change on every syllable; translating them would mean a
   * model call per syllable and a caption bar that rewrites itself faster than
   * anyone can read it.
   */
  useEffect(() => {
    if (!targetLang || !aiAvailable) return;

    for (const segment of recent) {
      if (!segment.isFinal) continue;
      const key = `${segment.id}:${targetLang}`;
      if (requestedRef.current.has(key)) continue;
      requestedRef.current.add(key);

      setPending((s) => new Set(s).add(key));
      void meetApi.aiTranslate(meetingId, segment.text, targetLang)
        .then((r) => setTranslations((t) => ({ ...t, [key]: r.text })))
        .catch(() => {
          // Fall back to the original line rather than showing a gap — a
          // missing caption is worse than an untranslated one.
        })
        .finally(() => setPending((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        }));
    }
  }, [recent, targetLang, aiAvailable, meetingId]);

  if (segments.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-1.5 px-4 pb-3">
      {aiAvailable && (
        <div className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-1 backdrop-blur-sm">
          <Languages size={12} className="text-white/50" />
          <select
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
            aria-label="Caption language"
            className="bg-transparent text-[11px] text-white/70 focus:outline-none [&>option]:bg-slate-800"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </div>
      )}

      <div className="pointer-events-none w-full max-w-3xl space-y-1">
        {recent.map((segment) => {
          const key = `${segment.id}:${targetLang}`;
          const translated = targetLang ? translations[key] : undefined;
          const waiting = targetLang && segment.isFinal && pending.has(key) && !translated;
          return (
            <p
              key={`${segment.id}-${segment.startedAt}`}
              className={
                'rounded-xl bg-black/75 px-3 py-1.5 text-center text-sm leading-relaxed backdrop-blur-sm ' +
                (segment.isFinal ? 'text-white' : 'text-white/60 italic')
              }
            >
              <span className="mr-1.5 font-semibold text-blue-300">{segment.speakerName}:</span>
              {translated ?? segment.text}
              {waiting && <Loader2 size={11} className="ml-1.5 inline animate-spin text-white/40" />}
            </p>
          );
        })}
      </div>
    </div>
  );
};
