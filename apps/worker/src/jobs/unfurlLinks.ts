import { Redis } from 'ioredis';
import * as chat from '@tupo/chat';

/**
 * Unfurl the links in one message (FR-MSG-22).
 *
 * On the queue, never on the send path. Fetching somebody else's server can
 * take five seconds and can fail, and neither of those may be in the way of a
 * message appearing — the whole product is judged on how quickly a message
 * shows up.
 *
 * When a preview does arrive, the message is re-emitted so it appears under a
 * message already on screen rather than only on the next reload.
 */

const CHAT_CHANNEL = 'tupo:chat';
let publisher: Redis | null = null;

function getPublisher(url: string): Redis | null {
  if (publisher) return publisher;
  try {
    publisher = new Redis(url, {
      lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false,
    });
    publisher.on('error', () => {});
    void publisher.connect().catch(() => {});
  } catch {
    publisher = null;
  }
  return publisher;
}

export interface UnfurlJobData {
  conversationId: string;
  messageId: string;
  senderId: string;
  body: string | null;
}

export async function runUnfurl(data: UnfurlJobData, redisUrl: string): Promise<{ fetched: number }> {
  const fetched = await chat.unfurlMessage(data.conversationId, data.messageId, data.body);
  if (!fetched) return { fetched: 0 };

  // Re-read so the emitted message carries the previews that were just stored.
  const message = await chat.getMessage(data.senderId, data.conversationId, data.messageId);
  if (!message?.linkPreviews.length) return { fetched };

  const client = getPublisher(redisUrl);
  await client?.publish(CHAT_CHANNEL, JSON.stringify({
    rooms: [`conv:${data.conversationId}`],
    event: 'message:updated',
    payload: { conversationId: data.conversationId, message },
  })).catch(() => {});

  return { fetched };
}
