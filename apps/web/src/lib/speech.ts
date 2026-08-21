/**
 * Spoken notifications.
 *
 * A chime says *something happened*; a voice says *what*. In a meeting that
 * difference matters, because the eyes are on the faces and on whatever is
 * being presented — a teacher writing on a board should be able to learn that
 * a pupil has a question without turning round.
 *
 * Deliberately **off by default**. A voice is far more intrusive than a tone,
 * and a browser that starts talking unbidden is one people close. It is offered
 * next to the sound toggle, and remembered once chosen.
 *
 * Uses the browser's own `speechSynthesis`. No network call, no key, no cost,
 * and it works offline — which is worth more here than better prosody would be.
 */

const STORAGE_KEY = 'tupo_voice_enabled';
/** Announcements arriving faster than this are dropped rather than queued. */
const MIN_GAP_MS = 1200;

let lastSpokeAt = 0;
let preferredVoice: SpeechSynthesisVoice | null = null;

export const speechSupported = (): boolean =>
  typeof window !== 'undefined' && 'speechSynthesis' in window;

export function voiceEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === 'on';
}

export function setVoiceEnabled(on: boolean): void {
  localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  if (!on) cancelSpeech();
}

/**
 * Pick a voice once.
 *
 * `getVoices()` is empty until the list loads, which is why this is re-tried
 * rather than resolved at module load. A local voice is preferred over a
 * network one: a remote voice introduces a delay that makes an announcement
 * arrive after the thing it describes.
 */
function pickVoice(): SpeechSynthesisVoice | null {
  if (preferredVoice) return preferredVoice;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  const uiLang = navigator.language || 'en-GB';
  const sameLanguage = voices.filter((v) => v.lang.startsWith(uiLang.slice(0, 2)));
  const pool = sameLanguage.length ? sameLanguage : voices;

  preferredVoice = pool.find((v) => v.localService) ?? pool[0] ?? null;
  return preferredVoice;
}

if (speechSupported()) {
  // Fires once the list is populated, which on some browsers is well after load.
  window.speechSynthesis.onvoiceschanged = () => { preferredVoice = null; pickVoice(); };
}

export interface SpeakOptions {
  /** Cut off whatever is being said. For urgent things only. */
  interrupt?: boolean;
  /** Say it even when several announcements arrive at once. */
  force?: boolean;
}

export function speak(text: string, options: SpeakOptions = {}): void {
  if (!speechSupported() || !voiceEnabled()) return;

  const now = Date.now();
  // Six people joining at once must not become six sentences read in a row,
  // each one arriving further behind the event it describes.
  if (!options.force && now - lastSpokeAt < MIN_GAP_MS) return;
  lastSpokeAt = now;

  try {
    if (options.interrupt) window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    // Slightly quick and slightly quiet: this is an aside, not an announcement
    // over a public-address system.
    utterance.rate = 1.08;
    utterance.pitch = 1;
    utterance.volume = 0.85;
    window.speechSynthesis.speak(utterance);
  } catch {
    // A refused or unsupported utterance is not worth surfacing — the toast
    // and the chime have already done the job.
  }
}

export function cancelSpeech(): void {
  if (!speechSupported()) return;
  try { window.speechSynthesis.cancel(); } catch { /* nothing to cancel */ }
}

/**
 * Announce a person's name safely.
 *
 * Display names come from the MIS and can contain anything; a name full of
 * punctuation makes a synthesiser stumble or spell it out character by
 * character. Reducing it to letters and spaces is what keeps it a name.
 */
export const speakableName = (name: string): string =>
  name.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Someone';
