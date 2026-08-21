import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import type { SessionClaims } from '@tupo/shared';
import { config } from '../config.js';

/**
 * The API's producer side of the job queue.
 *
 * Deliberately lazy and fail-soft: Redis being down must not stop a host from
 * ending a meeting. The work the queue carries here — post-meeting minutes —
 * is valuable but not on anyone's critical path, and a meeting that ends
 * without generating its minutes is a much better outcome than one that
 * refuses to end.
 */

const QUEUE_NAME = 'tupo-jobs';
const queueUrl = process.env.REDIS_QUEUE_URL ?? 'redis://127.0.0.1:6379/1';

let queue: Queue | null = null;
let disabled = false;

function getQueue(): Queue | null {
  if (disabled) return null;
  if (!queue) {
    try {
      const connection = new Redis(queueUrl, {
        maxRetriesPerRequest: null,
        // Without this a Redis outage turns every enqueue into a slow retry
        // storm behind the request that triggered it.
        enableOfflineQueue: false,
        lazyConnect: false,
      });
      connection.on('error', (err) => console.error('[queue] redis error:', err.message));
      queue = new Queue(QUEUE_NAME, { connection });
    } catch (err) {
      console.error('[queue] unavailable — background jobs disabled:',
        err instanceof Error ? err.message : err);
      disabled = true;
      return null;
    }
  }
  return queue;
}

/**
 * A short-lived token the worker uses to call back into the API as the host.
 *
 * The worker needs the host's authority to generate AI artifacts (the endpoints
 * are permission-gated), but it must not hold a 24-hour session. Fifteen
 * minutes is far longer than the job takes and far shorter than a session.
 */
function serviceToken(user: SessionClaims): string {
  // The registered claims have to go before re-signing. `user` came from a
  // verified token, so it already carries `iat`/`exp` — and jsonwebtoken
  // refuses `expiresIn` on a payload that already has an `exp`. The MIS token
  // goes too: the worker has no business acting against the MIS.
  const {
    misToken: _misToken, iat: _iat, exp: _exp, nbf: _nbf, ...claims
  } = user as SessionClaims & { iat?: number; exp?: number; nbf?: number };
  return jwt.sign(claims, config.jwtSecret, { expiresIn: '15m' });
}

export async function enqueueMeetWrapUp(meetingId: string, host: SessionClaims): Promise<boolean> {
  const q = getQueue();
  if (!q) return false;
  try {
    await q.add('meet:wrap-up', {
      meetingId,
      actorId: host.id,
      token: serviceToken(host),
    }, {
      // The models are the slow, flaky part; retry with backoff rather than
      // losing the minutes to one rate-limited call.
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    });
    return true;
  } catch (err) {
    console.error('[queue] could not enqueue meet wrap-up:',
      err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Unfurl the links in a message (FR-MSG-22).
 *
 * Fail-soft like everything else on this queue: a missing link preview is a
 * message that looks slightly plainer, and it must never be able to fail — or
 * delay — the send that triggered it.
 */
export async function enqueueUnfurl(data: {
  conversationId: string; messageId: string; senderId: string; body: string | null;
}): Promise<boolean> {
  if (!data.body || !/https?:\/\//.test(data.body)) return false;
  const q = getQueue();
  if (!q) return false;
  try {
    await q.add('chat:unfurl', data, {
      // One retry. If somebody's server is down now it will probably still be
      // down in a minute, and a preview is not worth a retry storm.
      attempts: 2,
      backoff: { type: 'fixed', delay: 20_000 },
      removeOnComplete: 50,
      removeOnFail: 20,
    });
    return true;
  } catch {
    return false;
  }
}
