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

/**
 * Publish, giving a just-created connection a moment to come up. The
 * publisher is lazy and has no offline queue (so an outage never stalls a
 * request), which meant the first publishes after a restart — sent while it
 * was still connecting — were silently lost (RT-02). Only that start-up window
 * waits, and for at most a second; once a connection has been up, a publish
 * while Redis is down fails fast exactly as before.
 */
const everReady = new WeakSet<Redis>();
async function publishWhenReady(client: Redis, channel: string, message: string): Promise<void> {
  if (client.status === 'ready') everReady.add(client);
  else if (!everReady.has(client) && (client.status === 'connecting' || client.status === 'connect' || client.status === 'wait')) {
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(t); client.off('ready', done); resolve(); };
      const t = setTimeout(done, 1000);
      client.once('ready', done);
    });
    if ((client.status as string) === 'ready') everReady.add(client);
  }
  await client.publish(channel, message);
}

/**
 * Single sign-out: tell the realtime gateway to drop every socket of these
 * users (their sessions just ended via MIS back-channel logout).
 */
export const LOGOUT_CHANNEL = 'tupo:logout';
export function publishSessionEnd(userIds: string[]): void {
  if (!userIds.length) return;
  const client = getPublisher();
  if (!client) return;
  void publishWhenReady(client, LOGOUT_CHANNEL, JSON.stringify({ userIds })).catch(() => {});
}

function relay(msg: ChatRelayMessage): void {
  if (!msg.rooms.length) return;
  const client = getPublisher();
  if (!client) return;
  // Deliberately not awaited: an emit is best-effort and must not add latency
  // to the request that triggered it.
  void publishWhenReady(client, CHAT_CHANNEL, JSON.stringify(msg)).catch(() => {});
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

/**
 * Emit to arbitrary room names. Used by Feed, whose rooms (`feedpost:<id>`) are
 * not conversations. Rooms are named by us, never by a client, so relaying the
 * payload verbatim is safe.
 */
export function emitToRooms(rooms: string[], event: string, payload: unknown, exceptSocketId?: string): void {
  relay({ rooms, event, payload, exceptSocketId });
}

/**
 * Take these people's sockets out of these rooms, on every gateway node (X-02).
 *
 * Membership is checked when a socket joins a room, so a person removed from a
 * conversation kept receiving it — messages, typing, reactions — until they
 * happened to reconnect. This closes that window at the moment of removal.
 */
export function evictFromRooms(userIds: string[], rooms: string[]): void {
  if (!userIds.length || !rooms.length) return;
  const client = getPublisher();
  if (!client) return;
  void publishWhenReady(client, CHAT_CHANNEL, JSON.stringify({ leave: { userIds, rooms } })).catch(() => {});
}

/**
 * A meeting ended outside the room (REST, auto-close): every gateway node
 * tells the people still in it and drops its in-memory room (E-04).
 */
export function publishMeetEnded(meetingId: string, by: string | null): void {
  const client = getPublisher();
  if (!client) return;
  void publishWhenReady(client, CHAT_CHANNEL, JSON.stringify({ meetEnded: { meetingId, by } })).catch(() => {});
}

export async function closeChatRealtime(): Promise<void> {
  await publisher?.quit().catch(() => {});
  publisher = null;
}
