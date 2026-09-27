/**
 * OAuth `state` (CSRF) helper for the MIS SSO round-trip.
 *
 * login() stores a random value in sessionStorage and sends it to the MIS as
 * `state`; the MIS hands it back unchanged on the redirect to /sso/callback,
 * where consumeSsoState() compares and removes it.
 *
 * Deliberately lenient in two cases so existing flows keep working:
 *  - no `state` on the callback URL (older launchers) -> accepted, warned;
 *  - a `state` is returned but this tab never started a login (nothing
 *    stored, or it expired) -> accepted, warned. The MIS app switcher opens
 *    apps with a state it invented itself, so there is nothing to match.
 * Only a PRESENT state that differs from the one this tab stored is rejected.
 *
 * Kept free of React/Vite imports so it can run under `node --test`.
 */

export const SSO_STATE_KEY = 'tupo_sso_state';

/** A stored state older than this is treated as absent (abandoned login). */
export const SSO_STATE_TTL_MS = 10 * 60 * 1000;

export type StateStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type SsoStateCheck =
  | { ok: true; reason: 'match' | 'no-state-returned' | 'no-state-stored' }
  | { ok: false; reason: 'mismatch' };

/** 32 hex chars from crypto.getRandomValues (128 bits). */
export function generateSsoState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function defaultStorage(): StateStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Generate a state, remember it for this tab, and return it for the URL. */
export function beginSsoState(
  storage: StateStorage | null = defaultStorage(),
  now: number = Date.now(),
): string {
  const value = generateSsoState();
  try {
    storage?.setItem(SSO_STATE_KEY, JSON.stringify({ v: value, t: now }));
  } catch {
    // Storage unavailable (private mode, quota): the callback will see no
    // stored value and fall back to the lenient path rather than break login.
  }
  return value;
}

function readStored(storage: StateStorage | null, now: number): string | null {
  try {
    const raw = storage?.getItem(SSO_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: unknown; t?: unknown };
    if (typeof parsed.v !== 'string' || typeof parsed.t !== 'number') return null;
    if (now - parsed.t > SSO_STATE_TTL_MS || now < parsed.t) return null;
    return parsed.v;
  } catch {
    return null;
  }
}

/** Compare the returned state with the stored one, removing the stored value. */
export function consumeSsoState(
  returned: string | null,
  storage: StateStorage | null = defaultStorage(),
  now: number = Date.now(),
): SsoStateCheck {
  const stored = readStored(storage, now);
  try {
    storage?.removeItem(SSO_STATE_KEY);
  } catch {
    // ignore
  }

  if (!returned) return { ok: true, reason: 'no-state-returned' };
  if (!stored) return { ok: true, reason: 'no-state-stored' };
  return returned === stored ? { ok: true, reason: 'match' } : { ok: false, reason: 'mismatch' };
}
