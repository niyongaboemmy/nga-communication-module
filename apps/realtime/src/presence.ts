import type { Server } from 'socket.io';
import type { Redis } from 'ioredis';
import * as chat from '@tupo/chat';
import {
  PRESENCE_TTL_SECONDS, conversationRoom, lastSeenKey, presenceKey, userRoom,
} from '@tupo/shared';
import type {
  ClientToServerEvents, PresenceSnapshot, PresenceStatus, ServerToClientEvents,
} from '@tupo/shared';

/**
 * Presence, the live half.
 *
 * Three stores, each holding the part it is good at:
 *
 *   Redis `presence:<id>`   what someone is right now. TTL'd, so a browser that
 *                           was killed expires instead of staying green forever.
 *   Redis `lastseen:<id>`   when they were last here. No TTL — it is only read
 *                           once presence has gone, so expiring with it would
 *                           make it useless. A cache in front of…
 *   Postgres users.last_seen_at   …the durable copy, which survives a restart
 *                           of this process and a flush of Redis.
 *
 * Everything here fails soft. Presence is decoration: a gateway that cannot
 * reach Redis must still deliver messages, and the correct degraded reading is
 * "offline", never a stale "online".
 */

type PresenceServer = Server<ClientToServerEvents, ServerToClientEvents>;

const VALID_STATUSES = new Set<PresenceStatus>(
  ['online', 'away', 'busy', 'in-a-meeting', 'dnd', 'offline'],
);

export function toStatus(raw: unknown): PresenceStatus {
  return VALID_STATUSES.has(raw as PresenceStatus) ? raw as PresenceStatus : 'online';
}

/** Mark someone present, and keep the key alive. Idempotent by design. */
export async function markOnline(
  redis: Redis | null, userId: string, status: PresenceStatus,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(presenceKey(userId), status, 'EX', PRESENCE_TTL_SECONDS);
  } catch { /* degraded to single-instance, not broken */ }
}

/**
 * Record that someone has just gone.
 *
 * Redis first because it is what every subsequent read hits; the database write
 * is the durable backstop and is allowed to be the slow one. Both are optional:
 * a last-seen that did not get written costs a line of subtitle, and nothing
 * else.
 */
export async function markOffline(
  redis: Redis | null, userId: string, at: Date = new Date(),
): Promise<void> {
  const iso = at.toISOString();
  if (redis) {
    try {
      await redis.del(presenceKey(userId));
      await redis.set(lastSeenKey(userId), iso);
    } catch { /* ignore */ }
  }
  await chat.touchLastSeen(userId, at).catch(() => {});
}

/** Refresh the last-seen cache without a database write. See below for why. */
export async function touchLastSeenCache(redis: Redis | null, userId: string): Promise<void> {
  if (!redis) return;
  try { await redis.set(lastSeenKey(userId), new Date().toISOString()); } catch { /* ignore */ }
}

/**
 * Read presence for a set of people.
 *
 * One `mget` for status and one for the last-seen cache, then a single database
 * query for whatever the cache did not know — which after a restart is
 * everyone, and in steady state is nobody.
 */
export async function readPresence(
  redis: Redis | null, userIds: string[],
): Promise<Record<string, PresenceSnapshot>> {
  const out: Record<string, PresenceSnapshot> = {};
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return out;

  let statuses: (string | null)[] = [];
  let seen: (string | null)[] = [];
  if (redis) {
    try {
      statuses = await redis.mget(ids.map(presenceKey));
      seen = await redis.mget(ids.map(lastSeenKey));
    } catch { statuses = []; seen = []; }
  }

  const missing: string[] = [];
  ids.forEach((id, i) => {
    const status = statuses[i] ? toStatus(statuses[i]) : 'offline';
    const lastSeenAt = seen[i] ?? null;
    // Somebody who is online *is* being seen, right now — answering "last seen
    // 40 minutes ago" beside a green dot reads as a bug, and the database
    // legitimately holds a stale figure for anyone still connected.
    if (status !== 'offline') { out[id] = { status, lastSeenAt: null }; return; }
    out[id] = { status, lastSeenAt };
    if (!lastSeenAt) missing.push(id);
  });

  if (missing.length) {
    const fromDb = await chat.lastSeenFor(missing).catch(() => ({} as Record<string, string | null>));
    for (const [id, iso] of Object.entries(fromDb)) {
      if (!iso) continue;
      out[id] = { status: out[id]?.status ?? 'offline', lastSeenAt: iso };
      // Warm the cache so the next reader does not pay for the same row.
      if (redis) void redis.set(lastSeenKey(id), iso).catch(() => {});
    }
  }
  return out;
}

/**
 * Tell the people who render this person's dot that it moved.
 *
 * DM counterparts only, and deliberately so. Their sidebar row shows the dot
 * whether or not the conversation is open, so they are the only audience that
 * is *always* looking at it.
 *
 * A channel's members are not an audience for this. Fanning out to conversation
 * rooms as well would make one person flicking between tabs a broadcast to
 * every room they belong to, which is the cost this design exists to avoid.
 * Channels learn about presence two other ways, both cheaper: the gateway
 * pushes `conversation:presence` when somebody actually joins or leaves a
 * conversation, and an open member list re-pulls the roster on a slow timer to
 * catch status changes in between.
 */
export async function broadcastPresence(
  io: PresenceServer, userId: string, status: PresenceStatus, lastSeenAt: string | null = null,
): Promise<void> {
  try {
    const at = new Date().toISOString();
    const payload = { userId, status, at, lastSeenAt };

    const peers = await chat.dmPeerIdsOf(userId);
    if (peers.length) io.to(peers.map(userRoom)).emit('presence:update', payload);

    // The person's own other devices, so a status set on the phone shows on
    // the laptop. Deliberately separate from the fan-out above: they are not a
    // DM counterpart of themselves.
    io.to(userRoom(userId)).emit('presence:update', payload);
  } catch {
    // Presence is decoration. It must never take a connection down with it.
  }
}

/**
 * Push the live roster of one conversation to everyone looking at it.
 *
 * `viewing` comes from the room itself — `fetchSockets` is adapter-aware, so it
 * sees sockets held by every gateway instance, not just this one. `online` comes
 * from the member list crossed with Redis, because being online and having this
 * conversation open are different facts and the UI shows them differently.
 */
export async function emitConversationPresence(
  io: PresenceServer, redis: Redis | null, conversationId: string,
): Promise<void> {
  try {
    const sockets = await io.in(conversationRoom(conversationId)).fetchSockets();
    if (!sockets.length) return; // Nobody to tell.

    const viewing = [...new Set(
      sockets.map((s) => (s.data as { user?: { id?: string } }).user?.id).filter(Boolean),
    )] as string[];

    const memberIds = await chat.memberIdsOf(conversationId);
    const snapshot = await readPresence(redis, memberIds);
    const online = memberIds.filter((id) => (snapshot[id]?.status ?? 'offline') !== 'offline');

    io.to(conversationRoom(conversationId)).emit('conversation:presence', {
      conversationId, online, viewing, at: new Date().toISOString(),
    });
  } catch { /* ignore */ }
}
