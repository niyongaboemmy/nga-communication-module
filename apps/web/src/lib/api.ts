import type { Envelope } from '@tupo/shared';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export const SESSION_KEY = 'tupo_token';
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
  const token = localStorage.getItem(SESSION_KEY);
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
    clearSession();
    window.location.href = '/';
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
export const apiDelete = <T>(path: string) => request<T>(path, { method: 'DELETE' });
