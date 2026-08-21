import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * The gateway's producer side of the job queue.
 *
 * The socket is the normal send path, so link unfurling has to be enqueued from
 * here as well as from the REST route — otherwise the feature would only work
 * for messages sent while the socket happened to be down.
 *
 * Fail-soft throughout: a missing preview is cosmetic, and this must never be
 * able to delay or fail a send.
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
        enableOfflineQueue: false,
      });
      connection.on('error', () => { /* surfaced by the first failed add */ });
      queue = new Queue(QUEUE_NAME, { connection });
    } catch {
      disabled = true;
      return null;
    }
  }
  return queue;
}

export async function enqueueUnfurl(data: {
  conversationId: string; messageId: string; senderId: string; body: string | null;
}): Promise<void> {
  if (!data.body || !/https?:\/\//.test(data.body)) return;
  try {
    await getQueue()?.add('chat:unfurl', data, {
      attempts: 2,
      backoff: { type: 'fixed', delay: 20_000 },
      removeOnComplete: 50,
      removeOnFail: 20,
    });
  } catch {
    // A preview that was never fetched is a plainer message, nothing more.
  }
}
