import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Redis } from 'ioredis';
import { fail } from '@tupo/shared';
import { config } from '../config.js';

/**
 * Per-person rate limits on the write paths people (and scripts) can hammer
 * (A-03).
 *
 * Fixed windows in Redis, keyed by the session's user id — the same person on
 * three devices shares one budget, and a classroom behind one NAT address does
 * not. Mounted once at the app level and matched by method + path, so no route
 * file has to remember to opt in. The numbers are generous on purpose: they
 * exist to stop floods and runaway scripts, not to slow a busy teacher down.
 *
 * Fail-open: if Redis is unreachable the request goes through, with an
 * in-process fallback window so a single node still has *some* ceiling.
 */

interface Bucket {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pattern: RegExp;
  limit: number;
  windowSec: number;
  /** Shown to the person in the 429 body. */
  what: string;
}

const id = '[^/]+';
export const BUCKETS: Bucket[] = [
  { name: 'chat-send', method: 'POST', pattern: new RegExp(`^/api/chat/conversations/${id}/(messages|messages/${id}/replies|polls|messages/${id}/forward)$`), limit: 60, windowSec: 60, what: 'messages' },
  { name: 'chat-react', method: 'POST', pattern: new RegExp(`^/api/chat/conversations/${id}/messages/${id}/reactions$`), limit: 120, windowSec: 60, what: 'reactions' },
  { name: 'chat-translate', method: 'POST', pattern: new RegExp(`^/api/chat/conversations/${id}/messages/${id}/translate$`), limit: 30, windowSec: 600, what: 'translations' },
  { name: 'feed-comment', method: 'POST', pattern: new RegExp(`^/api/feed/(posts|reels)/${id}/comments$`), limit: 30, windowSec: 60, what: 'comments' },
  { name: 'feed-post', method: 'POST', pattern: new RegExp(`^/api/feed/(pages/${id}/posts|reels|stories)$`), limit: 20, windowSec: 600, what: 'posts' },
  { name: 'feed-react', method: 'POST', pattern: new RegExp(`^/api/feed/(posts|comments|reels)/${id}/(reactions|like|vote|rsvp|bookmark|share)$`), limit: 180, windowSec: 60, what: 'reactions' },
  { name: 'feed-report', method: 'POST', pattern: new RegExp(`^/api/feed/.+/report$`), limit: 20, windowSec: 600, what: 'reports' },
  // Drafts autosave every few seconds while typing, so compose has headroom.
  { name: 'mail-compose', method: 'POST', pattern: /^\/api\/mail\/compose$/, limit: 60, windowSec: 60, what: 'mail actions' },
  { name: 'mail-ai', method: 'POST', pattern: /^\/api\/mail\/ai\//, limit: 30, windowSec: 600, what: 'AI requests' },
  { name: 'meet-ai', method: 'POST', pattern: new RegExp(`^/api/meet/${id}/ai(/|$)`), limit: 30, windowSec: 600, what: 'AI requests' },
  { name: 'search', method: 'GET', pattern: /^\/api\/(search|chat\/search)(\/|$)/, limit: 90, windowSec: 60, what: 'searches' },
];

let redis: Redis | null = null;
let connecting: Promise<void> | null = null;

/**
 * The shared Redis client, waited for briefly on first use. Counting the
 * first few hits locally and the rest in Redis would split one window across
 * two counters, neither of which ever reaches the limit.
 */
async function client(): Promise<Redis | null> {
  if (!redis) {
    redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    redis.on('error', () => { /* the in-process fallback takes over; never crash */ });
    connecting = new Promise<void>((resolve) => {
      const done = () => resolve();
      redis!.once('ready', done);
      setTimeout(done, 500);
    });
  }
  if (redis.status !== 'ready' && connecting) await connecting;
  return redis.status === 'ready' ? redis : null;
}

/** In-process fallback so a node without Redis still has a ceiling. */
const local = new Map<string, { n: number; resetAt: number }>();
function localHit(key: string, windowSec: number): number {
  const now = Date.now();
  const cur = local.get(key);
  if (!cur || cur.resetAt <= now) {
    local.set(key, { n: 1, resetAt: now + windowSec * 1000 });
    if (local.size > 50_000) for (const [k, v] of local) if (v.resetAt <= now) local.delete(k);
    return 1;
  }
  cur.n += 1;
  return cur.n;
}

function subjectOf(req: Request): string {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const claims = jwt.verify(header.slice(7), config.jwtSecret) as { id?: string; sub?: string };
      const who = claims.id ?? claims.sub;
      if (who) return `u:${who}`;
    } catch { /* fall through to the address */ }
  }
  return `ip:${req.ip}`;
}

export async function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (process.env.RATE_LIMITS === 'off') return next();
  const bucket = BUCKETS.find((b) => b.method === req.method && b.pattern.test(req.path));
  if (!bucket) return next();

  const window = Math.floor(Date.now() / 1000 / bucket.windowSec);
  const key = `rl:${bucket.name}:${subjectOf(req)}:${window}`;
  let count: number;
  try {
    const r = await client();
    if (!r) throw new Error('redis not ready');
    const [[, n]] = (await r.multi().incr(key).expire(key, bucket.windowSec + 5).exec()) as [[unknown, number]];
    count = n;
  } catch {
    count = localHit(key, bucket.windowSec);
  }

  const remaining = Math.max(0, bucket.limit - count);
  res.setHeader('RateLimit-Limit', String(bucket.limit));
  res.setHeader('RateLimit-Remaining', String(remaining));
  if (count > bucket.limit) {
    const retryAfter = bucket.windowSec - (Math.floor(Date.now() / 1000) % bucket.windowSec);
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      ...fail(`Too many ${bucket.what} in a short time. Please wait ${retryAfter}s and try again.`),
      code: 'RATE_LIMITED',
      retryAfter,
    });
    return;
  }
  next();
}

/** Tests only: forget every window. */
export function __resetRateLimits(): void {
  local.clear();
}
