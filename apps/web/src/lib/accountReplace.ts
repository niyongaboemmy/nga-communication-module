/**
 * One device, one account at a time (school isolation audit 2026-11-25).
 *
 * WEB-ISO-1: a sign-in that replaces the stored session with a DIFFERENT
 * account (another user id, or the same id in another school) used to write
 * the new session over the old one and nothing else. The previous person's
 * push subscription stayed on this device (their notifications kept arriving
 * under the new person), their queued chat messages stayed in the outbox, and
 * their on-device cache stayed open. The full sign-out cleanup now runs first,
 * in the order sign-out uses: push off while the old token still exists, then
 * the outbox, then the session and caches.
 *
 * WEB-ISO-2: cached chats rendered from storage before the session was
 * verified, for as long as the storage existed. A stored session is now only
 * used (online or offline) while its token is unexpired and belongs to the
 * stored user; otherwise it is cleared and the person signs in.
 *
 * Kept free of React/Vite imports so it runs under `node --test`.
 */

export interface AccountRef {
  id: string;
  tid: number;
  email?: string | null;
}

/**
 * - `same`: the same account (token refresh, a second sign-in): nothing to clean.
 * - `school-switch`: the same person in another school (same e-mail, other
 *   tid): sign-out cleanup, but their queued messages are kept for the old
 *   school (owned by `<tid>:<userId>`, sent only after switching back), as a
 *   school switch does.
 * - `other-person`: everything of the previous person goes.
 */
export type AccountChange = 'same' | 'school-switch' | 'other-person';

export function accountChange(prev: AccountRef | null, next: AccountRef): AccountChange | null {
  if (!prev?.id) return null;
  if (prev.id === next.id && prev.tid === next.tid) return 'same';
  const a = (prev.email ?? '').trim().toLowerCase();
  const b = (next.email ?? '').trim().toLowerCase();
  if (prev.tid !== next.tid && a && a === b) return 'school-switch';
  return 'other-person';
}

export interface CleanupDeps {
  /** Stop this device's pushes for the previous session (uses its token, so it runs first). */
  disablePush: () => Promise<unknown>;
  /** Drop every queued chat message. */
  clearOutbox: () => Promise<unknown>;
  /** Keep queued messages but stop flushing them (their owner is not signed in). */
  keepOutbox: () => void;
  /** Remove the stored session, the on-device caches and the SW token. */
  clearSession: () => void;
}

/** Push must never hold up a sign-in for long. */
export const PUSH_CLEANUP_TIMEOUT_MS = 1500;

function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(r, ms))]);
}

/** The sign-out cleanup, in sign-out's order. `keepQueued`: a school switch. */
export async function signOutCleanup(deps: CleanupDeps, keepQueued: boolean, pushTimeoutMs = PUSH_CLEANUP_TIMEOUT_MS): Promise<void> {
  await within(Promise.resolve().then(deps.disablePush), pushTimeoutMs);
  if (keepQueued) deps.keepOutbox();
  else await within(Promise.resolve().then(deps.clearOutbox), pushTimeoutMs);
  deps.clearSession();
}

/**
 * Before a new session is stored: when it is a different account from the
 * stored one, run the sign-out cleanup for the stored one. Returns what kind
 * of change it was (null: nobody was signed in).
 */
export async function prepareAccountReplace(
  prev: AccountRef | null, next: AccountRef, deps: CleanupDeps, pushTimeoutMs = PUSH_CLEANUP_TIMEOUT_MS,
): Promise<AccountChange | null> {
  const change = accountChange(prev, next);
  if (change === null || change === 'same') return change;
  await signOutCleanup(deps, change === 'school-switch', pushTimeoutMs);
  return change;
}

/* ── Stored session ─────────────────────────────────────────────────────── */

export interface TokenClaims { id?: string; tid?: number; exp?: number; email?: string }

export function decodeToken(token: string | null | undefined): TokenClaims | null {
  if (!token) return null;
  try {
    const part = token.split('.')[1] ?? '';
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as TokenClaims;
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

/** The school of a token (an older one is tenant 1). */
export function tidOfClaims(claims: TokenClaims | null): number {
  const n = Number(claims?.tid);
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}

/**
 * May this stored session be used before the server has confirmed it? Only
 * while the token is unexpired and names the stored user (the owner of the
 * on-device cache). A token without `exp` is not trusted.
 */
export function storedSessionUsable(
  token: string | null, user: { id?: string } | null, nowMs: number = Date.now(),
): boolean {
  const claims = decodeToken(token);
  if (!claims || !user?.id) return false;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) return false;
  return claims.id === user.id;
}

/** Milliseconds until the token expires (0 when it has, or cannot be read). */
export function msUntilExpiry(token: string | null, nowMs: number = Date.now()): number {
  const exp = decodeToken(token)?.exp;
  return typeof exp === 'number' ? Math.max(0, exp * 1000 - nowMs) : 0;
}

/** The account a stored session belongs to, or null. */
export function storedAccount(token: string | null, userJson: string | null): AccountRef | null {
  if (!token || !userJson) return null;
  try {
    const user = JSON.parse(userJson) as { id?: string; email?: string } | null;
    if (!user?.id) return null;
    return { id: user.id, tid: tidOfClaims(decodeToken(token)), email: user.email ?? null };
  } catch {
    return null;
  }
}
