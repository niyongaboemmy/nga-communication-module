import { Redis } from 'ioredis';
import { config } from '../config.js';

/**
 * The API's outbound socket channel.
 *
 * The API owns durability — the row is committed before anything is emitted —
 * and the realtime gateway owns delivery. They are joined by one Redis pub/sub
 * channel rather than an HTTP call, so neither has to know where the other is
 * running and either can be restarted without the other noticing.
 *
 * Everything here is **fail-soft**. A message that was stored but not pushed
 * arrives when the client next fetches; a push that threw would fail the write
 * that caused it, which is a far worse trade. This is the same reasoning, and
 * the same shape, as `notificationService.push`.
 */

export const CHAT_CHANNEL = 'tupo:chat';

/** What the gateway subscribes to. Rooms are addressed by name, not by socket. */
export interface ChatRelayMessage {
  /** `conv:<id>` or `user:<id>` room names to deliver to. */
  rooms: string[];
  event: string;
  payload: unknown;
  /** A socket id to skip — the sender's own, when it already applied the change
   *  optimistically and re-applying it would make the UI flicker. */
  exceptSocketId?: string;
}

let publisher: Redis | null = null;

function getPublisher(): Redis | null {
  if (publisher) return publisher;
  try {
    publisher = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      // Without this, a Redis outage turns every emit on the request path into
      // a slow retry storm.
      enableOfflineQueue: false,
    });
    publisher.on('error', () => { /* surfaced by the first failed publish */ });
    void publisher.connect().catch(() => {});
  } catch {
    publisher = null;
  }
  return publisher;
}

function relay(msg: ChatRelayMessage): void {
  if (!msg.rooms.length) return;
  const client = getPublisher();
  if (!client) return;
  // Deliberately not awaited: an emit is best-effort and must not add latency
  // to the request that triggered it.
  void client.publish(CHAT_CHANNEL, JSON.stringify(msg)).catch(() => {});
}

/** Everyone with this conversation open. */
export function emitToConversation(
  conversationId: string, event: string, payload: unknown, exceptSocketId?: string,
): void {
  relay({ rooms: [`conv:${conversationId}`], event, payload, exceptSocketId });
}

/** Every device belonging to these people, whatever they have open. */
export function emitToUsers(userIds: string[], event: string, payload: unknown): void {
  relay({ rooms: [...new Set(userIds)].filter(Boolean).map((id) => `user:${id}`), event, payload });
}

export async function closeChatRealtime(): Promise<void> {
  await publisher?.quit().catch(() => {});
  publisher = null;
}
