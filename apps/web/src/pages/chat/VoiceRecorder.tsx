import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Square, Trash2, Send } from 'lucide-react';
import { IconButton } from '../../components/ui';
import { pickVoiceFormat, voiceExtension } from '../../lib/voiceFormat';

/**
 * Recording a voice note (FR-MSG-20).
 *
 * On a phone this is the fastest way to say something, and in a school it is
 * often the only practical one — a teacher walking between classrooms is not
 * going to type three paragraphs.
 *
 * Two things this has to get right:
 *
 * **The waveform is computed while recording**, from the same analyser that
 * draws the live meter. Decoding the finished blob to compute peaks would mean
 * doing the work twice, and every listener would otherwise have to decode the
 * whole file just to draw eighty bars.
 *
 * **The microphone is released the moment recording stops.** A tab holding an
 * open mic shows a recording indicator in the browser chrome, and leaving that
 * on after the user pressed stop is alarming and rightly so.
 */

/** Bars kept for the waveform. Enough shape to be recognisable, small on the wire. */
const WAVEFORM_BUCKETS = 48;

/** A hard ceiling, so a forgotten recording cannot become a 40-minute upload. */
const MAX_DURATION_MS = 5 * 60 * 1000;

export interface RecordedVoiceNote {
  file: File;
  durationMs: number;
  waveform: number[];
}

export const VoiceRecorder: React.FC<{
  onCancel: () => void;
  onDone: (note: RecordedVoiceNote) => void;
}> = ({ onCancel, onDone }) => {
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const peaksRef = useRef<number[]>([]);
  const rafRef = useRef<number | null>(null);
  const startedAt = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const cancelledRef = useRef(false);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    // Stopping every track is what actually turns the microphone light off.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  useEffect(() => {
    let disposed = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        if (disposed) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;

        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buffer = new Uint8Array(analyser.frequencyBinCount);

        // WebM where supported, MP4/AAC on older Safari / the macOS desktop app.
        const mimeType = pickVoiceFormat((m) => MediaRecorder.isTypeSupported(m));
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recorderRef.current = recorder;
        recorder.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
        recorder.start(250);
        startedAt.current = Date.now();

        const tick = () => {
          analyser.getByteTimeDomainData(buffer);
          // RMS around the 128 midpoint — a fair approximation of loudness, and
          // cheap enough to run every frame.
          let sum = 0;
          for (const v of buffer) { const d = (v - 128) / 128; sum += d * d; }
          const rms = Math.min(Math.sqrt(sum / buffer.length) * 2.2, 1);
          setLevel(rms);
          peaksRef.current.push(rms);

          const ms = Date.now() - startedAt.current;
          setElapsed(ms);
          if (ms >= MAX_DURATION_MS) { stop(); return; }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        setError('Tupo could not use your microphone. Check the browser permission.');
      }
    })();

    return () => { disposed = true; teardown(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Squash the per-frame peaks down to a fixed number of bars. */
  const buildWaveform = (): number[] => {
    const peaks = peaksRef.current;
    if (!peaks.length) return [];
    const size = Math.ceil(peaks.length / WAVEFORM_BUCKETS);
    const out: number[] = [];
    for (let i = 0; i < peaks.length; i += size) {
      const slice = peaks.slice(i, i + size);
      out.push(Math.max(...slice));
    }
    return out.slice(0, WAVEFORM_BUCKETS);
  };

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;

    const durationMs = Date.now() - startedAt.current;
    const waveform = buildWaveform();

    recorder.onstop = () => {
      teardown();
      if (cancelledRef.current) return;
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
      if (blob.size === 0) { onCancel(); return; }
      const file = new File([blob], `voice-message-${Date.now()}.${voiceExtension(recorder.mimeType)}`, {
        type: recorder.mimeType,
      });
      onDone({ file, durationMs, waveform });
    };
    recorder.stop();
  }, [onCancel, onDone, teardown]);

  const cancel = () => {
    cancelledRef.current = true;
    recorderRef.current?.stop();
    teardown();
    onCancel();
  };

  const seconds = Math.floor(elapsed / 1000);
  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
        <span className="flex-1">{error}</span>
        <button onClick={onCancel} className="font-medium underline">Close</button>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label="Recording a voice message"
      className="flex items-center gap-2 rounded-2xl border border-red-300 bg-red-50/70 px-2 py-1.5 dark:border-red-500/40 dark:bg-red-500/10"
    >
      <IconButton label="Discard recording" onClick={cancel}>
        <Trash2 size={17} className="text-red-600 dark:text-red-400" />
      </IconButton>

      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" aria-hidden="true" />
        <span
          className="text-xs font-semibold tabular-nums text-red-700 dark:text-red-300"
          aria-live="off"
        >
          {mmss}
        </span>
      </span>

      {/* A live meter, not a fake animation: it moves with the voice, which is
          how someone knows the microphone is actually picking them up. */}
      <div className="flex h-7 flex-1 items-center gap-[2px] overflow-hidden">
        {Array.from({ length: 32 }, (_, i) => {
          const recent = peaksRef.current.slice(-32)[i] ?? 0;
          const height = Math.max((i === 31 ? level : recent) * 100, 8);
          return (
            <span
              key={i}
              style={{ height: `${height}%` }}
              className="w-full rounded-full bg-red-400/70 dark:bg-red-400/60"
            />
          );
        })}
      </div>

      <span className="sr-only" aria-live="polite">Recording</span>

      <button
        onClick={stop}
        aria-label="Stop and send voice message"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-blue-600 text-white transition-colors duration-150 hover:bg-blue-700"
      >
        <Send size={16} />
      </button>
    </div>
  );
};

/** Whether this browser can record at all — the button is hidden if not. */
export const canRecordVoice = () =>
  typeof navigator !== 'undefined'
  && Boolean(navigator.mediaDevices?.getUserMedia)
  && typeof MediaRecorder !== 'undefined';
