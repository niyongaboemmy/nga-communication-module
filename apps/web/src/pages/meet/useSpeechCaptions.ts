import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Live captions from the browser's own speech recogniser.
 *
 * This is the whole speech-to-text pipeline, and the design decision worth
 * defending: every participant transcribes **their own microphone** locally and
 * ships plain text over the socket.
 *
 * What that buys:
 *
 *  - **Speaker attribution for free.** The hard part of a meeting notetaker is
 *    diarization — deciding who said what. Here the question never arises: a
 *    segment arrives on the socket of the person whose microphone produced it.
 *  - **No speech-to-text bill and no GPU.** A hosted streaming STT service
 *    would be the largest running cost in this module.
 *  - **Bandwidth.** A caption is roughly eighty bytes. Shipping audio to a
 *    server to transcribe it would be a second upstream of the whole call.
 *
 * What it costs: `SpeechRecognition` is Chromium-only in practice. The hook
 * feature-detects, and the AI panel says plainly which participants are
 * contributing transcript rather than pretending the record is complete. A
 * server-side Whisper path for other browsers is a documented seam, not a
 * secret gap.
 */

interface SpeechRecognitionAlternativeLike { transcript: string; confidence: number }
interface SpeechRecognitionResultLike {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { readonly length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getConstructor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const speechRecognitionSupported = (): boolean => getConstructor() !== null;

export interface CaptionEmit {
  text: string;
  lang: string;
  isFinal: boolean;
  confidence?: number;
}

export interface UseSpeechCaptions {
  supported: boolean;
  listening: boolean;
  error: string | null;
  start: () => void;
  stop: () => void;
}

export function useSpeechCaptions(params: {
  enabled: boolean;
  lang: string;
  /** Only transcribe while the microphone is actually live. */
  micEnabled: boolean;
  onSegment: (segment: CaptionEmit) => void;
}): UseSpeechCaptions {
  const { enabled, lang, micEnabled, onSegment } = params;

  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const wantRunningRef = useRef(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Kept in a ref so restarting the recogniser does not need the callback in
  // the effect's dependency list, which would tear it down on every render.
  const onSegmentRef = useRef(onSegment);
  onSegmentRef.current = onSegment;
  const langRef = useRef(lang);
  langRef.current = lang;

  const supported = getConstructor() !== null;

  const stop = useCallback(() => {
    wantRunningRef.current = false;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
    try { recognitionRef.current?.stop(); } catch { /* already stopped */ }
    recognitionRef.current = null;
    setListening(false);
  }, []);

  const start = useCallback(() => {
    const Ctor = getConstructor();
    if (!Ctor || recognitionRef.current) return;

    const recognition = new Ctor();
    recognition.lang = langRef.current;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      // Only the results added since the last event — re-emitting the whole
      // buffer would replay the entire meeting on every syllable.
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const alternative = result[0];
        if (!alternative) continue;
        const text = alternative.transcript.trim();
        if (!text) continue;
        onSegmentRef.current({
          text,
          lang: langRef.current,
          isFinal: result.isFinal,
          confidence: alternative.confidence,
        });
      }
    };

    recognition.onerror = (e) => {
      // 'no-speech' and 'aborted' are ordinary in a meeting where someone is
      // listening rather than talking; only real failures reach the user.
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setError('Captions need microphone permission.');
        wantRunningRef.current = false;
        return;
      }
      setError(`Captions stopped: ${e.error}`);
    };

    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
      // Chromium ends the session after a stretch of silence whatever
      // `continuous` says, so a caption stream that must last an hour has to
      // restart itself. The delay keeps a hard failure from becoming a spin.
      if (wantRunningRef.current) {
        restartTimerRef.current = setTimeout(() => {
          if (wantRunningRef.current) start();
        }, 400);
      }
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      wantRunningRef.current = true;
      setListening(true);
      setError(null);
    } catch {
      // start() throws if one is already running; the existing one is fine.
      recognitionRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (enabled && micEnabled && supported) start();
    else stop();
    return stop;
  }, [enabled, micEnabled, supported, start, stop]);

  // A language change needs a fresh recogniser — `lang` is read at start().
  useEffect(() => {
    if (!listening) return;
    stop();
    const t = setTimeout(() => { if (enabled && micEnabled) start(); }, 100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  return { supported, listening, error, start, stop };
}
