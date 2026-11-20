/**
 * Signing in without a click, and landing where the link pointed.
 *
 * Tupo has no sign-in of its own: every session comes from the MIS. Someone
 * who arrives without a Tupo session (a link from MIS Home, a notification, the
 * /apps page, an expired session) is sent straight to the MIS, which hands a
 * person already signed in there back with a code at once. Only these cases
 * show the "Sign in with NGA MIS" screen instead:
 *  - they signed out of Tupo on purpose (any tab, the last 8 hours): bouncing
 *    them to the MIS would sign them straight back in;
 *  - an automatic attempt was made in this tab moments ago: the round trip
 *    failed somewhere, and repeating it would loop;
 *  - the device is offline, or the URL asks for the screen (?signin=manual).
 *
 * The address they asked for is kept for the tab (sessionStorage) across the
 * MIS round trip, so /app/chat/123 opens chat 123, not the first module.
 *
 * Kept free of React/Vite imports so it can run under `node --test`.
 */

export type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const RETURN_KEY = 'tupo_return_to';
export const AUTO_ATTEMPT_KEY = 'tupo_auto_sso_at';
export const SIGNED_OUT_KEY = 'tupo_signed_out_at';

/** Within this, a second automatic attempt is a loop, not a fresh visit. */
export const AUTO_RETRY_MS = 2 * 60_000;
/** An explicit sign-out holds this long; the next day it is automatic again. */
export const SIGNED_OUT_HOLD_MS = 8 * 60 * 60_000;

const session = (): KeyStorage | null => { try { return window.sessionStorage; } catch { return null; } };
const local = (): KeyStorage | null => { try { return window.localStorage; } catch { return null; } };

const readTime = (s: KeyStorage | null, key: string): number | null => {
  try {
    const n = Number(s?.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
};
const write = (s: KeyStorage | null, key: string, value: string | null) => {
  try { if (value === null) s?.removeItem(key); else s?.setItem(key, value); } catch { /* storage off */ }
};

/** Only an in-app address of this origin: never `//evil.org`, never outside /app. */
export function safeReturnPath(path: string | null | undefined): string | null {
  if (!path || typeof path !== 'string' || path.length > 2048) return null;
  if (!/^\/app(?:[/?#]|$)/.test(path)) return null;
  if (path.startsWith('//') || path.includes('\\')) return null;
  return path;
}

export function rememberReturn(path: string, storage: KeyStorage | null = session()): void {
  const safe = safeReturnPath(path);
  if (safe && safe !== '/app') write(storage, RETURN_KEY, safe);
}

/** The remembered address, once (it is removed), or null. */
export function takeReturn(storage: KeyStorage | null = session()): string | null {
  let raw: string | null = null;
  try { raw = storage?.getItem(RETURN_KEY) ?? null; } catch { raw = null; }
  write(storage, RETURN_KEY, null);
  return safeReturnPath(raw);
}

export interface AutoSignInContext {
  tab?: KeyStorage | null;
  shared?: KeyStorage | null;
  now?: number;
  online?: boolean;
  search?: string;
}

export function shouldAutoSignIn({
  tab = session(), shared = local(), now = Date.now(),
  online = typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  search = typeof window === 'undefined' ? '' : window.location.search,
}: AutoSignInContext = {}): boolean {
  if (!online) return false;
  if (new URLSearchParams(search).get('signin') === 'manual') return false;
  const out = readTime(shared, SIGNED_OUT_KEY);
  if (out !== null && now >= out && now - out < SIGNED_OUT_HOLD_MS) return false;
  const tried = readTime(tab, AUTO_ATTEMPT_KEY);
  if (tried !== null && now >= tried && now - tried < AUTO_RETRY_MS) return false;
  return true;
}

export function noteAutoAttempt(tab: KeyStorage | null = session(), now = Date.now()): void {
  write(tab, AUTO_ATTEMPT_KEY, String(now));
}

/** The person chose to sign out: stay on the sign-in screen, in every tab. */
export function markSignedOut(shared: KeyStorage | null = local(), now = Date.now()): void {
  write(shared, SIGNED_OUT_KEY, String(now));
}

/** A session was made: the next time it ends, sign in automatically again. */
export function clearSignInHolds(tab: KeyStorage | null = session(), shared: KeyStorage | null = local()): void {
  write(tab, AUTO_ATTEMPT_KEY, null);
  write(shared, SIGNED_OUT_KEY, null);
}
