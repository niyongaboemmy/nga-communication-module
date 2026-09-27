import { getPool, resolveUserPermissions } from '@tupo/db';

/**
 * Live account state for a socket.
 *
 * A session JWT proves who someone was when it was issued; it says nothing
 * about whether an administrator has since suspended them or taken a
 * permission away. The API re-reads both on every request (middleware/auth.ts);
 * a socket lives for hours, so the gateway has to do the same thing on its own
 * cadence: once, uncached, at the handshake, then through a short-lived cache
 * on every inbound event, plus a periodic sweep that disconnects anyone
 * suspended while sitting idle.
 */
export interface UserAccess {
  status: string;
  permissions: Set<string>;
}

export type AccessDecision =
  | { ok: true; access: UserAccess }
  | { ok: false; reason: 'unknown_user' | 'suspended'; message: string };

/**
 * The one rule, kept pure so it can be tested without a socket: the user row
 * must exist and be active. Mirrors the 401/403 split in the API's auth
 * middleware.
 */
export function decideAccess(access: UserAccess | null): AccessDecision {
  if (!access) {
    return {
      ok: false, reason: 'unknown_user',
      message: 'unauthorized: your session is no longer valid, please sign in again',
    };
  }
  if (access.status !== 'active') {
    return { ok: false, reason: 'suspended', message: 'forbidden: this account has been suspended' };
  }
  return { ok: true, access };
}

/** Read status + permission set straight from the database, with the API's own loader. */
export async function loadUserAccess(userId: string): Promise<UserAccess | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM users WHERE id = $1', [userId]
  );
  if (rows.length === 0) return null;
  const resolved = await resolveUserPermissions(pool, userId);
  if (!resolved) return null;
  return { status: rows[0]!.status, permissions: resolved.permissions };
}

/** Default freshness for per-event checks. */
export const ACCESS_CACHE_TTL_MS = 30_000;

/**
 * A small TTL cache in front of `loadUserAccess`, shared by every socket a
 * person has open on this instance. Concurrent misses for the same user share
 * one in-flight lookup.
 */
export function createAccessCache(opts: {
  load?: (userId: string) => Promise<UserAccess | null>;
  ttlMs?: number;
  now?: () => number;
} = {}) {
  const load = opts.load ?? loadUserAccess;
  const ttlMs = opts.ttlMs ?? ACCESS_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { at: number; value: Promise<UserAccess | null> }>();

  async function get(userId: string, { fresh = false } = {}): Promise<AccessDecision> {
    const hit = entries.get(userId);
    if (!fresh && hit && now() - hit.at < ttlMs) return decideAccess(await hit.value);

    const value = load(userId);
    entries.set(userId, { at: now(), value });
    try {
      return decideAccess(await value);
    } catch (err) {
      // A failed lookup must not be cached, or one DB blip would pin the
      // answer for the whole TTL.
      if (entries.get(userId)?.value === value) entries.delete(userId);
      throw err;
    }
  }

  return {
    get,
    invalidate(userId: string) { entries.delete(userId); },
    /** Bound memory: drop entries nobody has needed for a while. */
    prune() {
      const cutoff = now() - ttlMs * 4;
      for (const [id, e] of entries) if (e.at < cutoff) entries.delete(id);
    },
  };
}

export type AccessCache = ReturnType<typeof createAccessCache>;

/**
 * Of the given user ids, those whose row is missing or not active. One query
 * for the whole instance, so the periodic sweep costs the same with ten users
 * or ten thousand.
 */
export async function findInactiveUsers(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const { rows } = await getPool().query<{ id: string; status: string }>(
    'SELECT id, status FROM users WHERE id = ANY($1::text[])', [userIds]
  );
  const active = new Set(rows.filter((r) => r.status === 'active').map((r) => r.id));
  return new Set(userIds.filter((id) => !active.has(id)));
}
