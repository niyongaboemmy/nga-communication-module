/**
 * Notification sounds, synthesised rather than shipped.
 *
 * Every cue here is a short envelope over one or two sine tones built with the
 * Web Audio API. That is a deliberate choice over audio files:
 *
 *  - nothing to download, so a cue never arrives late or fails on a slow link;
 *  - nothing to cache-bust, and no licensing to track;
 *  - the whole set is a few hundred bytes of code rather than a folder of MP3s.
 *
 * The vocabulary matters more than the fidelity. Rising intervals mean
 * something arrived or was granted; falling means something left or was
 * refused; a single soft tone is an acknowledgement. Someone should be able to
 * tell what happened without looking at the screen — which is the entire point
 * of a sound in a meeting, where the screen is busy with faces.
 */

export type SoundName =
  | 'join' | 'leave' | 'knock' | 'admitted' | 'denied'
  | 'message' | 'mention' | 'hand' | 'reaction'
  | 'poll' | 'recording-start' | 'recording-stop'
  | 'success' | 'error' | 'ended';

interface Note { freq: number; at: number; dur: number; gain?: number; type?: OscillatorType }

/**
 * Each cue as a tiny score. Frequencies are notes of the C-major scale so two
 * cues landing at once are still consonant — which happens constantly when a
 * meeting starts and four people arrive at the same moment.
 */
const SCORES: Record<SoundName, Note[]> = {
  // Arrival: rising fifth.
  join: [{ freq: 523.25, at: 0, dur: 0.09 }, { freq: 783.99, at: 0.07, dur: 0.13 }],
  // Departure: the same interval, falling.
  leave: [{ freq: 587.33, at: 0, dur: 0.09 }, { freq: 392.0, at: 0.07, dur: 0.14 }],
  // Someone at the door: two soft knocks, low and unhurried.
  knock: [
    { freq: 349.23, at: 0, dur: 0.11, gain: 0.5, type: 'triangle' },
    { freq: 349.23, at: 0.18, dur: 0.11, gain: 0.5, type: 'triangle' },
  ],
  // Let in: a small rising arpeggio.
  admitted: [
    { freq: 523.25, at: 0, dur: 0.08 },
    { freq: 659.25, at: 0.06, dur: 0.08 },
    { freq: 880.0, at: 0.12, dur: 0.16 },
  ],
  denied: [
    { freq: 415.3, at: 0, dur: 0.12, type: 'triangle' },
    { freq: 311.13, at: 0.1, dur: 0.2, type: 'triangle' },
  ],
  // Chat: quiet and short. It happens often, so it must never demand attention.
  message: [{ freq: 880.0, at: 0, dur: 0.07, gain: 0.35 }],
  // Addressed to you: two tones, so it is distinguishable from ordinary chat
  // without being louder.
  mention: [
    { freq: 880.0, at: 0, dur: 0.07, gain: 0.55 },
    { freq: 1174.66, at: 0.08, dur: 0.11, gain: 0.55 },
  ],
  hand: [{ freq: 987.77, at: 0, dur: 0.09, gain: 0.45 }, { freq: 1318.51, at: 0.08, dur: 0.12, gain: 0.4 }],
  reaction: [{ freq: 1046.5, at: 0, dur: 0.05, gain: 0.22 }],
  poll: [
    { freq: 659.25, at: 0, dur: 0.08 },
    { freq: 659.25, at: 0.11, dur: 0.08 },
    { freq: 987.77, at: 0.2, dur: 0.14 },
  ],
  // Recording is the one cue that should feel weighty — people are entitled to
  // notice it starting.
  'recording-start': [
    { freq: 440.0, at: 0, dur: 0.14, type: 'triangle' },
    { freq: 660.0, at: 0.12, dur: 0.2, type: 'triangle' },
  ],
  'recording-stop': [
    { freq: 660.0, at: 0, dur: 0.12, type: 'triangle' },
    { freq: 440.0, at: 0.1, dur: 0.2, type: 'triangle' },
  ],
  success: [{ freq: 783.99, at: 0, dur: 0.07 }, { freq: 1046.5, at: 0.06, dur: 0.12 }],
  error: [
    { freq: 311.13, at: 0, dur: 0.13, type: 'square', gain: 0.22 },
    { freq: 233.08, at: 0.11, dur: 0.2, type: 'square', gain: 0.22 },
  ],
  ended: [
    { freq: 659.25, at: 0, dur: 0.1 },
    { freq: 523.25, at: 0.09, dur: 0.1 },
    { freq: 392.0, at: 0.18, dur: 0.24 },
  ],
};

const STORAGE_KEY = 'tupo_sound_enabled';
const MASTER_GAIN = 0.14;

let context: AudioContext | null = null;
/** Cues arriving faster than this collapse into one. */
const MIN_GAP_MS = 120;
const lastPlayed = new Map<SoundName, number>();

export function soundsEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== 'off';
}

export function setSoundsEnabled(on: boolean): void {
  localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
}

/**
 * An AudioContext created before a user gesture starts suspended, so the first
 * cue would be silently dropped. Resuming on demand costs nothing when it is
 * already running and fixes the case where the tab was restored.
 */
function getContext(): AudioContext | null {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume().catch(() => {});
    return context;
  } catch {
    return null;
  }
}

export function playSound(name: SoundName): void {
  if (!soundsEnabled()) return;

  // Twelve people joining at once should be one chime, not twelve.
  const now = Date.now();
  if (now - (lastPlayed.get(name) ?? 0) < MIN_GAP_MS) return;
  lastPlayed.set(name, now);

  const ctx = getContext();
  const score = SCORES[name];
  if (!ctx || !score) return;

  const start = ctx.currentTime;
  for (const note of score) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = note.type ?? 'sine';
    osc.frequency.value = note.freq;

    // A raw square-edged envelope clicks audibly. Ramping in over a few
    // milliseconds and decaying exponentially is what makes these read as
    // chimes rather than as glitches.
    const t0 = start + note.at;
    const peak = MASTER_GAIN * (note.gain ?? 1);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.dur);

    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + note.dur + 0.02);
  }
}

/**
 * Warm the audio context on a real gesture.
 *
 * Called when someone joins a meeting, which is the last guaranteed click
 * before the cues start mattering.
 */
export function primeSounds(): void {
  const ctx = getContext();
  if (!ctx) return;
  // A zero-gain blip is enough to move the context out of 'suspended' on the
  // browsers that require an actual sound to have been produced.
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.01);
  } catch { /* nothing to do; cues will still try on their own */ }
}
