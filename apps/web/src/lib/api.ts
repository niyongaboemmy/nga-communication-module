import type { Envelope } from '@tupo/shared';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export const SESSION_KEY = 'tupo_token';
/** A guest's meeting ticket. Never an account — see apps/api middleware/meetAuth. */
export const MEET_GUEST_KEY = 'tupo_meet_guest';
export const USER_KEY = 'tupo_user';
export const PERMISSIONS_KEY = 'tupo_permissions';
export const ROLE_PERMISSIONS_KEY = 'tupo_role_permissions';

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(PERMISSIONS_KEY);
  localStorage.removeItem(ROLE_PERMISSIONS_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<Envelope<T>> {
  // A signed-in session always wins; the guest ticket is only used by someone
  // who has no session at all, and only reaches Meet routes.
  const token = localStorage.getItem(SESSION_KEY) ?? localStorage.getItem(MEET_GUEST_KEY);
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

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

  if (!res.ok || body.success === false) {
    throw new ApiError(body.message ?? `Request failed (${res.status})`, res.status);
  }
  return body;
}

export const apiGet = <T>(path: string) => request<T>(path, { method: 'GET' });
export const apiPost = <T>(path: string, data?: unknown) =>
  request<T>(path, { method: 'POST', body: data !== undefined ? JSON.stringify(data) : undefined });
export const apiPut = <T>(path: string, data?: unknown) =>
  request<T>(path, { method: 'PUT', body: data !== undefined ? JSON.stringify(data) : undefined });
export const apiPatch = <T>(path: string, data?: unknown) =>
  request<T>(path, { method: 'PATCH', body: data !== undefined ? JSON.stringify(data) : undefined });
export const apiDelete = <T>(path: string) => request<T>(path, { method: 'DELETE' });

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
