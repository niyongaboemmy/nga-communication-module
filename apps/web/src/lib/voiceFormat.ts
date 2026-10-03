/**
 * Which audio format to record voice messages in.
 *
 * Chromium records WebM/Opus. Safari, and so the NGA desktop app on macOS
 * (WKWebView), recorded only MP4/AAC before Safari 18.4. Asking for WebM
 * there made `new MediaRecorder()` throw, so voice messages failed. Pick the
 * first format this engine can record, and name the file after it.
 *
 * Kept free of React/DOM imports so it runs under `node --test`.
 */
export const VOICE_FORMATS = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

/** The first supported format, or undefined to let the engine choose. */
export function pickVoiceFormat(isSupported: (mime: string) => boolean): string | undefined {
  return VOICE_FORMATS.find((m) => {
    try {
      return isSupported(m);
    } catch {
      return false;
    }
  });
}

/** File extension for a recorded audio MIME type. */
export function voiceExtension(mime: string): string {
  const base = (mime.split(';')[0] ?? '').trim().toLowerCase();
  if (base === 'audio/mp4' || base === 'audio/aac' || base === 'audio/x-m4a') return 'm4a';
  if (base === 'audio/ogg') return 'ogg';
  return 'webm';
}
