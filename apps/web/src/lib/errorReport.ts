import { SESSION_KEY } from './api';

/**
 * Browser crashes reach the System page (R-05).
 *
 * Window errors, unhandled promise rejections and every error boundary report
 * here; the API groups them by fingerprint. Reports are best effort and
 * bounded: only signed-in sessions report (the endpoint needs one), the same
 * message is sent once per page load, and at most 10 per page load, so a
 * render loop cannot turn into a flood.
 */

/** Set at build time (vite define); 'dev' under the dev server. */
declare const __TUPO_RELEASE__: string;
export const RELEASE = typeof __TUPO_RELEASE__ === 'string' ? __TUPO_RELEASE__ : 'dev';

const sent = new Set<string>();
const MAX_PER_PAGE = 10;

export function reportError(error: unknown, extra: { route?: string } = {}): void {
  try {
    const token = localStorage.getItem(SESSION_KEY);
    if (!token || sent.size >= MAX_PER_PAGE) return;
    const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error));
    const message = err.message || 'Unknown error';
    // Network failures and aborted fetches are the network's, not a bug.
    if (/^(Failed to fetch|Load failed|NetworkError|The user aborted|AbortError)/i.test(message)) return;
    if (sent.has(message)) return;
    sent.add(message);
    void fetch('/api/system/client-errors', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message, stack: err.stack, release: RELEASE,
        route: extra.route ?? window.location.pathname.replace(/\/\d{6,}|\/[0-9a-f-]{20,}/gi, '/:id'),
      }),
    }).catch(() => {});
  } catch { /* reporting must never throw */ }
}

let installed = false;
export function installErrorReporting(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => {
    // A failed <script>/<img> load has no `error`; those are network, not code.
    if (e.error) reportError(e.error);
  });
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason));
}
