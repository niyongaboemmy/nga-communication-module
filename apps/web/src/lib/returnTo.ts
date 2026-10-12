/**
 * Where to go after signing in.
 *
 * A deep link into Tupo (the MIS "Message on Tupo" button opens
 * /app/mentorship?message=1) used to be lost on the way through MIS sign-in:
 * the callback always went to /app. The protected route remembers the path in
 * this tab, and the callback goes back to it — only ever an in-app path, so the
 * value cannot be used to send someone off-site.
 */
const KEY = 'tupo.returnTo';

export function rememberReturnTo(path: string): void {
  if (!path.startsWith('/app/') || path.startsWith('//')) return;
  try { sessionStorage.setItem(KEY, path); } catch { /* storage blocked: land on /app */ }
}

export function takeReturnTo(): string {
  let path: string | null = null;
  try {
    path = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch { /* storage blocked */ }
  return path && path.startsWith('/app/') && !path.startsWith('//') ? path : '/app';
}

/** The remembered path without forgetting it (safe to call while rendering). */
export function peekReturnTo(): string {
  let path: string | null = null;
  try { path = sessionStorage.getItem(KEY); } catch { /* storage blocked */ }
  return path && path.startsWith('/app/') && !path.startsWith('//') ? path : '/app';
}

/** Signed in and inside the app: nothing left to return to. */
export function forgetReturnTo(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* storage blocked */ }
}
