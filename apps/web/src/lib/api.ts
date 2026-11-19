import type { Envelope } from '@tupo/shared';
import { getDeviceId } from '../vendor/nga-activity';
import { cacheClearAll } from './localStore';
import { setSwSessionToken } from './swSession';

export class ApiError extends Error {
  /** `body`: the server's whole answer, for a refusal that carries more than a message (a code, the newer record). */
  constructor(message: string, readonly status: number, readonly body?: unknown) { super(message); }
  get code(): string | undefined { return (this.body as { code?: string } | undefined)?.code; }
}

export const SESSION_KEY = 'tupo_token';
/** A guest's meeting ticket. Never an account — see apps/api middleware/meetAuth. */
export const MEET_GUEST_KEY = 'tupo_meet_guest';
export const USER_KEY = 'tupo_user';
export const PERMISSIONS_KEY = 'tupo_permissions';
export const ROLE_PERMISSIONS_KEY = 'tupo_role_permissions';

export function clearSession(): void {
  // What this person saw must not render for whoever signs in next (P-02, P-05).
  void cacheClearAll();
  void setSwSessionToken(null);
  try { void caches?.delete('tupo-media-v1').catch(() => {}); } catch { /* no Cache API */ }
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(PERMISSIONS_KEY);
  localStorage.removeItem(ROLE_PERMISSIONS_KEY);
}

/**
 * This tab's id (G-01). Sent with every request so the server can name the
 * tab a broadcast came from, and the tab can recognise its own echo. Per tab,
 * not per device: two tabs of the same person are two writers.
 */
export const TAB_ID: string = typeof crypto !== 'undefined' && 'randomUUID' in crypto
  ? crypto.randomUUID()
  // Not in sessionStorage: a duplicated tab copies it, and two writers would share an id.
  : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/** A request that hangs is worse than one that fails: it fails at 20 s (G-05). */
export const REQUEST_TIMEOUT_MS = 20_000;

let onRequestTimeout: (() => void) | null = null;
/** Lets the counters module hear about timeouts without an import cycle. */
export function setRequestTimeoutListener(fn: (() => void) | null): void { onRequestTimeout = fn; }

/** The caller's signal and the timeout, whichever fires first. */
function withTimeout(signal: AbortSignal | null | undefined, ms: number): { signal: AbortSignal; timedOut: () => boolean } {
  const ctl = new AbortController();
  let fired = false;
  const timer = setTimeout(() => { fired = true; ctl.abort(new DOMException('Request timed out', 'TimeoutError')); }, ms);
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason);
    else signal.addEventListener('abort', () => ctl.abort(signal.reason), { once: true });
  }
  ctl.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return { signal: ctl.signal, timedOut: () => fired };
}

async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Envelope<T>> {
  // A signed-in session always wins; the guest ticket is only used by someone
  // who has no session at all, and only reaches Meet routes.
  const token = localStorage.getItem(SESSION_KEY) ?? localStorage.getItem(MEET_GUEST_KEY);
  // The shared NGA device id, so key events the server records (a message sent,
  // a meeting joined) land on the same device as this browser's page views.
  const deviceId = getDeviceId();
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...rest } = init;
  // `keepalive` requests outlive the page; a timer would only cut them short.
  const t = rest.keepalive ? null : withTimeout(rest.signal, timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      ...(t ? { signal: t.signal } : {}),
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(deviceId ? { 'X-NGA-Device': deviceId } : {}),
        'X-Tupo-Tab': TAB_ID,
        ...(rest.headers ?? {}),
      },
    });
  } catch (err) {
    if (t?.timedOut()) {
      onRequestTimeout?.();
      throw new ApiError('The connection is too slow right now. Please try again.', 0, { code: 'TIMEOUT' });
    }
    throw err;
  }

  // A 401 means the stored session is dead and cannot recover on its own.
  // Clear it and send the user back through the MIS rather than letting every
  // page render its own error against a session that will never work again.
  if (res.status === 401 && token) {
    // A dead guest ticket must not bounce the visitor to the sign-in page —
    // they have no account to sign in with. Send them back to the join screen.
    if (!localStorage.getItem(SESSION_KEY)) {
      localStorage.removeItem(MEET_GUEST_KEY);
    } else {
      clearSession();
      window.location.href = '/';
    }
  }

  let body: Envelope<T>;
  try { body = await res.json(); }
  catch { throw new ApiError(`Unexpected response (${res.status})`, res.status); }

  // Suspended mid-session: one clear screen, not an app where every request
  // quietly fails and every page shows an empty state (A-11).
  if (res.status === 403 && (body as { code?: string }).code === 'ACCOUNT_SUSPENDED' && token) {
    clearSession();
    window.location.href = '/suspended';
  }

  if (!res.ok || body.success === false) {
    throw new ApiError(body.message ?? `Request failed (${res.status})`, res.status, body);
  }
  return body;
}

export const apiGet = <T>(path: string) => request<T>(path, { method: 'GET' });
export const apiPost = <T>(path: string, data?: unknown) =>
  request<T>(path, { method: 'POST', body: data !== undefined ? JSON.stringify(data) : undefined });
export const apiPut = <T>(path: string, data?: unknown, init: Pick<RequestInit, 'signal' | 'keepalive'> = {}) =>
  request<T>(path, { ...init, method: 'PUT', body: data !== undefined ? JSON.stringify(data) : undefined });
export const apiPatch = <T>(path: string, data?: unknown) =>
  request<T>(path, { method: 'PATCH', body: data !== undefined ? JSON.stringify(data) : undefined });
export const apiDelete = <T>(path: string, data?: unknown) =>
  request<T>(path, { method: 'DELETE', body: data !== undefined ? JSON.stringify(data) : undefined });

/**
 * Download an authenticated endpoint as a file.
 *
 * A plain <a href> cannot carry the Authorization header, and putting the
 * session token in a query string would leak it into browser history and every
 * proxy log in between. Fetching to a blob keeps the token in the header where
 * it belongs.
 */
export async function apiDownload(path: string, filename: string): Promise<void> {
  const token = localStorage.getItem(SESSION_KEY) ?? localStorage.getItem(MEET_GUEST_KEY);
  const res = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiError(`Download failed (${res.status})`, res.status);

  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick — revoking synchronously races the click in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
