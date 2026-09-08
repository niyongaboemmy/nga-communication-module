import { Router, type Request, type Response, type NextFunction } from 'express';
import { Redis } from 'ioredis';
import { getPool } from '@tupo/db';
import { ok, fail } from '@tupo/shared';
import type { NotificationLevel } from '@tupo/shared';
import { NOTIFICATION_LEVELS, CONVERSATION_TYPES, MEMBER_ROLES } from '@tupo/shared';
import { lastSeenKey, presenceKey } from '@tupo/shared';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { config } from '../config.js';
import * as chat from '@tupo/chat';
import { ChatError } from '@tupo/chat';
import { emitToConversation, emitToUsers } from '../services/chatRealtime.js';
import { audit } from '../services/userService.js';
import { enqueueUnfurl } from '../services/queue.js';
import {
  translateMessage, isSupportedLanguage, SUPPORTED_LANGUAGES,
} from '../services/translateService.js';

/**
 * Chat REST.
 *
 * The socket gateway is the fast path for sending and the fan-out path for
 * receiving; this is everything else — the initial load, pagination, and the
 * actions that are not latency-critical. Send exists here too, because the
 * offline queue needs a transport that works before a socket is up and because
 * an integration should not have to speak Socket.IO to post a message.
 *
 * Both transports call the same service functions, so authorisation cannot be
 * present on one path and missing on the other.
 */
const router = Router();
router.use(authMiddleware);

const actor = (req: Request) => (req as AuthenticatedRequest).user!;

/** ChatError carries its own status; anything else is a 500 we did not expect. */
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try { await fn(req, res); }
    catch (err) {
      if (err instanceof ChatError) return res.status(err.status).json(fail(err.message));
      next(err);
    }
  };

/* ────────────────────────────────────────────────────────────────────────── *
 * Presence lookup
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Presence lives in Redis with a 90-second TTL and is read, never stored.
 * A degraded Redis makes everyone look offline, which is the correct failure:
 * showing a stale "online" is worse than showing nothing.
 */
let presenceClient: Redis | null = null;
function presence(): Redis | null {
  if (presenceClient) return presenceClient;
  try {
    presenceClient = new Redis(config.redisUrl, {
      lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false,
    });
    presenceClient.on('error', () => {});
    void presenceClient.connect().catch(() => {});
  } catch { presenceClient = null; }
  return presenceClient;
}

async function presenceFor(userIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!userIds.length) return out;
  const client = presence();
  if (!client) return out;
  try {
    const values = await client.mget(userIds.map(presenceKey));
    userIds.forEach((id, i) => { out[id] = values[i] ?? 'offline'; });
    // "Show when I am online" is a real setting now. Someone who turned it off
    // reads as offline to everyone else — the same shape as the read-receipts
    // preference, which was the only one of these ever enforced.
    const visible = await chat.presenceVisibleFor(userIds);
    for (const id of userIds) if (!visible.has(id)) out[id] = 'offline';
  } catch { /* everyone reads as offline */ }
  return out;
}

/**
 * When each of these people was last connected.
 *
 * Only asked for alongside presence, and only useful for the ones who are not
 * online right now. Hidden for anyone who has turned presence off: "last seen
 * 3 minutes ago" discloses exactly what that setting is meant to withhold.
 *
 * Redis answers first — the gateway writes `lastseen:` on every disconnect, so
 * for anyone who has used the app since the last restart it is already there
 * and the database is never touched. Postgres backs the misses, which is the
 * durable copy and the only source after a Redis flush.
 */
async function lastSeenFor(userIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!userIds.length) return out;
  try {
    const visible = await chat.presenceVisibleFor(userIds);
    const wanted = userIds.filter((id) => visible.has(id));
    if (!wanted.length) return out;

    const client = presence();
    let missing = wanted;
    if (client) {
      try {
        const cached = await client.mget(wanted.map(lastSeenKey));
        missing = [];
        wanted.forEach((id, i) => {
          const v = cached[i];
          if (v) out[id] = v; else missing.push(id);
        });
      } catch { /* fall through to the database for all of them */ }
    }

    if (missing.length) {
      const { rows } = await getPool().query<{ id: string; last_seen_at: Date | null }>(
        'SELECT id, last_seen_at FROM users WHERE id = ANY($1::text[])', [missing]);
      for (const r of rows) {
        if (r.last_seen_at) out[r.id] = new Date(r.last_seen_at).toISOString();
      }
    }
  } catch { /* no last-seen is a missing line, not an error */ }
  return out;
}

/**
 * Attach presence and last-seen to a person-shaped object.
 *
 * Both maps are built once per request for the whole batch, so this is a plain
 * lookup — the point is that every endpoint returning a person decorates it the
 * same way. `lastSeenAt` is null rather than absent when unknown, so a client
 * can tell "offline, never seen" from "offline, seen at 3pm" without treating a
 * missing key as a special case.
 */
function withPresence<T extends object>(
  person: T, id: string,
  online: Record<string, string>, seen: Record<string, string>,
): T & { presence: string; lastSeenAt: string | null } {
  return { ...person, presence: online[id] ?? 'offline', lastSeenAt: seen[id] ?? null };
}

/**
 * Write a system notice AND put it on the wire.
 *
 * `chat.systemMessage` only writes the row. Every caller then has to remember
 * to broadcast it, and the one that forgets produces a notice nobody sees until
 * they reload — which is precisely when a "pinned a message" line has stopped
 * being useful. Wrapping the two together removes the chance to forget.
 */
async function announce(
  conversationId: string, actorId: string, text: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const message = await chat.systemMessage(conversationId, actorId, text, metadata);
  if (message) emitToConversation(conversationId, 'message:new', { conversationId, message });
}

/**
 * Tell every member that a conversation now exists, or has changed.
 *
 * Sent **per viewer**, not once to the room, because a conversation summary is
 * viewer-scoped: a DM has no name of its own, and each side sees the other
 * person's. Broadcasting one payload would show Ada her own name in her
 * sidebar. It also has to go to the `user:` room rather than `conv:` — nobody
 * is subscribed to a conversation they have not been told about yet.
 */
async function announceConversation(conversationId: string): Promise<void> {
  const members = await chat.memberIdsOf(conversationId);
  await Promise.all(members.map(async (userId) => {
    try {
      const conversation = await chat.getConversation(userId, conversationId);
      emitToUsers([userId], 'conversation:updated', { conversation });
    } catch { /* a member who cannot see it does not need telling */ }
  }));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Directory
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * People you can start a conversation with.
 *
 * Separate from `/api/users`, which is the administrative roster and needs
 * `USERS_VIEW`. This is the everyday people-picker: it needs `DIRECTORY_VIEW`,
 * which every role holds, and it returns only what a picker renders — no email,
 * no status, no audit fields. An ordinary user searching for a colleague should
 * not be exercising an admin endpoint.
 */
router.get('/directory', authorizePermission('DIRECTORY_VIEW'), wrap(async (req, res) => {
  const me = actor(req);
  const q = String(req.query.q ?? '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 50);

  const { rows } = await getPool().query<{
    id: string; name: string; avatar_url: string | null; role: string; email: string;
  }>(
    /*
     * The email comes back because display names are not unique. A school has
     * more than one Aline Uwase, and a picker that shows six identical rows is
     * a picker you cannot use — the client shows the address to tell them
     * apart. It is searchable for the same reason: if you know which one you
     * want, you know their address.
     */
    `SELECT id, name, avatar_url, role, email
       FROM users
      WHERE id <> $1 AND status = 'active'
        AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%')
        -- Someone who blocked you, or whom you blocked, is not in your picker.
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = users.id AND b.blocked_id = $1)
              OR (b.blocker_id = $1 AND b.blocked_id = users.id))
      -- Name, then email: same-named people get a stable, predictable order
      -- rather than whatever the planner felt like.
      ORDER BY name ASC, email ASC
      LIMIT $3`,
    [me.id, q, limit],
  );

  const ids = rows.map((r) => r.id);
  const online = await presenceFor(ids);
  const seen = await lastSeenFor(ids);
  res.json(ok({
    people: rows.map((r) => withPresence({
      id: r.id, name: r.name, avatarUrl: r.avatar_url, role: r.role,
      email: r.email,
    }, r.id, online, seen)),
  }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Conversations
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/conversations', authorizePermission('MESSAGE_READ'), wrap(async (req, res) => {
  const me = actor(req);
  const conversations = await chat.listConversations(me.id);

  // Presence for DM counterparts only — a channel has no single presence, and
  // looking up 400 members to render a sidebar row would be absurd.
  const peerIds = conversations.map((c) => c.peer?.id).filter((x): x is string => Boolean(x));
  const [online, lastSeen] = await Promise.all([presenceFor(peerIds), lastSeenFor(peerIds)]);

  res.json(ok({
    conversations: conversations.map((c) => ({
      ...c,
      peer: c.peer
        ? {
            ...c.peer,
            presence: online[c.peer.id] ?? 'offline',
            lastSeenAt: lastSeen[c.peer.id] ?? null,
          }
        : null,
    })),
  }));
}));

router.get('/conversations/:id', authorizePermission('MESSAGE_READ'), wrap(async (req, res) => {
  const me = actor(req);
  await chat.requireMembership(me.id, req.params.id!);
  res.json(ok({ conversation: await chat.getConversation(me.id, req.params.id!) }));
}));

router.post('/conversations', authorizePermission('CHANNEL_CREATE'), wrap(async (req, res) => {
  const me = actor(req);
  const { type, name, topic, description, isPrivate, iconEmoji, avatarColor, memberIds } = req.body ?? {};

  if (!CONVERSATION_TYPES.includes(type)) {
    return res.status(400).json(fail('That is not a conversation type.'));
  }
  if (type === 'dm') {
    return res.status(400).json(fail('Use /conversations/direct to open a direct message.'));
  }
  if (type !== 'group' && !String(name ?? '').trim()) {
    return res.status(400).json(fail('A channel needs a name.'));
  }
  // Announcement channels are a broadcast surface; creating one is a separate
  // decision from creating an ordinary channel.
  if (type === 'announcement' && !me.permissions.has('CHANNEL_ANNOUNCE')) {
    return res.status(403).json(fail('You may not create announcement channels.'));
  }

  const conversation = await chat.createConversation(me.id, {
    spaceId: await chat.defaultSpaceFor(me.id),
    type, name, topic, description, isPrivate, iconEmoji, avatarColor,
    memberIds: Array.isArray(memberIds) ? memberIds.slice(0, 500) : [],
  });

  await announce(conversation.id, me.id,
    `${me.name} created this ${type === 'group' ? 'group' : 'channel'}.`,
    { event: 'created' });

  // Everyone who was added needs it to appear without a refresh.
  await announceConversation(conversation.id);

  res.status(201).json(ok({ conversation }));
}));

/**
 * Open (or create) a DM.
 *
 * `DM_START` is only needed to create one. Replying to a DM someone else opened
 * must always work, or a student could be messaged by a teacher and be unable
 * to answer — which is worse than either extreme of the policy.
 */
router.post('/conversations/direct', wrap(async (req, res) => {
  const me = actor(req);
  const peerId = String(req.body?.userId ?? '');
  if (!peerId) return res.status(400).json(fail('A user id is required.'));

  const existing = await chat.findDirect(me.id, peerId);
  if (!existing && !me.permissions.has('DM_START')) {
    return res.status(403).json(fail('You do not have permission to start a direct message.'));
  }
  if (!existing) {
    const allowed = await chat.contactAllowed(me.id, peerId);
    if (!allowed) {
      return res.status(403).json(fail('You are not permitted to message this person.'));
    }
  }

  const conversation = await chat.openDirect(me.id, peerId, await chat.defaultSpaceFor(me.id));
  // The other person's sidebar has to show the new conversation without a
  // reload — otherwise the first message they hear about is one they cannot
  // find.
  await announceConversation(conversation.id);
  res.json(ok({ conversation }));
}));

router.patch('/conversations/:id/prefs', wrap(async (req, res) => {
  const me = actor(req);
  const id = req.params.id!;
  await chat.requireMembership(me.id, id);

  const { isStarred, notification, mutedUntil } = req.body ?? {};
  if (notification !== undefined && !NOTIFICATION_LEVELS.includes(notification)) {
    return res.status(400).json(fail('That is not a notification level.'));
  }

  await chat.setMemberPrefs(me.id, id, {
    isStarred: typeof isStarred === 'boolean' ? isStarred : undefined,
    notification: notification as NotificationLevel | undefined,
    mutedUntil: mutedUntil === undefined ? undefined : mutedUntil,
  });

  // Preferences are per-person, so this goes to the user's own room — every
  // device they have open, and nobody else's.
  emitToUsers([me.id], 'conversation:prefs', {
    conversationId: id, isStarred, notification, mutedUntil,
  });

  res.json(ok({ conversation: await chat.getConversation(me.id, id) }));
}));

router.put('/conversations/:id/draft', wrap(async (req, res) => {
  const me = actor(req);
  const id = req.params.id!;
  await chat.requireMembership(me.id, id);
  const draft = typeof req.body?.draft === 'string' ? req.body.draft : null;
  await chat.saveDraft(me.id, id, draft);
  emitToUsers([me.id], 'conversation:draft', {
    conversationId: id, draft, at: new Date().toISOString(),
  });
  res.json(ok({ saved: true }));
}));

router.get('/conversations/:id/members', wrap(async (req, res) => {
  const me = actor(req);
  const id = req.params.id!;
  await chat.requireMembership(me.id, id);

  const members = await chat.listMembers(id);
  const ids = members.map((m) => m.userId);
  const [online, lastSeen] = await Promise.all([presenceFor(ids), lastSeenFor(ids)]);

  const roster = members.map((m) => withPresence(m, m.userId, online, lastSeen));

  /*
   * "3 of 12 online" for the header.
   *
   * Counted here, from the same mget that was already happening, rather than
   * pushed: presence is fanned out to DM counterparts only, precisely so that
   * a 400-member channel does not get a packet every time somebody switches
   * tab. A count that is pulled when the panel is open costs one round trip
   * and contradicts nothing.
   */
  res.json(ok({
    members: roster,
    onlineCount: roster.filter((m) => m.presence !== 'offline').length,
    memberCount: roster.length,
  }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Messages
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/conversations/:id/messages', authorizePermission('MESSAGE_READ'),
  wrap(async (req, res) => {
    const me = actor(req);
    const id = req.params.id!;
    await chat.requireMembership(me.id, id);

    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    const page = await chat.listMessages(me.id, id, {
      before: num(req.query.before),
      after: num(req.query.after),
      limit: num(req.query.limit),
      threadRootId: typeof req.query.thread === 'string' ? req.query.thread : undefined,
    });

    res.json(ok(page));
  }));

/**
 * Send over REST.
 *
 * Same service call the socket handler makes. `created: false` means the nonce
 * matched a message that already exists — the client gets 200 and the original
 * message back, and nothing is broadcast a second time.
 */
router.post('/conversations/:id/messages', authorizePermission('MESSAGE_SEND'),
  wrap(async (req, res) => {
    const me = actor(req);
    const id = req.params.id!;
    const membership = await chat.requireMembership(me.id, id);

    if (membership.isArchived) {
      return res.status(409).json(fail('This conversation is archived.'));
    }
    // Announcement channels are read-only unless you are one of the announcers.
    if (membership.type === 'announcement'
        && !me.permissions.has('CHANNEL_ANNOUNCE')
        && !chat.canManage(membership.role)) {
      return res.status(403).json(fail('Only announcers can post in this channel.'));
    }

    const { body, nonce, type, threadRootId, replyToId, attachments, metadata } = req.body ?? {};
    if (!nonce || typeof nonce !== 'string') {
      return res.status(400).json(fail('A nonce is required so a retry cannot duplicate.'));
    }

    const result = await chat.sendMessage({
      conversationId: id,
      senderId: me.id,
      body: String(body ?? ''),
      nonce,
      type,
      threadRootId: threadRootId ?? null,
      replyToId: replyToId ?? null,
      attachments: Array.isArray(attachments) ? attachments : [],
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
    });

    if (result.created) {
      await fanOutNewMessage(id, result, {
        name: membership.name ?? 'a conversation',
        type: membership.type,
        senderMayBroadcast: me.permissions.has('CHANNEL_ANNOUNCE'),
      });
    }

    res.status(result.created ? 201 : 200).json(ok({
      message: result.message, duplicate: !result.created,
    }));
  }));

/**
 * Broadcast a new message and refresh everyone's badge.
 *
 * Two separate emits on purpose. The message goes to the conversation room —
 * whoever has it open. The unread counter goes to each member's *user* room,
 * because the entire point of a sidebar badge is that it updates for the
 * channel you do not currently have open, on every device you own.
 */
async function fanOutNewMessage(
  conversationId: string, result: chat.SendResult,
  context: { name: string; type: string; senderMayBroadcast: boolean },
): Promise<void> {
  emitToConversation(conversationId, 'message:new', {
    conversationId, message: result.message,
  });

  // Queued, not awaited: fetching somebody else's server is not allowed to be
  // in the way of the message appearing.
  void enqueueUnfurl({
    conversationId,
    messageId: result.message.id,
    senderId: result.message.senderId,
    body: result.message.body,
  });

  // Who gets *told*, as opposed to who gets the socket event, is a different
  // question with different rules — see packages/chat/src/notifications.ts.
  await chat.notifyNewMessage(result.message, {
    conversationName: context.name,
    conversationType: context.type,
    mentionedUserIds: result.mentionedUserIds,
    broadcast: result.broadcast,
    senderMayBroadcast: context.senderMayBroadcast,
  }).catch(() => { /* a missed notification must not fail the send */ });

  const members = await chat.memberIdsOf(conversationId);
  const others = members.filter((m) => m !== result.message.senderId);
  const counts = await chat.unreadFor(others, conversationId);
  for (const [userId, c] of Object.entries(counts)) {
    emitToUsers([userId], 'conversation:unread', {
      conversationId, unread: c.unread, unreadMentions: c.unreadMentions,
      lastReadSeq: c.lastReadSeq,
    });
  }
}

router.post('/conversations/:id/read', wrap(async (req, res) => {
  const me = actor(req);
  const id = req.params.id!;
  await chat.requireMembership(me.id, id);

  const seq = Number(req.body?.seq);
  if (!Number.isFinite(seq)) return res.status(400).json(fail('A sequence number is required.'));

  const result = await chat.advanceRead(me.id, id, seq);
  await chat.markRead(me.id, id, seq);

  // Other devices of the same person clear their badge too.
  emitToUsers([me.id], 'conversation:unread', {
    conversationId: id, unread: result.unread,
    unreadMentions: result.unreadMentions, lastReadSeq: result.lastReadSeq,
  });
  // And everyone in the room repaints this person's read marker.
  emitToConversation(id, 'read:update', {
    conversationId: id, userId: me.id, seq: result.lastReadSeq, at: new Date().toISOString(),
  });

  res.json(ok(result));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Reactions, edits, deletions
 * ────────────────────────────────────────────────────────────────────────── */

router.post('/conversations/:id/messages/:messageId/reactions', wrap(async (req, res) => {
  const me = actor(req);
  const { id, messageId } = req.params as { id: string; messageId: string };
  await chat.requireMembership(me.id, id);

  const result = await chat.toggleReaction(me.id, id, messageId, String(req.body?.emoji ?? ''));
  emitToConversation(id, 'message:reaction', {
    conversationId: id, messageId, reactions: result.reactions,
  });

  // Only on adding one. Un-reacting is not an event anyone needs telling about,
  // and notifying on both halves of a toggle would double every mis-click.
  if (result.added) {
    const message = await chat.getMessage(me.id, id, messageId);
    if (message) {
      await chat.notifyReaction(
        id, message, me.id, me.name, String(req.body?.emoji ?? ''),
      ).catch(() => {});
    }
  }

  res.json(ok(result));
}));

/** Who reacted with what — the hover card behind a reaction pill. */
router.get('/conversations/:id/messages/:messageId/reactions', wrap(async (req, res) => {
  const me = actor(req);
  const { id, messageId } = req.params as { id: string; messageId: string };
  await chat.requireMembership(me.id, id);
  const emoji = String(req.query.emoji ?? '');
  res.json(ok({ names: emoji ? await chat.reactorNames(messageId, emoji) : [] }));
}));

router.patch('/conversations/:id/messages/:messageId', authorizePermission('MESSAGE_EDIT_OWN'),
  wrap(async (req, res) => {
    const me = actor(req);
    const { id, messageId } = req.params as { id: string; messageId: string };
    const membership = await chat.requireMembership(me.id, id);
    if (membership.isArchived) {
      return res.status(409).json(fail('This conversation is archived.'));
    }

    const { message, newlyMentioned } = await chat.editMessage(
      me.id, id, messageId, String(req.body?.body ?? ''),
    );

    emitToConversation(id, 'message:updated', { conversationId: id, message });
    // Editing a message to add an @mention has to reach the person mentioned —
    // otherwise "sorry, meant to tag you" silently never arrives.
    if (newlyMentioned.length) {
      await chat.notifyMention(message, newlyMentioned, membership.name ?? 'a conversation');
    }
    res.json(ok({ message }));
  }));

router.get('/conversations/:id/messages/:messageId/history', wrap(async (req, res) => {
  const me = actor(req);
  const { id, messageId } = req.params as { id: string; messageId: string };
  await chat.requireMembership(me.id, id);
  res.json(ok({ versions: await chat.editHistory(id, messageId) }));
}));

router.delete('/conversations/:id/messages/:messageId', wrap(async (req, res) => {
  const me = actor(req);
  const { id, messageId } = req.params as { id: string; messageId: string };
  const membership = await chat.requireMembership(me.id, id);

  const result = await chat.deleteMessage(me.id, id, messageId, {
    canDeleteAny: me.permissions.has('MESSAGE_DELETE_ANY'),
    memberRole: membership.role,
  });

  // Removing someone else's words is always on the record (FR-MSG-9). A
  // moderation power with no trail is indistinguishable from censorship.
  if (result.byModerator) {
    await audit({
      actorId: me.id,
      action: 'chat.message.delete_other',
      targetType: 'message',
      targetId: messageId,
      metadata: { conversationId: id, authorId: result.senderId, seq: result.seq },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  emitToConversation(id, 'message:deleted', {
    conversationId: id, messageId, deletedBy: me.id, byModerator: result.byModerator,
  });

  // Deleting a message changes everyone's unread arithmetic.
  const members = await chat.memberIdsOf(id);
  const counts = await chat.unreadFor(members, id);
  for (const [userId, c] of Object.entries(counts)) {
    emitToUsers([userId], 'conversation:unread', {
      conversationId: id, unread: c.unread, unreadMentions: c.unreadMentions,
      lastReadSeq: c.lastReadSeq,
    });
  }

  res.json(ok({ deleted: true, byModerator: result.byModerator }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Threads
 * ────────────────────────────────────────────────────────────────────────── */

router.post('/conversations/:id/messages/:messageId/replies',
  authorizePermission('MESSAGE_SEND'), wrap(async (req, res) => {
    const me = actor(req);
    const { id, messageId } = req.params as { id: string; messageId: string };
    const membership = await chat.requireMembership(me.id, id);
    if (membership.isArchived) return res.status(409).json(fail('This conversation is archived.'));

    const { body, nonce, attachments, alsoSendToChannel } = req.body ?? {};
    if (!nonce) return res.status(400).json(fail('A nonce is required.'));

    const { reply, echo, root } = await chat.replyInThread({
      conversationId: id, senderId: me.id, threadRootId: messageId,
      body: String(body ?? ''), nonce,
      attachments: Array.isArray(attachments) ? attachments : [],
      alsoSendToChannel: alsoSendToChannel === true,
    });

    if (reply.created) {
      emitToConversation(id, 'thread:reply', {
        conversationId: id, rootId: root?.id ?? messageId, message: reply.message,
      });
      // The parent's "N replies" affordance changed for everyone looking at the
      // main flow, even those who never opened the thread.
      if (root) emitToConversation(id, 'message:updated', { conversationId: id, message: root });

      /*
       * A thread reply notifies the people who have written in it.
       *
       * Participation is the subscription. A "follow" button people cannot see
       * means threads notify nobody; notifying the whole channel means threads
       * are no quieter than the room, which is the one thing they exist to be.
       */
      const followers = await chat.threadParticipants(id, root?.id ?? messageId);
      await chat.notifyNewMessage(reply.message, {
        conversationName: membership.name ?? 'a conversation',
        conversationType: membership.type,
        mentionedUserIds: [...new Set([...reply.mentionedUserIds, ...followers])],
        broadcast: reply.broadcast,
        senderMayBroadcast: me.permissions.has('CHANNEL_ANNOUNCE'),
      }).catch(() => {});
    }

    if (echo?.created) {
      await fanOutNewMessage(id, echo, {
        name: membership.name ?? 'a conversation',
        type: membership.type,
        senderMayBroadcast: me.permissions.has('CHANNEL_ANNOUNCE'),
      });
    }

    res.status(reply.created ? 201 : 200).json(ok({
      message: reply.message, root, duplicate: !reply.created,
    }));
  }));

/* ────────────────────────────────────────────────────────────────────────── *
 * Pins
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/conversations/:id/pins', wrap(async (req, res) => {
  const me = actor(req);
  await chat.requireMembership(me.id, req.params.id!);
  res.json(ok({ messages: await chat.listPinned(me.id, req.params.id!) }));
}));

router.post('/conversations/:id/messages/:messageId/pin',
  authorizePermission('MESSAGE_PIN'), wrap(async (req, res) => {
    const me = actor(req);
    const { id, messageId } = req.params as { id: string; messageId: string };
    await chat.requireMembership(me.id, id);

    const pinned = req.body?.pinned !== false;
    const message = await chat.setPinned(me.id, id, messageId, pinned);

    emitToConversation(id, 'message:updated', { conversationId: id, message });
    // A pin is a statement to the room, so the room is told in the log as well
    // as in the pinned list — otherwise pinning is invisible to anyone not
    // looking at the header.
    await announce(id, me.id,
      `${me.name} ${pinned ? 'pinned' : 'unpinned'} a message.`,
      { event: pinned ? 'pinned' : 'unpinned', messageId });

    res.json(ok({ message, pinned }));
  }));

/* ────────────────────────────────────────────────────────────────────────── *
 * Saved items
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/saved', wrap(async (req, res) => {
  const me = actor(req);
  res.json(ok({ items: await chat.listSaved(me.id, Number(req.query.limit ?? 50)) }));
}));

router.post('/conversations/:id/messages/:messageId/save', wrap(async (req, res) => {
  const me = actor(req);
  const { id, messageId } = req.params as { id: string; messageId: string };
  await chat.requireMembership(me.id, id);
  const saved = req.body?.saved !== false;
  await chat.setSaved(me.id, id, messageId, saved);
  // Saving is personal, so only this person's other devices hear about it.
  emitToUsers([me.id], 'message:updated', {
    conversationId: id,
    message: await chat.getMessage(me.id, id, messageId),
  });
  res.json(ok({ saved }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Forwarding
 * ────────────────────────────────────────────────────────────────────────── */

router.post('/conversations/:id/messages/:messageId/forward',
  authorizePermission('MESSAGE_FORWARD'), wrap(async (req, res) => {
    const me = actor(req);
    const { id, messageId } = req.params as { id: string; messageId: string };
    const targets = Array.isArray(req.body?.conversationIds) ? req.body.conversationIds : [];
    if (!targets.length) return res.status(400).json(fail('Choose where to forward it.'));

    const results = await chat.forwardMessage(
      me.id, id, messageId, targets, typeof req.body?.comment === 'string' ? req.body.comment : undefined,
    );

    for (const { conversationId, result } of results) {
      const target = await chat.requireMembership(me.id, conversationId);
      await fanOutNewMessage(conversationId, result, {
        name: target.name ?? 'a conversation',
        type: target.type,
        senderMayBroadcast: me.permissions.has('CHANNEL_ANNOUNCE'),
      });
    }

    res.json(ok({ forwarded: results.map((r) => r.conversationId) }));
  }));

/* ────────────────────────────────────────────────────────────────────────── *
 * Permalinks and jump-to-message
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/conversations/:id/messages/:messageId/context',
  authorizePermission('MESSAGE_READ'), wrap(async (req, res) => {
    const me = actor(req);
    const { id, messageId } = req.params as { id: string; messageId: string };
    await chat.requireMembership(me.id, id);
    const radius = Number(req.query.radius ?? 20);
    res.json(ok(await chat.messageContext(me.id, id, messageId,
      Number.isFinite(radius) ? radius : 20)));
  }));

/* ────────────────────────────────────────────────────────────────────────── *
 * Inline translation  (FR-MSG-25)
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/languages', wrap(async (_req, res) => {
  res.json(ok({ languages: SUPPORTED_LANGUAGES }));
}));

router.post('/conversations/:id/messages/:messageId/translate',
  authorizePermission('MESSAGE_READ'), wrap(async (req, res) => {
    const me = actor(req);
    const { id, messageId } = req.params as { id: string; messageId: string };
    // Membership first. Translation reads the message body, so it is a read of
    // the conversation and is authorised as one.
    await chat.requireMembership(me.id, id);

    const language = String(req.body?.language ?? '');
    if (!isSupportedLanguage(language)) {
      return res.status(400).json(fail('That is not a language Tupo translates into.'));
    }

    const message = await chat.getMessage(me.id, id, messageId);
    if (!message || message.deletedAt) return res.status(404).json(fail('Message not found.'));
    if (!message.body) return res.status(400).json(fail('There is nothing to translate.'));

    try {
      res.json(ok(await translateMessage(messageId, message.body, language)));
    } catch (err) {
      // A model being unavailable is a 503, not a 500: nothing is wrong with
      // the request and retrying later is the right advice.
      res.status(503).json(fail(
        err instanceof Error ? err.message : 'Translation is unavailable right now.'));
    }
  }));

/* ────────────────────────────────────────────────────────────────────────── *
 * Preferences and badges
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/prefs', wrap(async (req, res) => {
  res.json(ok({ prefs: await chat.getPrefs(actor(req).id) }));
}));

router.patch('/prefs', authorizePermission('SETTINGS_MANAGE'), wrap(async (req, res) => {
  const me = actor(req);
  const body = req.body ?? {};

  // Whitelisted field by field. A settings endpoint that spreads the request
  // body into an update is one typo away from being a way to set anything.
  const patch: Parameters<typeof chat.setPrefs>[1] = {};
  const bool = (k: string) => (typeof body[k] === 'boolean' ? body[k] as boolean : undefined);
  const num = (k: string) => (typeof body[k] === 'number' || body[k] === null
    ? body[k] as number | null : undefined);

  if (bool('readReceipts') !== undefined) patch.readReceipts = bool('readReceipts');
  if (bool('enterToSend') !== undefined) patch.enterToSend = bool('enterToSend');
  if (bool('desktopNotifications') !== undefined) patch.desktopNotifications = bool('desktopNotifications');
  if (bool('sound') !== undefined) patch.sound = bool('sound');
  if (bool('showPresence') !== undefined) patch.showPresence = bool('showPresence');
  if (num('quietFromMinute') !== undefined) patch.quietFromMinute = num('quietFromMinute');
  if (num('quietToMinute') !== undefined) patch.quietToMinute = num('quietToMinute');
  if (typeof body.timezone === 'string') patch.timezone = body.timezone.slice(0, 64);
  if (NOTIFICATION_LEVELS.includes(body.defaultLevel)) {
    patch.defaultLevel = body.defaultLevel as NotificationLevel;
  }

  res.json(ok({ prefs: await chat.setPrefs(me.id, patch) }));
}));

/**
 * The badge on the Chat icon in the rail.
 *
 * One number for the whole module, so the shell does not have to load every
 * conversation to know whether to show a dot.
 */
router.get('/unread', wrap(async (req, res) => {
  res.json(ok(await chat.totalUnread(actor(req).id)));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Search
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/search', authorizePermission('MESSAGE_READ'), wrap(async (req, res) => {
  const me = actor(req);
  const q = String(req.query.q ?? '');
  const str = (k: string) => (typeof req.query[k] === 'string' ? req.query[k] as string : undefined);
  const num = (k: string) => {
    const n = Number(req.query[k]);
    return Number.isFinite(n) ? n : undefined;
  };

  res.json(ok(await chat.searchMessages(me.id, q, {
    conversationId: str('conversationId'),
    fromUserId: str('from'),
    after: str('after'),
    before: str('before'),
    hasFile: req.query.hasFile === 'true',
    limit: num('limit'),
    offset: num('offset'),
  })));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Scheduled send
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/scheduled', wrap(async (req, res) => {
  res.json(ok({ scheduled: await chat.listScheduled(actor(req).id) }));
}));

router.post('/conversations/:id/scheduled', authorizePermission('MESSAGE_SCHEDULE'),
  wrap(async (req, res) => {
    const me = actor(req);
    const id = req.params.id!;
    const membership = await chat.requireMembership(me.id, id);
    if (membership.isArchived) return res.status(409).json(fail('This conversation is archived.'));

    const at = new Date(String(req.body?.sendAt ?? ''));
    const scheduled = await chat.scheduleMessage(
      me.id, id, String(req.body?.body ?? ''), at,
      Array.isArray(req.body?.attachments) ? req.body.attachments : [],
    );
    res.status(201).json(ok({ scheduled }));
  }));

router.delete('/scheduled/:id', wrap(async (req, res) => {
  const cancelled = await chat.cancelScheduled(actor(req).id, req.params.id!);
  if (!cancelled) return res.status(404).json(fail('Nothing pending with that id.'));
  res.json(ok({ cancelled: true }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Polls
 * ────────────────────────────────────────────────────────────────────────── */

router.post('/conversations/:id/polls', authorizePermission('MESSAGE_SEND'),
  wrap(async (req, res) => {
    const me = actor(req);
    const id = req.params.id!;
    const membership = await chat.requireMembership(me.id, id);
    if (membership.isArchived) return res.status(409).json(fail('This conversation is archived.'));
    if (membership.type === 'announcement'
        && !me.permissions.has('CHANNEL_ANNOUNCE')
        && !chat.canManage(membership.role)) {
      return res.status(403).json(fail('Only announcers can post in this channel.'));
    }

    const { poll, message } = await chat.createPoll(me.id, id, {
      question: String(req.body?.question ?? ''),
      options: Array.isArray(req.body?.options) ? req.body.options : [],
      multiChoice: req.body?.multiChoice === true,
      anonymous: req.body?.anonymous === true,
      closesAt: req.body?.closesAt ?? null,
    });

    // The poll is a message, so it fans out as one — and notifies as one.
    emitToConversation(id, 'message:new', { conversationId: id, message });
    emitToConversation(id, 'poll:updated', { conversationId: id, poll });
    res.status(201).json(ok({ poll, message }));
  }));

router.get('/conversations/:id/messages/:messageId/poll', wrap(async (req, res) => {
  const me = actor(req);
  const { id, messageId } = req.params as { id: string; messageId: string };
  await chat.requireMembership(me.id, id);
  const poll = await chat.getPollByMessage(me.id, messageId);
  if (!poll) return res.status(404).json(fail('No poll on that message.'));
  res.json(ok({ poll }));
}));

router.post('/polls/:pollId/vote', wrap(async (req, res) => {
  const me = actor(req);
  const options = Array.isArray(req.body?.optionIds) ? req.body.optionIds.map(String) : [];
  const poll = await chat.votePoll(me.id, req.params.pollId!, options);

  const { rows } = await getPool().query<{ conversation_id: string }>(
    'SELECT conversation_id FROM polls WHERE id = $1', [req.params.pollId]);
  if (rows[0]) {
    // Everyone sees the bars move. A poll whose results only update on reload
    // is a poll people vote in twice.
    emitToConversation(rows[0].conversation_id, 'poll:updated', {
      conversationId: rows[0].conversation_id, poll,
    });
  }
  res.json(ok({ poll }));
}));

router.post('/polls/:pollId/close', wrap(async (req, res) => {
  const me = actor(req);
  const poll = await chat.closePoll(me.id, req.params.pollId!);
  const { rows } = await getPool().query<{ conversation_id: string }>(
    'SELECT conversation_id FROM polls WHERE id = $1', [req.params.pollId]);
  if (rows[0]) {
    emitToConversation(rows[0].conversation_id, 'poll:updated', {
      conversationId: rows[0].conversation_id, poll,
    });
  }
  res.json(ok({ poll }));
}));

router.post('/read-all', wrap(async (req, res) => {
  const me = actor(req);
  const cleared = await chat.markAllConversationsRead(me.id);
  // Every device this person owns clears at once — the point of the action is
  // that the badge is gone everywhere, not just where it was pressed.
  const conversations = await chat.listConversations(me.id);
  for (const c of conversations) {
    emitToUsers([me.id], 'conversation:unread', {
      conversationId: c.id, unread: c.unread,
      unreadMentions: c.unreadMentions, lastReadSeq: c.lastReadSeq,
    });
  }
  res.json(ok({ cleared }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Channel discovery and membership
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/browse', authorizePermission('CHANNEL_VIEW'), wrap(async (req, res) => {
  const me = actor(req);
  res.json(ok({
    channels: await chat.discoverChannels(me.id, {
      query: typeof req.query.q === 'string' ? req.query.q : undefined,
      limit: Number(req.query.limit ?? 40),
    }),
  }));
}));

router.post('/conversations/:id/join', authorizePermission('CHANNEL_JOIN'),
  wrap(async (req, res) => {
    const me = actor(req);
    const id = req.params.id!;
    const conversation = await chat.joinChannel(me.id, id);

    await announce(id, me.id, `${me.name} joined the channel.`, { event: 'joined' });
    emitToConversation(id, 'conversation:member_changed', {
      conversationId: id, userId: me.id, action: 'joined', memberCount: conversation.memberCount,
    });
    await announceConversation(id);

    res.json(ok({ conversation }));
  }));

router.post('/conversations/:id/members', authorizePermission('CHANNEL_MEMBERS_MANAGE'),
  wrap(async (req, res) => {
    const me = actor(req);
    const id = req.params.id!;
    const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds.map(String) : [];

    const { added, memberCount } = await chat.addMembersTo(me.id, id, userIds);
    if (added.length) {
      const names = await chat.namesOf(added);
      await announce(id, me.id,
        `${me.name} added ${names.join(', ')}.`, { event: 'added', userIds: added });
      for (const userId of added) {
        emitToConversation(id, 'conversation:member_changed', {
          conversationId: id, userId, action: 'joined', memberCount,
        });
      }
      // The people just added need it in their sidebar without a reload.
      await announceConversation(id);
    }

    res.json(ok({ added, memberCount }));
  }));

router.delete('/conversations/:id/members/:userId', wrap(async (req, res) => {
  const me = actor(req);
  const { id, userId } = req.params as { id: string; userId: string };
  const leaving = userId === me.id;

  if (!leaving && !me.permissions.has('CHANNEL_MEMBERS_MANAGE')) {
    return res.status(403).json(fail('You cannot remove people from this conversation.'));
  }

  const target = leaving ? me.name : (await chat.namesOf([userId]))[0] ?? 'Someone';
  const { memberCount } = await chat.removeMember(me.id, id, userId);

  await announce(id, me.id,
    leaving ? `${me.name} left the channel.` : `${me.name} removed ${target}.`,
    { event: leaving ? 'left' : 'removed', userId });
  emitToConversation(id, 'conversation:member_changed', {
    conversationId: id, userId, action: leaving ? 'left' : 'removed', memberCount,
  });

  if (!leaving) {
    await audit({
      actorId: me.id, action: 'chat.member.remove', targetType: 'conversation', targetId: id,
      metadata: { removed: userId }, ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });
  }

  res.json(ok({ removed: true, memberCount }));
}));

router.patch('/conversations/:id/members/:userId', authorizePermission('CHANNEL_MEMBERS_MANAGE'),
  wrap(async (req, res) => {
    const me = actor(req);
    const { id, userId } = req.params as { id: string; userId: string };
    const role = String(req.body?.role ?? '');
    if (!MEMBER_ROLES.includes(role as never)) {
      return res.status(400).json(fail('That is not a channel role.'));
    }

    await chat.setMemberRole(me.id, id, userId, role as never);
    emitToConversation(id, 'conversation:member_changed', {
      conversationId: id, userId, action: 'role_changed', role,
      memberCount: (await chat.getConversation(me.id, id)).memberCount,
    });
    res.json(ok({ role }));
  }));

router.post('/conversations/:id/transfer', wrap(async (req, res) => {
  const me = actor(req);
  const id = req.params.id!;
  const targetId = String(req.body?.userId ?? '');

  await chat.transferOwnership(me.id, id, targetId);
  const name = (await chat.namesOf([targetId]))[0] ?? 'someone else';
  await announce(id, me.id, `${me.name} made ${name} the owner.`, { event: 'ownership' });
  await audit({
    actorId: me.id, action: 'chat.ownership.transfer', targetType: 'conversation', targetId: id,
    metadata: { to: targetId }, ipAddress: req.ip, userAgent: req.headers['user-agent'],
  });
  await announceConversation(id);
  res.json(ok({ transferred: true }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Channel settings, archiving, retention
 * ────────────────────────────────────────────────────────────────────────── */

router.patch('/conversations/:id', authorizePermission('CHANNEL_MANAGE'), wrap(async (req, res) => {
  const me = actor(req);
  const id = req.params.id!;
  const body = req.body ?? {};

  const conversation = await chat.updateConversation(me.id, id, {
    name: typeof body.name === 'string' ? body.name : undefined,
    topic: body.topic === undefined ? undefined : (body.topic ?? null),
    description: body.description === undefined ? undefined : (body.description ?? null),
    iconEmoji: body.iconEmoji === undefined ? undefined : (body.iconEmoji ?? null),
    avatarColor: body.avatarColor === undefined ? undefined : (body.avatarColor ?? null),
    avatarFileId: body.avatarFileId === undefined ? undefined : (body.avatarFileId ?? null),
    isPrivate: body.isPrivate === true ? true : undefined,
  });

  if (typeof body.topic === 'string') {
    await announce(id, me.id, `${me.name} set the topic: ${body.topic}`, { event: 'topic' });
  }
  await announceConversation(id);
  res.json(ok({ conversation }));
}));

router.post('/conversations/:id/archive', authorizePermission('CHANNEL_ARCHIVE'),
  wrap(async (req, res) => {
    const me = actor(req);
    const id = req.params.id!;
    const archived = req.body?.archived !== false;

    const conversation = await chat.setArchived(me.id, id, archived);
    await announce(id, me.id,
      archived
        ? `${me.name} archived this channel. It is now read-only.`
        : `${me.name} reopened this channel.`,
      { event: archived ? 'archived' : 'unarchived' });
    await audit({
      actorId: me.id,
      action: archived ? 'chat.channel.archive' : 'chat.channel.unarchive',
      targetType: 'conversation', targetId: id,
      ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });
    await announceConversation(id);
    res.json(ok({ conversation }));
  }));

router.post('/conversations/:id/retention', authorizePermission('RETENTION_MANAGE', 'CHANNEL_MANAGE'),
  wrap(async (req, res) => {
    const me = actor(req);
    const id = req.params.id!;
    const days = req.body?.days === null ? null : Number(req.body?.days);

    const conversation = await chat.setRetention(me.id, id, days);
    await announce(id, me.id,
      days === null
        ? `${me.name} turned off disappearing messages.`
        : `${me.name} set messages to disappear after ${days === 1 ? '24 hours' : `${days} days`}.`,
      { event: 'retention', days });
    await audit({
      actorId: me.id, action: 'chat.retention.set', targetType: 'conversation', targetId: id,
      metadata: { days }, ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });
    res.json(ok({ conversation }));
  }));

/* ────────────────────────────────────────────────────────────────────────── *
 * Invite links
 * ────────────────────────────────────────────────────────────────────────── */

router.post('/conversations/:id/invites', authorizePermission('CHANNEL_MEMBERS_MANAGE'),
  wrap(async (req, res) => {
    const me = actor(req);
    const invite = await chat.createInvite(me.id, req.params.id!, {
      expiresInHours: Number(req.body?.expiresInHours) || null,
      maxUses: Number(req.body?.maxUses) || null,
    });
    res.status(201).json(ok({ invite }));
  }));

router.post('/invites/:code/redeem', authorizePermission('CHANNEL_JOIN'), wrap(async (req, res) => {
  const me = actor(req);
  const conversation = await chat.redeemInvite(me.id, req.params.code!);
  await announce(conversation.id, me.id,
    `${me.name} joined via an invite link.`, { event: 'joined' });
  await announceConversation(conversation.id);
  res.json(ok({ conversation }));
}));

router.delete('/invites/:code', wrap(async (req, res) => {
  const revoked = await chat.revokeInvite(actor(req).id, req.params.code!);
  if (!revoked) return res.status(404).json(fail('No such invite.'));
  res.json(ok({ revoked: true }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Profiles and custom status
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/profile/:userId', authorizePermission('DIRECTORY_VIEW'), wrap(async (req, res) => {
  const me = actor(req);
  const profile = await chat.getProfile(me.id, req.params.userId!);
  const online = await presenceFor([profile.id]);
  const seen = await lastSeenFor([profile.id]);
  res.json(ok({ profile: withPresence(profile, profile.id, online, seen) }));
}));

router.put('/status', authorizePermission('SETTINGS_MANAGE'), wrap(async (req, res) => {
  const me = actor(req);
  const body = req.body ?? {};
  const profile = await chat.setStatus(me.id, {
    emoji: typeof body.emoji === 'string' ? body.emoji : null,
    text: typeof body.text === 'string' ? body.text : null,
    expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
  });
  res.json(ok({ profile }));
}));

router.patch('/profile', authorizePermission('SETTINGS_MANAGE'), wrap(async (req, res) => {
  const me = actor(req);
  const body = req.body ?? {};
  const profile = await chat.updateProfile(me.id, {
    title: body.title === undefined ? undefined : (body.title ?? null),
    pronouns: body.pronouns === undefined ? undefined : (body.pronouns ?? null),
    timezone: body.timezone === undefined ? undefined : (body.timezone ?? null),
  });
  res.json(ok({ profile }));
}));

export default router;


