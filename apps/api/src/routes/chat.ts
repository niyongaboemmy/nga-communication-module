import { Router, type Request, type Response, type NextFunction } from 'express';
import { Redis } from 'ioredis';
import { getPool } from '@tupo/db';
import { ok, fail } from '@tupo/shared';
import type { NotificationLevel } from '@tupo/shared';
import { NOTIFICATION_LEVELS, CONVERSATION_TYPES } from '@tupo/shared';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { config } from '../config.js';
import * as chat from '@tupo/chat';
import { ChatError } from '@tupo/chat';
import { emitToConversation, emitToUsers } from '../services/chatRealtime.js';

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
    const values = await client.mget(userIds.map((id) => `presence:${id}`));
    userIds.forEach((id, i) => { out[id] = values[i] ?? 'offline'; });
  } catch { /* everyone reads as offline */ }
  return out;
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
    id: string; name: string; avatar_url: string | null; role: string;
  }>(
    `SELECT id, name, avatar_url, role
       FROM users
      WHERE id <> $1 AND status = 'active'
        AND ($2 = '' OR name ILIKE '%' || $2 || '%')
        -- Someone who blocked you, or whom you blocked, is not in your picker.
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = users.id AND b.blocked_id = $1)
              OR (b.blocker_id = $1 AND b.blocked_id = users.id))
      ORDER BY name ASC
      LIMIT $3`,
    [me.id, q, limit],
  );

  const online = await presenceFor(rows.map((r) => r.id));
  res.json(ok({
    people: rows.map((r) => ({
      id: r.id, name: r.name, avatarUrl: r.avatar_url, role: r.role,
      presence: online[r.id] ?? 'offline',
    })),
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
  const online = await presenceFor(peerIds);

  res.json(ok({
    conversations: conversations.map((c) => ({
      ...c,
      peer: c.peer ? { ...c.peer, presence: online[c.peer.id] ?? 'offline' } : null,
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

  await chat.systemMessage(conversation.id, me.id,
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
  const online = await presenceFor(members.map((m) => m.userId));
  res.json(ok({
    members: members.map((m) => ({ ...m, presence: online[m.userId] ?? 'offline' })),
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

    if (result.created) await fanOutNewMessage(id, result);

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
): Promise<void> {
  emitToConversation(conversationId, 'message:new', {
    conversationId, message: result.message,
  });

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

export default router;
