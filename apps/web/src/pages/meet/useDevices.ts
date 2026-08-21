import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Camera, microphone and speaker selection, plus the live level meter the
 * pre-join screen needs (FR-MEET-4).
 *
 * Two browser facts shape this hook:
 *
 *  1. `enumerateDevices()` returns entries with **empty labels** until the page
 *     holds a media permission. So permission is requested first and the list
 *     is read afterwards — otherwise the picker shows "Device 1, Device 2".
 *  2. Devices appear and disappear while the page is open (a headset is
 *     plugged in mid-call), so `devicechange` has to be watched.
 */

export interface DeviceOption { deviceId: string; label: string }

export interface DeviceState {
  cameras: DeviceOption[];
  microphones: DeviceOption[];
  speakers: DeviceOption[];
  cameraId: string;
  microphoneId: string;
  speakerId: string;
  stream: MediaStream | null;
  /** 0–1, smoothed. Drives the level meter. */
  level: number;
  error: string | null;
  permissionDenied: boolean;
  ready: boolean;
}

export interface UseDevices extends DeviceState {
  setCameraId: (id: string) => void;
  setMicrophoneId: (id: string) => void;
  setSpeakerId: (id: string) => void;
  /** Open (or reopen) the preview stream with the current selection. */
  open: (opts?: { video?: boolean; audio?: boolean }) => Promise<MediaStream | null>;
  stop: () => void;
  /** Hand the stream to the call and stop managing it here. */
  detach: () => MediaStream | null;
}

const label = (d: MediaDeviceInfo, fallback: string, index: number) =>
  d.label || `${fallback} ${index + 1}`;

export function useDevices(): UseDevices {
  const [state, setState] = useState<DeviceState>({
    cameras: [], microphones: [], speakers: [],
    cameraId: '', microphoneId: '', speakerId: '',
    stream: null, level: 0, error: null, permissionDenied: false, ready: false,
  });

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const detachedRef = useRef(false);

  const enumerate = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setState((s) => ({
        ...s,
        cameras: devices.filter((d) => d.kind === 'videoinput')
          .map((d, i) => ({ deviceId: d.deviceId, label: label(d, 'Camera', i) })),
        microphones: devices.filter((d) => d.kind === 'audioinput')
          .map((d, i) => ({ deviceId: d.deviceId, label: label(d, 'Microphone', i) })),
        speakers: devices.filter((d) => d.kind === 'audiooutput')
          .map((d, i) => ({ deviceId: d.deviceId, label: label(d, 'Speaker', i) })),
      }));
    } catch {
      // Enumeration failing is not fatal — the browser default device works.
    }
  }, []);

  /** Tear down the meter without touching the stream (which may be in use). */
  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  const startMeter = useCallback((stream: MediaStream) => {
    stopMeter();
    if (!stream.getAudioTracks().length) return;
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);

      let smoothed = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(buffer);
        // RMS around the 128 midpoint, which is what a byte-domain waveform
        // centres on. Peak would flicker on every consonant.
        let sum = 0;
        for (const v of buffer) {
          const centred = (v - 128) / 128;
          sum += centred * centred;
        }
        const rms = Math.sqrt(sum / buffer.length);
        // Attack fast, release slow — a meter that decays instantly reads as
        // broken, and one that decays slowly reads as latency.
        smoothed = rms > smoothed ? rms : smoothed * 0.85 + rms * 0.15;
        setState((s) => ({ ...s, level: Math.min(1, smoothed * 3) }));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // No AudioContext (or blocked before a gesture): the meter is a nicety.
    }
  }, [stopMeter]);

  const stop = useCallback(() => {
    stopMeter();
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    setState((s) => ({ ...s, stream: null, level: 0 }));
  }, [stopMeter]);

  const open = useCallback(async (opts?: { video?: boolean; audio?: boolean }) => {
    const wantVideo = opts?.video !== false;
    const wantAudio = opts?.audio !== false;

    // Stop the previous stream first. Chromium will not open the same camera
    // twice, so leaving the old one running makes switching silently fail.
    stopMeter();
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: wantVideo
          ? {
              ...(state.cameraId ? { deviceId: { exact: state.cameraId } } : {}),
              width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 },
            }
          : false,
        audio: wantAudio
          ? {
              ...(state.microphoneId ? { deviceId: { exact: state.microphoneId } } : {}),
              // Browser-native AEC/AGC/NS (SRS §10.3). Cheaper and better than
              // anything we could add in WASM, and available everywhere.
              echoCancellation: true, noiseSuppression: true, autoGainControl: true,
            }
          : false,
      });

      streamRef.current = stream;
      detachedRef.current = false;
      setState((s) => ({ ...s, stream, error: null, permissionDenied: false, ready: true }));
      startMeter(stream);
      // Labels are only populated once permission is held, so enumerate again.
      await enumerate();
      return stream;
    } catch (err) {
      const denied = err instanceof DOMException &&
        (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
      setState((s) => ({
        ...s,
        stream: null,
        ready: true,
        permissionDenied: denied,
        error: denied
          ? 'Tupo needs permission to use your camera and microphone. Allow it in your browser, then try again.'
          : err instanceof Error ? err.message : 'Could not open your camera or microphone.',
      }));
      return null;
    }
  }, [state.cameraId, state.microphoneId, enumerate, startMeter, stopMeter]);

  /** Hand the stream over to the call; this hook stops owning its lifetime. */
  const detach = useCallback(() => {
    stopMeter();
    detachedRef.current = true;
    const stream = streamRef.current;
    streamRef.current = null;
    setState((s) => ({ ...s, stream: null, level: 0 }));
    return stream;
  }, [stopMeter]);

  useEffect(() => {
    void enumerate();
    navigator.mediaDevices?.addEventListener?.('devicechange', enumerate);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', enumerate);
  }, [enumerate]);

  // Unmount must not stop a stream that was handed to the call.
  useEffect(() => () => {
    stopMeter();
    if (!detachedRef.current) {
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    }
  }, [stopMeter]);

  return {
    ...state,
    setCameraId: (id) => setState((s) => ({ ...s, cameraId: id })),
    setMicrophoneId: (id) => setState((s) => ({ ...s, microphoneId: id })),
    setSpeakerId: (id) => setState((s) => ({ ...s, speakerId: id })),
    open, stop, detach,
  };
}

/**
 * Route audio to a chosen speaker.
 *
 * `setSinkId` is Chromium-only; elsewhere output follows the system default and
 * there is nothing the page can do about it, so a failure here is ignored
 * rather than surfaced.
 */
export async function applySpeaker(el: HTMLMediaElement | null, deviceId: string): Promise<void> {
  if (!el || !deviceId) return;
  const withSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof withSink.setSinkId !== 'function') return;
  try { await withSink.setSinkId(deviceId); } catch { /* unsupported or revoked */ }
}
