/**
 * Shared helpers for the feed domain: the caller shape, audience visibility,
 * ranking, and the cursor codec.
 *
 * Everything that decides *who may see what* funnels through `visibleAudiences`
 * and `assertVisible` here, so the feed list, a page's post list, a permalink
 * and the socket fan-out cannot disagree.
 */
import type { FeedAudience, FeedReaction } from '@tupo/shared';
import { FEED_LIMITS, FEED_REACTIONS } from '@tupo/shared';
import { FeedError } from './errors.js';

export type RoleLevel = 'STUDENT' | 'PARENT' | 'STAFF' | 'ADMIN' | null;

/** The caller, as the API middleware already resolves it. */
export interface FeedActor {
  id: string;
  roleLevel: RoleLevel;
  permissions: Set<string>;
}

export const can = (actor: FeedActor, key: string): boolean => actor.permissions.has(key);

/**
 * Which audience bands a role level may see.
 *
 * Staff and admins see everything so that safeguarding and oversight work;
 * a student never sees parent-only posts and a parent never sees student-only
 * posts (SRS FR-USR-6 spirit).
 */
export function visibleAudiences(level: RoleLevel): FeedAudience[] {
  switch (level) {
    case 'ADMIN':
    case 'STAFF':
      return ['everyone', 'staff', 'students', 'parents'];
    case 'STUDENT':
      return ['everyone', 'students'];
    case 'PARENT':
      return ['everyone', 'parents'];
    default:
      return ['everyone'];
  }
}

/** Can this role level *address* a given audience when posting? */
export function canTargetAudience(level: RoleLevel, audience: FeedAudience): boolean {
  if (audience === 'everyone') return true;
  if (level === 'ADMIN' || level === 'STAFF') return true;
  if (level === 'STUDENT') return audience === 'students';
  if (level === 'PARENT') return audience === 'parents';
  return false;
}

export function assertVisible(actor: FeedActor, audience: FeedAudience): void {
  if (!visibleAudiences(actor.roleLevel).includes(audience)) {
    throw new FeedError('This post is not available.', 404);
  }
}

export function normalizeReaction(value: unknown): FeedReaction {
  if (typeof value === 'string' && (FEED_REACTIONS as readonly string[]).includes(value)) {
    return value as FeedReaction;
  }
  throw new FeedError('Unknown reaction.', 400);
}

/** slugify — lowercase, ascii, dash-separated, deduped. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'page';
}

export function clampLimit(raw: unknown, fallback: number = FEED_LIMITS.PAGE_SIZE): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), FEED_LIMITS.MAX_PAGE_SIZE);
}

/* ── Keyset cursor ─────────────────────────────────────────────────────────
 * A cursor is just `<iso-or-score>|<postId>` base64'd. Opaque to the client,
 * trivial to reason about here. */

export interface Cursor { key: string; id: string; }

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.key}|${c.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw) return null;
  try {
    const [key, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
    if (!key || !id) return null;
    return { key, id };
  } catch {
    return null;
  }
}

/**
 * Ranking score for `sort=top`. Cheap enough to recompute per request over the
 * candidate window: engagement on a log scale, minus an age penalty, with a big
 * constant bump for pinned or announcement posts so they always surface first
 * (FR-FEED-6).
 */
export function rankScore(input: {
  reactions: number; comments: number; shares: number;
  publishedAt: Date; pinned: boolean; type: string;
}): number {
  const ageHours = Math.max(0, (Date.now() - input.publishedAt.getTime()) / 3_600_000);
  const engagement = Math.log10(input.reactions + 2 * input.comments + 3 * input.shares + 1);
  const priority = input.pinned || input.type === 'announcement' ? 1000 : 0;
  return priority + engagement - ageHours / 12;
}

export { FEED_LIMITS };
