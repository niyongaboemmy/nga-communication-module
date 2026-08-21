import { useCallback, useEffect, useRef, useState } from 'react';
import type { MeetParticipant } from '@tupo/shared';
import * as meetApi from './api';
import type { RemoteMedia } from './transport/types';

/**
 * Client-side meeting recording — the only kind there is.
 *
 * Cloudflare Realtime is an SFU: it routes tracks between participants and
 * offers no server-side compositing, so nothing on the server ever holds a
 * picture of the meeting to record. The only place a composite can be made is
 * a browser that is in the call, which means the host's. So that is what this
 * does, honestly and with its limits stated in the UI:
 *
 *  - the stage is drawn onto a canvas each frame, laid out the same way the
 *    grid lays it out;
 *  - every participant's audio, plus the host's own microphone, is mixed
 *    through one `AudioContext` into a single track;
 *  - the two are combined and handed to `MediaRecorder`;
 *  - the result is uploaded to the file service under `meetings/<id>/`.
 *
 * It records what the host could see and hear, and it stops if the host leaves.
 * Both are true of every browser-side recorder; neither is hidden from the user.
 */

const FPS = 24;
const WIDTH = 1280;
const HEIGHT = 720;
/** Chunked so a crash costs the tail, not the recording. */
const CHUNK_MS = 4000;
const VIDEO_BPS = 2_000_000;
const AUDIO_BPS = 128_000;

export type RecorderState = 'idle' | 'recording' | 'uploading' | 'error';

export interface UseMeetRecorder {
  state: RecorderState;
  /** Seconds elapsed, for the indicator. */
  elapsed: number;
  error: string | null;
  supported: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/** Chosen once: the best container this browser will actually produce. */
function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    // VP9 first: markedly better quality per byte, and a recording is written
    // once and watched many times, so encode cost is the right thing to spend.
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    // Safari produces fragmented MP4 rather than WebM.
    'video/mp4',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

interface Params {
  meetingId: string;
  participants: MeetParticipant[];
  media: Map<string, RemoteMedia>;
  localStream: MediaStream | null;
  you: MeetParticipant | null;
  presenterId: string | null;
  onStateChange?: (recording: boolean) => void;
}

export function useMeetRecorder({
  meetingId, participants, media, localStream, you, presenterId, onStateChange,
}: Params): UseMeetRecorder {
  const [state, setState] = useState<RecorderState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Video elements used purely as a decode surface for the canvas. */
  const paintersRef = useRef(new Map<string, HTMLVideoElement>()).current;

  // Read inside the animation frame, which must not be re-created per render.
  const sceneRef = useRef({ participants, media, localStream, you, presenterId });
  sceneRef.current = { participants, media, localStream, you, presenterId };

  const supported = pickMimeType() !== null &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function';

  /* ---------------- drawing ---------------- */

  /**
   * One video element per stream, reused across frames.
   *
   * `drawImage` needs a decoding surface, and creating one per frame would
   * decode the whole meeting twenty-four times a second.
   */
  const painterFor = useCallback((key: string, stream: MediaStream | null): HTMLVideoElement | null => {
    if (!stream) {
      paintersRef.get(key)?.remove();
      paintersRef.delete(key);
      return null;
    }
    let el = paintersRef.get(key);
    if (!el) {
      el = document.createElement('video');
      el.muted = true;
      el.autoplay = true;
      el.playsInline = true;
      paintersRef.set(key, el);
    }
    if (el.srcObject !== stream) {
      el.srcObject = stream;
      void el.play().catch(() => {});
    }
    return el;
  }, [paintersRef]);

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const scene = sceneRef.current;
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    /** Cover-fit, so a tile is filled rather than letterboxed — except a
     *  shared screen, which is contained: cropping a slide loses the point. */
    const paint = (
      el: HTMLVideoElement, x: number, y: number, w: number, h: number, contain: boolean,
    ) => {
      if (!el.videoWidth || !el.videoHeight) return false;
      const scale = contain
        ? Math.min(w / el.videoWidth, h / el.videoHeight)
        : Math.max(w / el.videoWidth, h / el.videoHeight);
      const dw = el.videoWidth * scale;
      const dh = el.videoHeight * scale;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
      ctx.restore();
      return true;
    };

    const label = (text: string, x: number, y: number, w: number) => {
      ctx.save();
      const grad = ctx.createLinearGradient(0, y - 34, 0, y);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.72)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y - 34, w, 34);
      ctx.fillStyle = '#fff';
      ctx.font = '500 15px Inter, system-ui, sans-serif';
      ctx.textBaseline = 'bottom';
      ctx.fillText(text.slice(0, 40), x + 12, y - 10);
      ctx.restore();
    };

    const streamFor = (p: MeetParticipant): MediaStream | null => {
      if (p.id === scene.presenterId) {
        return scene.media.get(p.id)?.screenStream ?? scene.media.get(p.id)?.stream ?? null;
      }
      if (p.id === scene.you?.id) return scene.localStream;
      return scene.media.get(p.id)?.stream ?? null;
    };

    const avatar = (p: MeetParticipant, x: number, y: number, w: number, h: number) => {
      ctx.save();
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#475569';
      const r = Math.min(w, h) * 0.16;
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e2e8f0';
      ctx.font = `600 ${Math.round(r)}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.name.slice(0, 2).toUpperCase(), x + w / 2, y + h / 2);
      ctx.restore();
    };

    const people = scene.participants;
    const presenter = people.find((p) => p.id === scene.presenterId);

    if (presenter) {
      // Presentation layout: the share fills the frame, faces run along the
      // bottom — the same shape the live stage uses, so the recording looks
      // like the meeting people remember.
      const stripH = 132;
      const stageH = HEIGHT - stripH - 8;
      const el = painterFor(presenter.id, streamFor(presenter));
      if (!el || !paint(el, 0, 0, WIDTH, stageH, true)) avatar(presenter, 0, 0, WIDTH, stageH);
      label(`${presenter.name} — presenting`, 0, stageH, WIDTH);

      const others = people.filter((p) => p.id !== presenter.id).slice(0, 6);
      const tileW = others.length ? Math.min(220, WIDTH / others.length - 8) : 0;
      others.forEach((p, i) => {
        const x = 8 + i * (tileW + 8);
        const y = stageH + 8;
        const painter = painterFor(p.id, streamFor(p));
        if (!painter || !p.videoEnabled || !paint(painter, x, y, tileW, stripH - 8, false)) {
          avatar(p, x, y, tileW, stripH - 8);
        }
        label(p.name, x, y + stripH - 8, tileW);
      });
      return;
    }

    // Grid. Square-ish arrangement, matching the live layout's column counts.
    const count = Math.max(1, Math.min(people.length, 12));
    const cols = count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
    const rows = Math.ceil(count / cols);
    const gap = 8;
    const tileW = (WIDTH - gap * (cols + 1)) / cols;
    const tileH = (HEIGHT - gap * (rows + 1)) / rows;

    people.slice(0, count).forEach((p, i) => {
      const x = gap + (i % cols) * (tileW + gap);
      const y = gap + Math.floor(i / cols) * (tileH + gap);
      const el = painterFor(p.id, streamFor(p));
      if (!el || !p.videoEnabled || !paint(el, x, y, tileW, tileH, false)) {
        avatar(p, x, y, tileW, tileH);
      }
      label(p.name + (p.id === scene.you?.id ? ' (you)' : ''), x, y + tileH, tileW);
    });
  }, [painterFor]);

  /* ---------------- lifecycle ---------------- */

  const cleanup = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    for (const el of paintersRef.values()) { el.srcObject = null; el.remove(); }
    paintersRef.clear();
    canvasRef.current = null;
    recorderRef.current = null;
  }, [paintersRef]);

  const start = useCallback(async () => {
    if (state !== 'idle') return;
    setError(null);

    const mimeType = pickMimeType();
    if (!mimeType) {
      setError('This browser cannot record video.');
      setState('error');
      return;
    }

    let recordingId: string;
    try {
      const started = await meetApi.startRecording(meetingId, 'client');
      recordingId = started.recordingId;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start recording.');
      setState('error');
      return;
    }
    recordingIdRef.current = recordingId;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      canvasRef.current = canvas;

      const tick = () => { drawFrame(); rafRef.current = requestAnimationFrame(tick); };
      rafRef.current = requestAnimationFrame(tick);

      // Mix every audio source into one track. Each stream gets its own source
      // node; the destination is what MediaRecorder receives.
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const destination = audioCtx.createMediaStreamDestination();
      const connect = (stream: MediaStream | null) => {
        if (!stream?.getAudioTracks().length) return;
        try { audioCtx.createMediaStreamSource(stream).connect(destination); } catch { /* already connected */ }
      };
      connect(localStream);
      for (const remote of media.values()) connect(remote.audioStream);

      const canvasStream = canvas.captureStream(FPS);
      const mixed = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...destination.stream.getAudioTracks(),
      ]);

      const recorder = new MediaRecorder(mixed, {
        mimeType,
        videoBitsPerSecond: VIDEO_BPS,
        audioBitsPerSecond: AUDIO_BPS,
      });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onerror = () => {
        setError('Recording stopped unexpectedly.');
        setState('error');
      };
      recorder.start(CHUNK_MS);
      recorderRef.current = recorder;

      startedAtRef.current = Date.now();
      setElapsed(0);
      timerRef.current = setInterval(
        () => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000);

      setState('recording');
      onStateChange?.(true);
    } catch (err) {
      cleanup();
      // The server row exists; mark it failed so it does not sit as "recording"
      // for ever.
      await meetApi.failRecording(meetingId, recordingId).catch(() => {});
      setError(err instanceof Error ? err.message : 'Could not start recording.');
      setState('error');
    }
  }, [state, meetingId, localStream, media, drawFrame, cleanup, onStateChange]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    const recordingId = recordingIdRef.current;
    if (!recorder || !recordingId) return;

    setState('uploading');
    onStateChange?.(false);

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunksRef.current, { type: recorder.mimeType }));
      recorder.stop();
    });

    const durationSeconds = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
    cleanup();

    try {
      await meetApi.stopRecording(meetingId);
      const extension = recorder.mimeType.includes('mp4') ? 'mp4' : 'webm';
      await meetApi.uploadRecording({
        meetingId,
        recordingId,
        blob,
        filename: `recording-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${extension}`,
        durationSeconds,
      });
      setState('idle');
      setElapsed(0);
    } catch (err) {
      await meetApi.failRecording(meetingId, recordingId).catch(() => {});
      setError(err instanceof Error ? err.message : 'The recording could not be saved.');
      setState('error');
    }
  }, [meetingId, cleanup, onStateChange]);

  // Never leave the camera and audio graph running because a component went away.
  useEffect(() => () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    cleanup();
  }, [cleanup]);

  return { state, elapsed, error, supported, start, stop };
}
