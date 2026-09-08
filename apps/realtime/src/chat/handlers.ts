import type { Server, Socket } from 'socket.io';
import type { Redis } from 'ioredis';
import * as chat from '@tupo/chat';
import { enqueueUnfurl } from './queue.js';
import { ChatError } from '@tupo/chat';
import {
  TYPING_TTL_SECONDS, conversationRoom, typingKey, userRoom,
} from '@tupo/shared';
import type {
  ActivityKind, ClientToServerEvents, ServerToClientEvents, SessionClaims, TypingUser,
} from '@tupo/shared';
import { emitConversationPresence } from '../presence.js';

/**
 * Chat over the socket.
 *
 * Send happens here rather than over REST because the connection is already
 * open: it saves a TCP and TLS handshake on the one action whose latency users
 * can feel, and the ack carries the server id and seq straight back to the
 * optimistic bubble already on screen.
 *
 * Everything calls into `@tupo/chat`, the same package the REST routes use, so
 * there is one implementation of every rule. Nothing in this file decides who
 * may do what; it decides who hears about it.
 *
 * ── Two rooms, two jobs ─────────────────────────────────────────────────────
 *   `conv:<id>`   people with the conversation open — messages, typing, receipts
 *   `user:<id>`   every device one person owns — badges, prefs, notifications
 *
 * The split is what makes a sidebar badge work for a channel you do *not* have
 * open, and what makes reading on your phone clear the badge on your laptop.
 */

type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type ChatServer = Server<ClientToServerEvents, ServerToClientEvents>;

/** Bounded so one socket cannot subscribe itself to the whole institution. */
const MAX_SUBSCRIPTIONS = 500;

export function registerChatHandlers(
  io: ChatServer, socket: ChatSocket, redis: Redis | null,
): void {
  const user = socket.data.user as SessionClaims;
  /** What this socket has been *authorised* for — never what it claims. */
  const subscribed = new Set<string>();

  /* ── Subscribe ────────────────────────────────────────────────────────── */

  socket.on('conversation:subscribe', async ({ conversationIds }, ack) => {
    const wanted = [...new Set(conversationIds ?? [])].slice(0, MAX_SUBSCRIPTIONS);
    const granted: string[] = [];
    const denied: string[] = [];

    for (const id of wanted) {
      try {
        // Checked against the database every time. A client asking nicely is
        // not an access check, and a socket that stayed open across a removal
        // must not keep receiving.
        await chat.requireMembership(user.id, id);
        await socket.join(conversationRoom(id));
        subscribed.add(id);
        granted.push(id);
      } catch {
        denied.push(id);
      }
    }

    ack?.({ ok: denied.length === 0, subscribed: granted, denied });

    // Opening a conversation changes who is in the room, so everyone already
    // there needs the new roster — and the arriving socket needs its first
    // copy. One broadcast serves both.
    for (const id of granted) void emitConversationPresence(io, redis, id);
  });

  socket.on('conversation:unsubscribe', async ({ conversationIds }) => {
    for (const id of conversationIds ?? []) {
      await socket.leave(conversationRoom(id));
      subscribed.delete(id);
      await clearTyping(id);
      // Left *after* the leave, so the roster it computes no longer counts
      // this socket. Computing it first would tell everybody the person who
      // just closed the conversation is still watching.
      void emitConversationPresence(io, redis, id);
    }
  });

  /**
   * A late-opening panel asking for the roster it missed.
   *
   * The member list is not mounted when the conversation is subscribed — it
   * appears when someone opens Details, which may be an hour later. Without
   * this it would start grey and stay grey until somebody happened to connect.
   */
  socket.on('conversation:presence:query', async ({ conversationId }, ack) => {
    if (!subscribed.has(conversationId)) { ack?.({ online: [], viewing: [] }); return; }
    await emitConversationPresence(io, redis, conversationId);
    ack?.({ online: [], viewing: [] });
  });

  /* ── Send ─────────────────────────────────────────────────────────────── */

  socket.on('message:send', async (p, ack) => {
    try {
      const membership = await chat.requireMembership(user.id, p.conversationId);
      if (membership.isArchived) throw new ChatError('This conversation is archived.', 409);
      if (membership.type === 'announcement' && !chat.canManage(membership.role)) {
        // The socket path cannot see platform permissions, so it falls back to
        // the channel role. CHANNEL_ANNOUNCE holders reach the REST route.
        throw new ChatError('Only announcers can post in this channel.', 403);
      }
      if (!p.nonce) throw new ChatError('A nonce is required.', 400);

      const result = await chat.sendMessage({
        conversationId: p.conversationId,
        senderId: user.id,
        body: String(p.body ?? ''),
        nonce: p.nonce,
        type: p.type,
        threadRootId: p.threadRootId ?? null,
        replyToId: p.replyToId ?? null,
        attachments: p.attachments ?? [],
        metadata: p.metadata ?? {},
      });

      // Ack before fan-out. The sender's own bubble settling is the thing they
      // are watching; everyone else is a few milliseconds behind and nobody
      // notices.
      ack?.({ ok: true, message: result.message });

      if (result.created) {
        // Sending is the strongest possible signal that you are not typing.
        await clearTyping(p.conversationId);
        await fanOutMessage(io, p.conversationId, result);
        void enqueueUnfurl({
          conversationId: p.conversationId,
          messageId: result.message.id,
          senderId: result.message.senderId,
          body: result.message.body,
        });

        // The socket is the normal send path, so it is the path that has to
        // raise notifications. Fail-soft: a notification that did not fire is a
        // missed buzz, whereas throwing here would lose a delivered message.
        await chat.notifyNewMessage(result.message, {
          conversationName: membership.name ?? 'a conversation',
          conversationType: membership.type,
          mentionedUserIds: result.mentionedUserIds,
          broadcast: result.broadcast,
          senderMayBroadcast: chat.canManage(membership.role),
        }).catch(() => {});
      }
    } catch (err) {
      ack?.({ ok: false, error: err instanceof ChatError ? err.message : 'Message could not be sent.' });
    }
  });

  /* ── Reactions, edits, deletions ──────────────────────────────────────── */

  socket.on('message:react', async (p, ack) => {
    try {
      await chat.requireMembership(user.id, p.conversationId);
      const { reactions } = await chat.toggleReaction(
        user.id, p.conversationId, p.messageId, p.emoji,
      );
      ack?.({ ok: true, reactions });
      // Everyone in the room, including the reactor: their own optimistic pill
      // is replaced by the authoritative counts rather than added to them.
      io.to(conversationRoom(p.conversationId)).emit('message:reaction', {
        conversationId: p.conversationId, messageId: p.messageId, reactions,
      });
    } catch (err) {
      ack?.({ ok: false, error: err instanceof ChatError ? err.message : 'Could not react.' });
    }
  });

  socket.on('message:edit', async (p, ack) => {
    try {
      const membership = await chat.requireMembership(user.id, p.conversationId);
      const { message, newlyMentioned } = await chat.editMessage(
        user.id, p.conversationId, p.messageId, p.body,
      );
      ack?.({ ok: true, message });
      io.to(conversationRoom(p.conversationId)).emit('message:updated', {
        conversationId: p.conversationId, message,
      });
      if (newlyMentioned.length) {
        await chat.notifyMention(message, newlyMentioned, membership.name ?? 'a conversation')
          .catch(() => {});
      }
    } catch (err) {
      ack?.({ ok: false, error: err instanceof ChatError ? err.message : 'Could not edit.' });
    }
  });

  socket.on('message:delete', async (p, ack) => {
    try {
      const membership = await chat.requireMembership(user.id, p.conversationId);
      // The socket handshake carries no platform permissions — only the JWT's
      // claims — so moderation here rests on the channel role. A holder of
      // MESSAGE_DELETE_ANY who is not a channel moderator uses the REST route,
      // which can see the full permission set.
      const result = await chat.deleteMessage(user.id, p.conversationId, p.messageId, {
        memberRole: membership.role,
      });
      ack?.({ ok: true });
      io.to(conversationRoom(p.conversationId)).emit('message:deleted', {
        conversationId: p.conversationId, messageId: p.messageId,
        deletedBy: user.id, byModerator: result.byModerator,
      });
      await pushUnread(io, p.conversationId);
    } catch (err) {
      ack?.({ ok: false, error: err instanceof ChatError ? err.message : 'Could not delete.' });
    }
  });

  /* ── Typing ───────────────────────────────────────────────────────────── */

  /**
   * Typing state is Redis-only with a short TTL, and the whole set is
   * re-broadcast rather than a delta.
   *
   * A delta stream of something that lives six seconds is not worth the
   * reconciliation bugs, and a TTL means a browser that is force-quit mid-word
   * cannot leave a permanent "Aline is typing…" behind — which is precisely how
   * that indicator loses people's trust.
   */
  const clearTyping = async (conversationId: string) => {
    if (!redis) return;
    try {
      await redis.hdel(typingKey(conversationId), user.id);
      await broadcastTyping(conversationId);
    } catch { /* typing is decoration; never fail loudly */ }
  };

  /**
   * The whole typing set goes to the room, including the person who triggered
   * the broadcast.
   *
   * Filtering the trigger out here looked right and was wrong: this closure
   * belongs to one socket, so excluding `user.id` removed that person from
   * *everyone's* payload, not just their own — the one participant who must see
   * "Alice is typing" is Bob, and Bob was the one being told nobody was.
   * Each client drops its own id; only the client knows who it is.
   */
  const broadcastTyping = async (conversationId: string) => {
    if (!redis) return;
    try {
      const raw = await redis.hgetall(typingKey(conversationId));
      const users: TypingUser[] = Object.entries(raw).map(([userId, value]) => {
        // The field used to be a bare name. A hash written by an older gateway
        // during a rolling deploy is still readable — it degrades to a name
        // with no face and the default activity, rather than throwing and
        // blanking the indicator for everyone in the room.
        try {
          const parsed = JSON.parse(value) as
            { name?: string; avatarUrl?: string | null; kind?: ActivityKind };
          return {
            userId,
            name: parsed.name ?? 'Someone',
            avatarUrl: parsed.avatarUrl ?? null,
            kind: parsed.kind ?? 'typing',
          };
        } catch {
          return { userId, name: value, avatarUrl: null, kind: 'typing' as ActivityKind };
        }
      });
      io.to(conversationRoom(conversationId)).emit('typing:update', { conversationId, users });
    } catch { /* ignore */ }
  };

  const ACTIVITY_KINDS = new Set<ActivityKind>(['typing', 'recording', 'uploading']);

  socket.on('typing:start', async ({ conversationId, kind }) => {
    if (!subscribed.has(conversationId) || !redis) return;
    try {
      const key = typingKey(conversationId);
      await redis.hset(key, user.id, JSON.stringify({
        name: user.name ?? 'Someone',
        // Straight from the verified session claims, never from the client:
        // this is rendered as somebody's face beside their name, so letting the
        // socket supply it would let anyone wear anyone else's.
        avatarUrl: user.avatarUrl ?? null,
        kind: ACTIVITY_KINDS.has(kind as ActivityKind) ? kind : 'typing',
      }));
      // Refreshed on every keystroke burst, so the key outlives a pause in
      // typing but not a closed tab.
      await redis.expire(key, TYPING_TTL_SECONDS);
      await broadcastTyping(conversationId);
    } catch { /* ignore */ }
  });

  socket.on('typing:stop', ({ conversationId }) => { void clearTyping(conversationId); });

  /* ── Read state ───────────────────────────────────────────────────────── */

  socket.on('read:advance', async ({ conversationId, seq }, ack) => {
    try {
      await chat.requireMembership(user.id, conversationId);
      const result = await chat.advanceRead(user.id, conversationId, seq);
      await chat.markRead(user.id, conversationId, seq);

      ack?.({ ok: true, unread: result.unread, unreadMentions: result.unreadMentions });

      // Every device this person owns clears its badge…
      io.to(userRoom(user.id)).emit('conversation:unread', {
        conversationId,
        unread: result.unread,
        unreadMentions: result.unreadMentions,
        lastReadSeq: result.lastReadSeq,
      });
      // …and everyone in the room repaints their read marker.
      io.to(conversationRoom(conversationId)).emit('read:update', {
        conversationId, userId: user.id, seq: result.lastReadSeq, at: new Date().toISOString(),
      });
    } catch {
      ack?.({ ok: false, unread: 0, unreadMentions: 0 });
    }
  });

  socket.on('receipt:delivered', async ({ conversationId, messageIds }) => {
    if (!subscribed.has(conversationId) || !messageIds?.length) return;
    try {
      await chat.markDelivered(user.id, conversationId, messageIds.slice(0, 200));
      // The sender's ticks are the only thing that changes; the room is the
      // cheapest way to reach them without looking up who they are.
      io.to(conversationRoom(conversationId)).emit('receipt:update', {
        conversationId, messageId: messageIds[messageIds.length - 1]!,
        delivery: 'delivered', readCount: 0,
      });
    } catch { /* ignore */ }
  });

  socket.on('disconnect', () => {
    for (const id of subscribed) {
      // A closed tab must not leave typing state behind in any conversation…
      void clearTyping(id);
      // …nor keep counting towards "3 people are here". Socket.IO has already
      // removed this socket from its rooms by the time `disconnect` fires, so
      // the roster this computes is the correct post-departure one.
      void emitConversationPresence(io, redis, id);
    }
  });
}

/**
 * Fan a new message out.
 *
 * Deliberately two emits. `message:new` reaches whoever has the conversation
 * open; `conversation:unread` reaches every member's own room whether or not
 * they do. A single broadcast to the conversation room would leave the sidebar
 * badge silently wrong for exactly the people who are not looking.
 */
export async function fanOutMessage(
  io: ChatServer, conversationId: string, result: chat.SendResult,
): Promise<void> {
  io.to(conversationRoom(conversationId)).emit('message:new', {
    conversationId, message: result.message,
  });
  await pushUnread(io, conversationId, result.message.senderId);
}

/**
 * Send every member their own current counters.
 *
 * Called after anything that changes the arithmetic — a new message, a
 * deletion. Per-user because the numbers differ per user, and to the `user:`
 * room because the people who most need it are the ones without the
 * conversation open.
 */
async function pushUnread(
  io: ChatServer, conversationId: string, exceptUserId?: string,
): Promise<void> {
  const members = await chat.memberIdsOf(conversationId);
  const targets = exceptUserId ? members.filter((id) => id !== exceptUserId) : members;
  if (!targets.length) return;

  const counts = await chat.unreadFor(targets, conversationId);
  for (const [userId, c] of Object.entries(counts)) {
    io.to(userRoom(userId)).emit('conversation:unread', {
      conversationId, unread: c.unread, unreadMentions: c.unreadMentions,
      lastReadSeq: c.lastReadSeq,
    });
  }
}
