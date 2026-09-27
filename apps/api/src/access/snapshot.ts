import type { AccessSnapshot } from '../vendor/nga-access/index.js';
import { fetchAccessSnapshot } from './misAccess.js';

/**
 * Per-user cache of the MIS access snapshot (README §4-5, plan §13).
 *
 *  - Keyed by MIS user id; an entry remembers the snapshot's `v`
 *    (User.access_version).
 *  - Fresh for ACCESS_SNAPSHOT_TTL_MS (default 5 min). The /api/sso/verify-mis
 *    poll (every ~3 min) reports MIS's current access_version; a different
 *    `v` marks the entry stale so the next check re-fetches at once.
 *  - MIS unreachable / slow / 5xx: the last good snapshot is used for up to
 *    24 h after it was fetched, then the user holds nothing (fail closed).
 *  - MIS rejects the user's token (401/403): no snapshot, immediately.
 */

export type SnapshotStatus = 'fresh' | 'cached' | 'stale' | 'unavailable';
export interface SnapshotResult {
  snapshot: AccessSnapshot | null;
  status: SnapshotStatus;
}

interface Entry { snap: AccessSnapshot; fetchedAt: number; outdated: boolean }

const FRESH_MS = () => Number(process.env.ACCESS_SNAPSHOT_TTL_MS ?? 5 * 60_000);
export const LAST_GOOD_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 20_000;

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<SnapshotResult>>();
/**
 * After a failed fetch, do not ask MIS again for this user for a short while:
 * with MIS down, every permission check would otherwise start another request
 * (each holding a socket for up to the timeout). Cleared by a version change.
 */
const RETRY_AFTER_MS = () => Number(process.env.ACCESS_SNAPSHOT_RETRY_MS ?? 30_000);
const failedAt = new Map<string, number>();

export interface SnapshotSubject { misUserId: string; misToken?: string | null }

function remember(key: string, snap: AccessSnapshot) {
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    // Oldest insertion first — Map iteration order.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(key);
  cache.set(key, { snap, fetchedAt: Date.now(), outdated: false });
}

function lastGood(e: Entry | undefined): SnapshotResult {
  if (e && Date.now() - e.fetchedAt < LAST_GOOD_MS) return { snapshot: e.snap, status: 'stale' };
  return { snapshot: null, status: 'unavailable' };
}

/** The user's snapshot, from cache or MIS. Never throws. */
export async function getAccessSnapshot(subject: SnapshotSubject): Promise<SnapshotResult> {
  const key = String(subject.misUserId ?? '');
  if (!key) return { snapshot: null, status: 'unavailable' };
  const e = cache.get(key);
  if (e && !e.outdated && Date.now() - e.fetchedAt < FRESH_MS()) {
    return { snapshot: e.snap, status: 'cached' };
  }
  if (!subject.misToken) return lastGood(e);
  const failed = failedAt.get(key);
  if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS()) return lastGood(e);

  const running = inflight.get(key);
  if (running) return running;

  const job = (async (): Promise<SnapshotResult> => {
    const r = await fetchAccessSnapshot(subject.misToken!);
    if (r.ok) {
      failedAt.delete(key);
      remember(key, r.snapshot);
      return { snapshot: r.snapshot, status: 'fresh' };
    }
    if (failedAt.size > MAX_ENTRIES) failedAt.clear();
    failedAt.set(key, Date.now());
    if (r.reason === 'rejected') {
      cache.delete(key);
      return { snapshot: null, status: 'unavailable' };
    }
    return lastGood(cache.get(key));
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** What is cached right now, without any network call (null if nothing usable). */
export function peekAccessSnapshot(misUserId: string): AccessSnapshot | null {
  const e = cache.get(String(misUserId));
  return e && Date.now() - e.fetchedAt < LAST_GOOD_MS ? e.snap : null;
}

/**
 * MIS reported this user's current access_version (verify poll). When it
 * differs from the cached `v` the entry is marked outdated — kept as last-good
 * for outages, but re-fetched on the next check. Returns true if invalidated.
 */
export function noteAccessVersion(misUserId: string, version: unknown): boolean {
  const v = Number(version);
  if (!Number.isFinite(v)) return false;
  const e = cache.get(String(misUserId));
  if (!e || e.snap.v === v) return false;
  e.outdated = true;
  failedAt.delete(String(misUserId));
  return true;
}

/** Tests only. */
export function __resetAccessSnapshots(): void {
  cache.clear();
  inflight.clear();
  failedAt.clear();
}

/** Tests only: age an entry (ms since it was fetched). */
export function __ageAccessSnapshot(misUserId: string, ageMs: number): void {
  const e = cache.get(String(misUserId));
  if (e) e.fetchedAt = Date.now() - ageMs;
}
