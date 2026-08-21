import { getPool, snowflake } from '@tupo/db';
import type { PoolClient } from 'pg';
import {
  DEFAULT_PAGE_SIZE, MAX_MESSAGE_LENGTH, MAX_PAGE_SIZE, MENTION_PATTERN,
  BROADCAST_MENTION_PATTERN,
} from '@tupo/shared';
import type {
  ConversationSummary, ConversationType, DeliveryState, MemberRole, MessagePage,
  MessageType, NotificationLevel, WireAttachment, WireMember, WireMessage, WireReaction,
} from '@tupo/shared';

/**
 * Chat — the one place messages are written.
 *
 * Both the REST routes and the socket gateway call these functions rather than
 * writing their own SQL, so there is exactly one implementation of "send a
 * message" and it cannot drift between the two transports. Authorisation is
 * enforced *here*, not in the routes, for the same reason: a socket handler
 * that forgot to check membership would otherwise be a hole in a system whose
 * REST equivalent looked fine.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Errors
 * ────────────────────────────────────────────────────────────────────────── */

/** Carries the HTTP status the route should return, so routes stay dumb. */
export class ChatError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'ChatError';
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Membership
 * ────────────────────────────────────────────────────────────────────────── */

export interface Membership {
  conversationId: string;
  userId: string;
  role: MemberRole;
  lastReadSeq: number;
  notification: NotificationLevel;
  type: ConversationType;
  isArchived: boolean;
  isPrivate: boolean;
  name: string | null;
}

/**
 * The single authorisation primitive: is this person a live member of this
 * conversation, and what may they do in it?
 *
 * `left_at IS NULL` matters — leaving a channel keeps the row for history, and
 * a former member must not keep reading. Every read and every write goes
 * through here.
 */
export async function requireMembership(
  userId: string, conversationId: string, client?: PoolClient,
): Promise<Membership> {
  const db = client ?? getPool();
  const { rows } = await db.query<{
    role: MemberRole; last_read_seq: string; notification: NotificationLevel;
    type: ConversationType; is_archived: boolean; is_private: boolean; name: string | null;
  }>(
    `SELECT m.role, m.last_read_seq, m.notification,
            c.type, c.is_archived, c.is_private, c.name
       FROM conversation_members m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = $1 AND m.user_id = $2
        AND m.left_at IS NULL AND c.deleted_at IS NULL`,
    [conversationId, userId],
  );
  const row = rows[0];
  // 404 rather than 403 for a non-member of a private conversation: telling
  // someone a private channel exists is itself a disclosure.
  if (!row) throw new ChatError('Conversation not found.', 404);

  return {
    conversationId, userId,
    role: row.role,
    lastReadSeq: Number(row.last_read_seq),
    notification: row.notification,
    type: row.type,
    isArchived: row.is_archived,
    isPrivate: row.is_private,
    name: row.name,
  };
}

/** Channel-role rank, for "may this person moderate that person" questions. */
const ROLE_RANK: Record<MemberRole, number> = {
  owner: 4, admin: 3, moderator: 2, member: 1, guest: 0,
};
export const canModerate = (role: MemberRole) => ROLE_RANK[role] >= ROLE_RANK.moderator;
export const canManage = (role: MemberRole) => ROLE_RANK[role] >= ROLE_RANK.admin;

/* ────────────────────────────────────────────────────────────────────────── *
 * Conversation listing
 * ────────────────────────────────────────────────────────────────────────── */

interface ConversationRow {
  id: string; type: ConversationType; slug: string | null; name: string | null;
  topic: string | null; description: string | null; is_private: boolean;
  is_archived: boolean; icon_emoji: string | null; avatar_color: string | null;
  member_count: number; last_seq: string;
  last_message_at: string | null; last_message_preview: string | null;
  last_message_sender: string | null; last_sender_name: string | null;
  my_role: MemberRole; unread_count: number; unread_mentions: number;
  last_read_seq: string; is_starred: boolean; notification: NotificationLevel;
  muted_until: string | null; draft: string | null;
  peer_id: string | null; peer_name: string | null;
  peer_avatar: string | null; peer_role: string | null;
}

/**
 * The sidebar, in one query.
 *
 * A DM has no name of its own — it is "the conversation with Aline", and who
 * that is depends on who is asking. The lateral join resolves the counterpart
 * per viewer so the client never has to special-case a nameless row, and so a
 * two-person conversation renders identically to a channel everywhere else.
 */
const CONVERSATION_SELECT = `
  SELECT c.id, c.type, c.slug, c.name, c.topic, c.description, c.is_private,
         c.is_archived, c.icon_emoji, c.avatar_color, c.member_count, c.last_seq,
         c.last_message_at, c.last_message_preview, c.last_message_sender,
         ls.name AS last_sender_name,
         m.role AS my_role, m.unread_count, m.unread_mentions, m.last_read_seq,
         m.is_starred, m.notification, m.muted_until, m.draft,
         peer.id AS peer_id, peer.name AS peer_name,
         peer.avatar_url AS peer_avatar, peer.role AS peer_role
    FROM conversation_members m
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN users ls ON ls.id = c.last_message_sender
    LEFT JOIN LATERAL (
      SELECT u.id, u.name, u.avatar_url, u.role
        FROM conversation_members pm
        JOIN users u ON u.id = pm.user_id
       WHERE pm.conversation_id = c.id AND pm.user_id <> m.user_id
             AND pm.left_at IS NULL
       LIMIT 1
    ) peer ON c.type = 'dm'
   WHERE m.user_id = $1 AND m.left_at IS NULL
     AND c.deleted_at IS NULL AND m.is_hidden = false`;

function toConversation(r: ConversationRow): ConversationSummary {
  const isDm = r.type === 'dm';
  return {
    id: r.id,
    type: r.type,
    name: isDm ? (r.peer_name ?? 'Direct message') : (r.name ?? 'Untitled'),
    slug: r.slug,
    topic: r.topic,
    description: r.description,
    isPrivate: r.is_private,
    isArchived: r.is_archived,
    iconEmoji: r.icon_emoji,
    avatarColor: r.avatar_color,
    avatarUrl: isDm ? r.peer_avatar : null,
    memberCount: r.member_count,
    lastSeq: Number(r.last_seq),
    myRole: r.my_role,
    unread: r.unread_count,
    unreadMentions: r.unread_mentions,
    lastReadSeq: Number(r.last_read_seq),
    isStarred: r.is_starred,
    notification: r.notification,
    mutedUntil: r.muted_until,
    draft: r.draft,
    peer: isDm && r.peer_id
      ? { id: r.peer_id, name: r.peer_name ?? '', avatarUrl: r.peer_avatar, role: r.peer_role }
      : null,
    lastMessage: r.last_message_at
      ? {
          at: r.last_message_at,
          preview: r.last_message_preview ?? '',
          senderId: r.last_message_sender,
          senderName: r.last_sender_name,
        }
      : null,
  };
}

export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  const { rows } = await getPool().query<ConversationRow>(
    `${CONVERSATION_SELECT}
     ORDER BY m.is_starred DESC,
              COALESCE(c.last_message_at, c.created_at) DESC`,
    [userId],
  );
  return rows.map(toConversation);
}

export async function getConversation(
  userId: string, conversationId: string,
): Promise<ConversationSummary> {
  const { rows } = await getPool().query<ConversationRow>(
    `${CONVERSATION_SELECT} AND c.id = $2`, [userId, conversationId],
  );
  if (!rows[0]) throw new ChatError('Conversation not found.', 404);
  return toConversation(rows[0]);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Creating conversations
 * ────────────────────────────────────────────────────────────────────────── */

export interface CreateConversationInput {
  spaceId: string;
  type: ConversationType;
  name?: string | null;
  topic?: string | null;
  description?: string | null;
  isPrivate?: boolean;
  iconEmoji?: string | null;
  avatarColor?: string | null;
  memberIds?: string[];
}

export async function createConversation(
  creatorId: string, input: CreateConversationInput,
): Promise<ConversationSummary> {
  const id = snowflake();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const slug = input.type === 'channel' || input.type === 'announcement'
      ? slugify(input.name ?? '')
      : null;

    if (slug) {
      const { rows: clash } = await client.query(
        `SELECT 1 FROM conversations
          WHERE space_id = $1 AND lower(slug) = lower($2) AND deleted_at IS NULL`,
        [input.spaceId, slug],
      );
      if (clash.length) throw new ChatError('A channel with that name already exists.', 409);
    }

    await client.query(
      `INSERT INTO conversations
         (id, space_id, type, slug, name, topic, description, is_private,
          icon_emoji, avatar_color, created_by, member_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0)`,
      [id, input.spaceId, input.type, slug, input.name ?? null, input.topic ?? null,
       input.description ?? null, input.isPrivate ?? false, input.iconEmoji ?? null,
       input.avatarColor ?? null, creatorId],
    );

    // The creator owns it; a DM has no owner, because there is no asymmetry of
    // power between two people talking.
    const creatorRole: MemberRole = input.type === 'dm' ? 'member' : 'owner';
    await addMembers(client, id, [{ userId: creatorId, role: creatorRole }]);

    const others = (input.memberIds ?? []).filter((u) => u && u !== creatorId);
    if (others.length) {
      await addMembers(client, id, others.map((userId) => ({ userId, role: 'member' as MemberRole })));
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getConversation(creatorId, id);
}

async function addMembers(
  client: PoolClient, conversationId: string,
  members: Array<{ userId: string; role: MemberRole }>,
): Promise<number> {
  if (!members.length) return 0;
  let added = 0;
  for (const m of members) {
    const { rowCount } = await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role)
       VALUES ($1,$2,$3)
       ON CONFLICT (conversation_id, user_id)
       -- Rejoining is an update, not an error: the historical row is reused so
       -- the person's old read watermark survives rather than resetting them to
       -- the top of a channel they have read before.
       DO UPDATE SET left_at = NULL, role = EXCLUDED.role, is_hidden = false
       WHERE conversation_members.left_at IS NOT NULL`,
      [conversationId, m.userId, m.role],
    );
    if (rowCount) added += 1;
  }
  await client.query(
    `UPDATE conversations SET member_count = (
       SELECT count(*) FROM conversation_members
        WHERE conversation_id = $1 AND left_at IS NULL)
     WHERE id = $1`,
    [conversationId],
  );
  return added;
}

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 60) || null;

/**
 * Open the DM between two people, creating it only if it does not exist.
 *
 * Idempotency is the whole point: clicking a name twice, or two devices doing it
 * at once, must land in the same conversation. The lookup is by *exact
 * membership set* rather than by any generated key, so it cannot be defeated by
 * a differently-ordered pair.
 */
export async function openDirect(
  userId: string, peerId: string, spaceId: string,
): Promise<ConversationSummary> {
  if (userId === peerId) throw new ChatError('You cannot open a direct message with yourself.', 400);

  const { rows: blocked } = await getPool().query(
    `SELECT 1 FROM user_blocks
      WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
    [userId, peerId],
  );
  if (blocked.length) throw new ChatError('You cannot message this person.', 403);

  const { rows: existing } = await getPool().query<{ id: string }>(
    `SELECT c.id
       FROM conversations c
       JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = $1
       JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = $2
      WHERE c.type = 'dm' AND c.deleted_at IS NULL
        AND (SELECT count(*) FROM conversation_members m
              WHERE m.conversation_id = c.id AND m.left_at IS NULL) = 2
      LIMIT 1`,
    [userId, peerId],
  );

  if (existing[0]) {
    // Reopening a DM you had hidden brings it back rather than making a second
    // one — otherwise "clear chat" quietly forks your history in two.
    await getPool().query(
      `UPDATE conversation_members SET is_hidden = false, left_at = NULL
        WHERE conversation_id = $1 AND user_id = $2`,
      [existing[0].id, userId],
    );
    return getConversation(userId, existing[0].id);
  }

  return createConversation(userId, { spaceId, type: 'dm', isPrivate: true, memberIds: [peerId] });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Sending
 * ────────────────────────────────────────────────────────────────────────── */

export interface SendMessageInput {
  conversationId: string;
  senderId: string;
  body: string;
  nonce: string;
  type?: MessageType;
  threadRootId?: string | null;
  replyToId?: string | null;
  attachments?: string[];
  metadata?: Record<string, unknown>;
  /** Set by the system-message helpers; skips permission and policy checks. */
  system?: boolean;
}

export interface SendResult {
  message: WireMessage;
  /** False when the nonce resolved to a message that already existed — the
   *  caller must not fan out a duplicate `message:new`. */
  created: boolean;
  mentionedUserIds: string[];
  broadcast: 'channel' | 'here' | null;
}

export async function sendMessage(input: SendMessageInput): Promise<SendResult> {
  const written = await writeMessage(input);

  /*
   * Read back AFTER the transaction's client is released.
   *
   * This used to happen inside the transaction, and it deadlocked the whole
   * API. `getMessage` takes its own connection from the pool; holding the
   * transaction's client while asking for a second one means that once
   * `max` concurrent sends are in flight, every one of them is holding a
   * connection and waiting for one that can never be freed. The pool never
   * recovers — every later request, including /health, queues behind it
   * forever. Nothing may acquire a second connection while holding one.
   */
  const message = await getMessage(input.senderId, input.conversationId, written.messageId);
  if (!message) throw new ChatError('Message could not be read back.', 500);

  return {
    message,
    created: written.created,
    mentionedUserIds: written.mentionedUserIds,
    broadcast: written.broadcast,
  };
}

interface WriteResult {
  messageId: string;
  created: boolean;
  mentionedUserIds: string[];
  broadcast: 'channel' | 'here' | null;
}

/**
 * The transactional half of a send: everything that must be atomic, and
 * nothing that is not.
 *
 * It returns an id rather than a message so that the single connection it
 * holds is released before anything else is read — see the note in
 * `sendMessage`.
 */
async function writeMessage(input: SendMessageInput): Promise<WriteResult> {
  const body = (input.body ?? '').trim();
  const attachments = input.attachments ?? [];

  if (!input.system) {
    if (!body && !attachments.length) throw new ChatError('A message cannot be empty.', 400);
    if (body.length > MAX_MESSAGE_LENGTH) {
      throw new ChatError(`A message may not exceed ${MAX_MESSAGE_LENGTH} characters.`, 400);
    }
    if (!input.nonce) throw new ChatError('A nonce is required.', 400);
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    // Claim the nonce first. If someone already claimed it, this send is a
    // retry of a message that exists, and the right answer is that message —
    // not an error, and certainly not a second copy.
    const { rows: claimed } = await client.query<{ message_id: string }>(
      `INSERT INTO message_nonces (conversation_id, sender_id, nonce, message_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (conversation_id, sender_id, nonce) DO NOTHING
       RETURNING message_id`,
      [input.conversationId, input.senderId, input.nonce, snowflake()],
    );

    if (!claimed[0]) {
      // A retry. Resolve the original id on this same connection — never by
      // reaching back into the pool while still holding one.
      const { rows } = await client.query<{ message_id: string }>(
        `SELECT message_id FROM message_nonces
          WHERE conversation_id = $1 AND sender_id = $2 AND nonce = $3`,
        [input.conversationId, input.senderId, input.nonce],
      );
      await client.query('ROLLBACK');
      if (!rows[0]) throw new ChatError('Duplicate send could not be resolved.', 409);
      return {
        messageId: rows[0].message_id, created: false, mentionedUserIds: [], broadcast: null,
      };
    }

    const messageId = claimed[0].message_id;

    /*
     * Allocate the sequence.
     *
     * `last_seq = last_seq + 1 RETURNING` takes a row lock on the conversation
     * for the rest of the transaction, which is exactly the serialisation a
     * per-conversation total order needs: two simultaneous senders queue for
     * microseconds and come out with 41 and 42, never both 41. A sequence
     * object would be faster and wrong — it is global, gappy, and gives no
     * per-conversation ordering guarantee at all.
     */
    const preview = previewOf(body, attachments.length, input.type);
    const { rows: seqRows } = await client.query<{ last_seq: string }>(
      `UPDATE conversations
          SET last_seq = last_seq + 1,
              last_message_at = now(),
              last_message_preview = $2,
              last_message_sender = $3
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING last_seq`,
      [input.conversationId, preview, input.senderId],
    );
    if (!seqRows[0]) throw new ChatError('Conversation not found.', 404);
    const seq = Number(seqRows[0].last_seq);

    const attachmentJson = attachments.length
      ? await resolveAttachments(client, attachments, input.senderId)
      : [];

    const messageType: MessageType =
      input.type ?? (attachments.length && !body ? 'file' : 'text');

    await client.query(
      `INSERT INTO messages
         (id, conversation_id, seq, sender_id, type, body, nonce,
          thread_root_id, reply_to_id, attachments, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [messageId, input.conversationId, seq, input.senderId, messageType,
       body || null, input.nonce, input.threadRootId ?? null, input.replyToId ?? null,
       JSON.stringify(attachmentJson), JSON.stringify(input.metadata ?? {})],
    );

    if (attachmentJson.length) {
      for (const [i, a] of attachmentJson.entries()) {
        await client.query(
          `INSERT INTO message_attachments
             (message_id, file_id, conversation_id, ordinal, kind)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [messageId, a.fileId, input.conversationId, i, a.kind],
        );
      }
    }

    // A thread reply bumps its root's counter so the "N replies" affordance on
    // the parent is correct without counting rows on every render.
    if (input.threadRootId) {
      await client.query(
        `UPDATE messages
            SET reply_count = reply_count + 1, thread_last_at = now()
          WHERE conversation_id = $1 AND id = $2`,
        [input.conversationId, input.threadRootId],
      );
    }

    /*
     * Mentions and unread counters.
     *
     * Both are computed here, inside the same transaction as the insert, so a
     * badge can never disagree with the log it is counting.
     */
    const { mentioned, broadcast } = await resolveMentions(
      client, input.conversationId, body, input.senderId,
    );

    if (mentioned.length) {
      for (const uid of mentioned) {
        await client.query(
          `INSERT INTO message_mentions (message_id, conversation_id, user_id, kind, seq)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [messageId, input.conversationId, uid, broadcast ?? 'user', seq],
        );
      }
    }

    /*
     * Everyone except the sender gains an unread. The sender's own watermark is
     * advanced instead, because sending something is the strongest possible
     * signal that you have read it.
     *
     * System notices are excluded. "Aline created this channel" is context, not
     * correspondence: badging someone to go and read that a channel they were
     * just added to exists is exactly the kind of notification that teaches
     * people to ignore the badge.
     */
    await client.query(
      `UPDATE conversation_members
          SET unread_count = unread_count + $4,
              unread_mentions = unread_mentions + CASE WHEN user_id = ANY($3::text[]) THEN 1 ELSE 0 END,
              -- A hidden DM comes back the moment the other person writes.
              is_hidden = false
        WHERE conversation_id = $1 AND user_id <> $2 AND left_at IS NULL`,
      [input.conversationId, input.senderId, mentioned, messageType === 'system' ? 0 : 1],
    );

    await client.query(
      `UPDATE conversation_members
          SET last_read_seq = $3, unread_count = 0, unread_mentions = 0, last_read_at = now()
        WHERE conversation_id = $1 AND user_id = $2`,
      [input.conversationId, input.senderId, seq],
    );

    await client.query('COMMIT');

    return { messageId, created: true, mentionedUserIds: mentioned, broadcast };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The one-line summary the sidebar shows. Attachments get a shape, not a name. */
function previewOf(body: string, attachmentCount: number, type?: MessageType): string {
  if (body) return body.replace(MENTION_PATTERN, '@mention').slice(0, 200);
  if (type === 'voice_note') return '🎤 Voice message';
  if (type === 'poll') return '📊 Poll';
  if (attachmentCount === 1) return '📎 Attachment';
  if (attachmentCount > 1) return `📎 ${attachmentCount} attachments`;
  return '';
}

/**
 * Turn file ids into attachment records.
 *
 * Ownership is checked: a caller cannot attach a file id they guessed and
 * thereby republish someone else's upload into a conversation of their own.
 */
async function resolveAttachments(
  client: PoolClient, fileIds: string[], senderId: string,
): Promise<WireAttachment[]> {
  const { rows } = await client.query<{
    id: string; original_name: string; mime_type: string; size_bytes: string;
    owner_id: string; status: string; metadata: Record<string, unknown>;
  }>(
    `SELECT id, original_name, mime_type, size_bytes, owner_id, status, metadata
       FROM files WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
    [fileIds],
  );

  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: WireAttachment[] = [];
  for (const id of fileIds) {
    const f = byId.get(id);
    if (!f) throw new ChatError('Attachment not found.', 404);
    if (f.owner_id !== senderId) throw new ChatError('That attachment is not yours to send.', 403);
    if (f.status !== 'ready') throw new ChatError('An attachment is still uploading.', 409);
    const meta = (f.metadata ?? {}) as Record<string, number | number[] | undefined>;
    out.push({
      fileId: f.id,
      name: f.original_name,
      mime: f.mime_type,
      size: Number(f.size_bytes),
      kind: attachmentKind(f.mime_type),
      width: meta.width as number | undefined,
      height: meta.height as number | undefined,
      durationMs: meta.durationMs as number | undefined,
      waveform: meta.waveform as number[] | undefined,
    });
  }
  return out;
}

export function attachmentKind(mime: string): WireAttachment['kind'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (/^(application\/pdf|application\/msword|application\/vnd|text\/)/.test(mime)) return 'document';
  return 'other';
}

/**
 * Work out who a message mentions.
 *
 * `<@id>` forms are matched against live membership — mentioning someone who is
 * not in the channel must not create a notification they cannot act on, and
 * must not let a stranger's id be smuggled into a mention row.
 *
 * `@channel` and `@here` expand to the membership. `@here` is narrowed to
 * whoever is actually present by the notification layer, not here: this
 * function's job is who *could* be meant, and presence is a moment-to-moment
 * fact that belongs at delivery time.
 */
async function resolveMentions(
  client: PoolClient, conversationId: string, body: string, senderId: string,
): Promise<{ mentioned: string[]; broadcast: 'channel' | 'here' | null }> {
  if (!body) return { mentioned: [], broadcast: null };

  const explicit = [...body.matchAll(MENTION_PATTERN)].map((m) => m[1]!);
  const broadcastMatch = [...body.matchAll(BROADCAST_MENTION_PATTERN)][0];
  const broadcast = broadcastMatch
    ? (broadcastMatch[1]!.toLowerCase() === 'here' ? 'here' : 'channel')
    : null;

  if (!explicit.length && !broadcast) return { mentioned: [], broadcast: null };

  const { rows } = await client.query<{ user_id: string }>(
    broadcast
      ? `SELECT user_id FROM conversation_members
          WHERE conversation_id = $1 AND left_at IS NULL AND user_id <> $2`
      : `SELECT user_id FROM conversation_members
          WHERE conversation_id = $1 AND left_at IS NULL AND user_id <> $2
            AND user_id = ANY($3::text[])`,
    broadcast ? [conversationId, senderId] : [conversationId, senderId, explicit],
  );

  return { mentioned: rows.map((r) => r.user_id), broadcast };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * System messages
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * "Aline joined the channel" and friends.
 *
 * Written through the same path as any other message so they order correctly
 * against real messages and carry a seq — a join notice that floated outside
 * the sequence would land in the wrong place in the log on every reload.
 */
export async function systemMessage(
  conversationId: string, actorId: string, text: string,
  metadata: Record<string, unknown> = {},
): Promise<WireMessage | null> {
  try {
    const { message } = await sendMessage({
      conversationId, senderId: actorId, body: text,
      nonce: `sys-${snowflake()}`, type: 'system', system: true, metadata,
    });
    return message;
  } catch {
    // A system notice is commentary. Failing to write "X joined" must never
    // fail the join itself.
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Reading
 * ────────────────────────────────────────────────────────────────────────── */

interface MessageRow {
  id: string; conversation_id: string; seq: string; type: MessageType;
  body: string | null; sender_id: string; created_at: string;
  edited_at: string | null; deleted_at: string | null; nonce: string | null;
  thread_root_id: string | null; reply_count: number; thread_last_at: string | null;
  reply_to_id: string | null; pinned_at: string | null; pinned_by: string | null;
  edited_count: number; forwarded_from: WireMessage['forwardedFrom'];
  metadata: Record<string, unknown>; attachments: WireAttachment[];
  sender_name: string | null; sender_avatar: string | null; sender_role: string | null;
  reactions: Array<{ emoji: string; user_id: string }> | null;
  reply_body: string | null; reply_sender_id: string | null;
  reply_sender_name: string | null; reply_deleted: boolean | null;
  mentions_me: boolean; saved: boolean; read_count: string;
}

/**
 * One message row, fully hydrated.
 *
 * Reactions, the quoted parent, the saved flag and "does this mention me" are
 * all joined here rather than fetched per message by the client. A chat log is
 * the definitive N+1 trap: forty messages on screen, each needing four extra
 * lookups, is 160 round trips to paint one screen.
 */
const MESSAGE_SELECT = `
  SELECT m.id, m.conversation_id, m.seq, m.type, m.body, m.sender_id, m.created_at,
         m.edited_at, m.deleted_at, m.nonce, m.thread_root_id, m.reply_count,
         m.thread_last_at, m.reply_to_id, m.pinned_at, m.pinned_by, m.edited_count,
         m.forwarded_from, m.metadata, m.attachments,
         u.name AS sender_name, u.avatar_url AS sender_avatar, u.role AS sender_role,
         (SELECT json_agg(json_build_object('emoji', r.emoji, 'user_id', r.user_id))
            FROM message_reactions r WHERE r.message_id = m.id) AS reactions,
         rp.body AS reply_body, rp.sender_id AS reply_sender_id,
         ru.name AS reply_sender_name, (rp.deleted_at IS NOT NULL) AS reply_deleted,
         EXISTS (SELECT 1 FROM message_mentions mm
                  WHERE mm.message_id = m.id AND mm.user_id = $1) AS mentions_me,
         EXISTS (SELECT 1 FROM message_saves ms
                  WHERE ms.message_id = m.id AND ms.user_id = $1) AS saved,
         (SELECT count(*) FROM message_receipts mr
           WHERE mr.message_id = m.id AND mr.state = 'read')::text AS read_count
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    LEFT JOIN messages rp ON rp.id = m.reply_to_id AND rp.conversation_id = m.conversation_id
    LEFT JOIN users ru ON ru.id = rp.sender_id`;

function toWireMessage(r: MessageRow, viewerId: string, memberCount = 2): WireMessage {
  /* Reactions arrive as a flat (emoji, user) list and are folded here rather
   * than in SQL: grouping in Postgres would need a second aggregate level and
   * produce the same bytes on the wire. */
  const grouped = new Map<string, { count: number; mine: boolean; userIds: string[] }>();
  for (const { emoji, user_id } of r.reactions ?? []) {
    const g = grouped.get(emoji) ?? { count: 0, mine: false, userIds: [] };
    g.count += 1;
    if (user_id === viewerId) g.mine = true;
    if (g.userIds.length < 12) g.userIds.push(user_id);
    grouped.set(emoji, g);
  }
  const reactions: WireReaction[] = [...grouped.entries()]
    .map(([emoji, g]) => ({ emoji, ...g }))
    .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));

  const readCount = Number(r.read_count ?? 0);
  const isMine = r.sender_id === viewerId;

  /*
   * Delivery is only meaningful to the sender, and only as the *weakest* state
   * across recipients: "read" on a 40-person channel means everyone read it, not
   * that somebody did. Anything else and the second tick becomes a lie.
   */
  let delivery: DeliveryState = 'sent';
  if (isMine) {
    const others = Math.max(memberCount - 1, 1);
    if (readCount >= others) delivery = 'read';
    else if (readCount > 0) delivery = 'delivered';
  }

  return {
    id: r.id,
    conversationId: r.conversation_id,
    seq: Number(r.seq),
    type: r.type,
    // A deleted message keeps its row and its place in the sequence but loses
    // its body on the way out. The tombstone is rendered client-side.
    body: r.deleted_at ? null : r.body,
    senderId: r.sender_id,
    senderName: r.sender_name ?? 'Unknown',
    senderAvatarUrl: r.sender_avatar,
    senderRole: r.sender_role,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
    nonce: r.nonce,
    reactions: r.deleted_at ? [] : reactions,
    attachments: r.deleted_at ? [] : (r.attachments ?? []),
    threadRootId: r.thread_root_id,
    replyCount: r.reply_count ?? 0,
    threadLastAt: r.thread_last_at,
    replyTo: r.reply_to_id
      ? {
          id: r.reply_to_id,
          senderId: r.reply_sender_id ?? '',
          senderName: r.reply_sender_name ?? 'Unknown',
          body: r.reply_deleted ? null : r.reply_body,
          deleted: Boolean(r.reply_deleted),
        }
      : null,
    pinnedAt: r.pinned_at,
    pinnedBy: r.pinned_by,
    saved: Boolean(r.saved),
    editedCount: r.edited_count ?? 0,
    forwardedFrom: r.forwarded_from ?? null,
    mentionsMe: Boolean(r.mentions_me),
    delivery,
    readCount,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  };
}

export async function getMessage(
  viewerId: string, conversationId: string, messageId: string,
): Promise<WireMessage | null> {
  const { rows } = await getPool().query<MessageRow>(
    `${MESSAGE_SELECT} WHERE m.conversation_id = $2 AND m.id = $3`,
    [viewerId, conversationId, messageId],
  );
  if (!rows[0]) return null;
  const count = await memberCountOf(conversationId);
  return toWireMessage(rows[0], viewerId, count);
}

async function memberCountOf(conversationId: string): Promise<number> {
  const { rows } = await getPool().query<{ member_count: number }>(
    'SELECT member_count FROM conversations WHERE id = $1', [conversationId]);
  return rows[0]?.member_count ?? 2;
}

export interface ListMessagesOptions {
  /** Fetch messages strictly *older* than this seq — the infinite-scroll cursor. */
  before?: number;
  /** Fetch messages strictly *newer* than this seq — used to catch up after a
   *  reconnect without refetching the whole visible window. */
  after?: number;
  limit?: number;
  /** Only replies inside this thread. Omit for the main channel flow. */
  threadRootId?: string;
}

/**
 * A page of scrollback.
 *
 * Fetched newest-first with a `seq <` cursor and reversed for display. Ordering
 * on `seq` rather than `created_at` is what makes the cursor exact: two messages
 * in the same millisecond still page deterministically, and a paused scroll
 * cannot skip or repeat a row.
 */
export async function listMessages(
  viewerId: string, conversationId: string, opts: ListMessagesOptions = {},
): Promise<MessagePage> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const params: unknown[] = [viewerId, conversationId];
  const where: string[] = ['m.conversation_id = $2'];

  if (opts.threadRootId) {
    params.push(opts.threadRootId);
    // The root itself is included, so opening a thread shows what it is about.
    where.push(`(m.thread_root_id = $${params.length} OR m.id = $${params.length})`);
  } else {
    // Thread replies stay out of the main flow (FR-MSG-6).
    where.push('m.thread_root_id IS NULL');
  }

  if (opts.before !== undefined) { params.push(opts.before); where.push(`m.seq < $${params.length}`); }
  if (opts.after !== undefined) { params.push(opts.after); where.push(`m.seq > $${params.length}`); }

  params.push(limit + 1);
  const { rows } = await getPool().query<MessageRow>(
    `${MESSAGE_SELECT}
      WHERE ${where.join(' AND ')}
      ORDER BY m.seq ${opts.after !== undefined ? 'ASC' : 'DESC'}
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const count = await memberCountOf(conversationId);
  const messages = page.map((r) => toWireMessage(r, viewerId, count));
  if (opts.after === undefined) messages.reverse();

  return {
    messages,
    nextCursor: hasMore && messages[0] ? String(messages[0].seq) : null,
    hasMore,
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Read state
 * ────────────────────────────────────────────────────────────────────────── */

export interface ReadResult {
  lastReadSeq: number;
  unread: number;
  unreadMentions: number;
  changed: boolean;
}

/**
 * Advance the read watermark.
 *
 * Monotonic: `GREATEST(last_read_seq, $seq)` means a late-arriving lower value
 * from a second tab cannot un-read messages. Unread counts are *recomputed*
 * from the log rather than decremented, so they self-heal — a counter that only
 * ever drifts one way is a counter that eventually shows 3 on an empty channel.
 */
export async function advanceRead(
  userId: string, conversationId: string, seq: number,
): Promise<ReadResult> {
  /*
   * One statement, one UPDATE.
   *
   * The obvious shape — a CTE that bumps the watermark, then a second CTE that
   * recounts using it — does not work, and fails *silently*. Two
   * data-modifying CTEs in one statement both see the snapshot from before the
   * statement began, and PostgreSQL will not let the second one update a row
   * the first already touched: it matches nothing, returns nothing, and the
   * caller sees "conversation not found" for a conversation the user is
   * plainly in.
   *
   * So the watermark is computed once, in `prev`, and used in every SET.
   * Inside SET, `m.last_read_seq` would still be the OLD value, which is
   * exactly the trap; referring to `prev.next_seq` instead makes the intended
   * value explicit in all four places it is needed.
   */
  const { rows } = await getPool().query<{
    last_read_seq: string; unread_count: number; unread_mentions: number; changed: boolean;
  }>(
    `WITH prev AS (
       SELECT last_read_seq AS old_seq,
              GREATEST(last_read_seq, $3::bigint) AS next_seq
         FROM conversation_members
        WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL
     )
     UPDATE conversation_members m
        SET last_read_seq = prev.next_seq,
            last_read_at  = now(),
            -- Recomputed from the log, never decremented. A counter that only
            -- drifts one way is a counter that eventually shows 3 unread on an
            -- empty channel.
            unread_count = (
              SELECT count(*) FROM messages x
               WHERE x.conversation_id = m.conversation_id
                 AND x.seq > prev.next_seq
                 AND x.sender_id <> m.user_id
                 AND x.deleted_at IS NULL
                 -- Same rule as the send path, or the counter and the
                 -- recount would disagree and the badge would flicker.
                 AND x.type <> 'system'),
            unread_mentions = (
              SELECT count(*) FROM message_mentions mm
               WHERE mm.conversation_id = m.conversation_id
                 AND mm.user_id = m.user_id
                 AND mm.seq > prev.next_seq)
       FROM prev
      WHERE m.conversation_id = $1 AND m.user_id = $2 AND m.left_at IS NULL
      RETURNING m.last_read_seq, m.unread_count, m.unread_mentions,
                (prev.next_seq > prev.old_seq) AS changed`,
    [conversationId, userId, seq],
  );

  const r = rows[0];
  if (!r) throw new ChatError('Conversation not found.', 404);
  return {
    lastReadSeq: Number(r.last_read_seq),
    unread: r.unread_count,
    unreadMentions: r.unread_mentions,
    changed: r.changed,
  };
}

/** Record that messages reached a device (the second tick). */
export async function markDelivered(
  userId: string, conversationId: string, messageIds: string[],
): Promise<void> {
  if (!messageIds.length) return;
  await getPool().query(
    `INSERT INTO message_receipts (message_id, conversation_id, user_id, state)
     SELECT unnest($3::text[]), $1, $2, 'delivered'
     ON CONFLICT (message_id, user_id) DO NOTHING`,
    [conversationId, userId, messageIds],
  );
}

/**
 * Record that messages were actually read.
 *
 * Reciprocity (FR-MSG-13): someone who has turned read receipts off does not
 * generate them, and — because the setting would otherwise be a one-way mirror —
 * does not get to see other people's either. That second half is enforced on
 * the read path in `receiptsVisibleTo`.
 */
export async function markRead(
  userId: string, conversationId: string, upToSeq: number,
): Promise<number> {
  const { rows: prefs } = await getPool().query<{ read_receipts: boolean }>(
    'SELECT read_receipts FROM user_chat_prefs WHERE user_id = $1', [userId]);
  if (prefs[0] && prefs[0].read_receipts === false) return 0;

  const { rowCount } = await getPool().query(
    `INSERT INTO message_receipts (message_id, conversation_id, user_id, state)
     SELECT m.id, m.conversation_id, $2, 'read'
       FROM messages m
      WHERE m.conversation_id = $1 AND m.seq <= $3 AND m.sender_id <> $2
            AND m.deleted_at IS NULL
     ON CONFLICT (message_id, user_id)
       DO UPDATE SET state = 'read', at = now()
       WHERE message_receipts.state <> 'read'`,
    [conversationId, userId, upToSeq],
  );
  return rowCount ?? 0;
}

export async function receiptsVisibleTo(userId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ read_receipts: boolean }>(
    'SELECT read_receipts FROM user_chat_prefs WHERE user_id = $1', [userId]);
  return rows[0]?.read_receipts !== false;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Members
 * ────────────────────────────────────────────────────────────────────────── */

export async function listMembers(conversationId: string): Promise<WireMember[]> {
  const { rows } = await getPool().query<{
    user_id: string; name: string; avatar_url: string | null; role: MemberRole;
    platform_role: string | null; joined_at: string; last_read_seq: string;
  }>(
    `SELECT m.user_id, u.name, u.avatar_url, m.role, u.role AS platform_role,
            m.joined_at, m.last_read_seq
       FROM conversation_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = $1 AND m.left_at IS NULL
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
                           WHEN 'moderator' THEN 2 ELSE 3 END,
               u.name ASC`,
    [conversationId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    avatarUrl: r.avatar_url,
    role: r.role,
    platformRole: r.platform_role,
    // Filled in from Redis by the route — presence is not a database fact.
    presence: 'offline',
    joinedAt: r.joined_at,
    lastReadSeq: Number(r.last_read_seq),
  }));
}

/** Who should receive socket traffic and notifications for a conversation. */
export async function memberIdsOf(conversationId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM conversation_members
      WHERE conversation_id = $1 AND left_at IS NULL`,
    [conversationId],
  );
  return rows.map((r) => r.user_id);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Per-member preferences
 * ────────────────────────────────────────────────────────────────────────── */

export async function setMemberPrefs(
  userId: string, conversationId: string,
  prefs: { isStarred?: boolean; notification?: NotificationLevel; mutedUntil?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [conversationId, userId];
  if (prefs.isStarred !== undefined) { params.push(prefs.isStarred); sets.push(`is_starred = $${params.length}`); }
  if (prefs.notification !== undefined) { params.push(prefs.notification); sets.push(`notification = $${params.length}`); }
  if (prefs.mutedUntil !== undefined) { params.push(prefs.mutedUntil); sets.push(`muted_until = $${params.length}`); }
  if (!sets.length) return;

  await getPool().query(
    `UPDATE conversation_members SET ${sets.join(', ')}
      WHERE conversation_id = $1 AND user_id = $2`,
    params,
  );
}

export async function saveDraft(
  userId: string, conversationId: string, draft: string | null,
): Promise<void> {
  await getPool().query(
    `UPDATE conversation_members
        SET draft = $3, draft_updated_at = now()
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId, draft && draft.trim() ? draft : null],
  );
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Space resolution
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Which space a user's new conversations belong to.
 *
 * Falls back to the staff space so a user who has not been placed by a
 * directory sync can still be talked to. Returning nothing here would make the
 * product silently unusable for exactly the accounts that need help most.
 */
export async function defaultSpaceFor(userId: string): Promise<string> {
  const { rows } = await getPool().query<{ space_id: string }>(
    `SELECT space_id FROM space_members WHERE user_id = $1 ORDER BY joined_at LIMIT 1`,
    [userId],
  );
  if (rows[0]) return rows[0].space_id;

  const { rows: fallback } = await getPool().query<{ id: string }>(
    `SELECT id FROM spaces ORDER BY CASE slug WHEN 'staff' THEN 0 ELSE 1 END, created_at LIMIT 1`,
  );
  if (!fallback[0]) throw new ChatError('No space is configured.', 500);
  return fallback[0].id;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Contact policy  (FR-USR-6)
 * ────────────────────────────────────────────────────────────────────────── */

/** The DM between these two, if one already exists. */
export async function findDirect(userId: string, peerId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT c.id
       FROM conversations c
       JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = $1
       JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = $2
      WHERE c.type = 'dm' AND c.deleted_at IS NULL
      LIMIT 1`,
    [userId, peerId],
  );
  return rows[0]?.id ?? null;
}

/**
 * May this person open a conversation with that one?
 *
 * The table holds explicit decisions by role pair. An **absent** row means
 * allowed, and that default is deliberate but narrow: `DM_START` has already
 * been checked by the caller, so anyone reaching here holds a role an
 * administrator granted DM rights to. The policy table exists to carve
 * exceptions out of that — "parents may not DM other parents" — rather than to
 * be the only thing standing between a student and the whole directory. The
 * safeguarding default that actually matters is that students do not hold
 * `DM_START` at all.
 *
 * A block, in either direction, always wins.
 */
export async function contactAllowed(fromUserId: string, toUserId: string): Promise<boolean> {
  const { rows: blocked } = await getPool().query(
    `SELECT 1 FROM user_blocks
      WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
    [fromUserId, toUserId],
  );
  if (blocked.length) return false;

  const { rows } = await getPool().query<{ allow: boolean }>(
    `SELECT p.allow
       FROM users a, users b
       JOIN contact_policies p ON true
      WHERE a.id = $1 AND b.id = $2
        AND lower(p.from_role) = lower(a.role)
        AND lower(p.to_role)   = lower(b.role)
      LIMIT 1`,
    [fromUserId, toUserId],
  );
  return rows[0]?.allow ?? true;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Unread counters
 * ────────────────────────────────────────────────────────────────────────── */

export interface UnreadCounts {
  unread: number;
  unreadMentions: number;
  lastReadSeq: number;
}

/**
 * Current counters for several members of one conversation, in one query.
 *
 * Used on the send path to tell everyone else their badge moved. Per-user
 * queries here would mean 400 round trips for one message in a class channel.
 */
export async function unreadFor(
  userIds: string[], conversationId: string,
): Promise<Record<string, UnreadCounts>> {
  if (!userIds.length) return {};
  const { rows } = await getPool().query<{
    user_id: string; unread_count: number; unread_mentions: number; last_read_seq: string;
  }>(
    `SELECT user_id, unread_count, unread_mentions, last_read_seq
       FROM conversation_members
      WHERE conversation_id = $1 AND user_id = ANY($2::text[]) AND left_at IS NULL`,
    [conversationId, userIds],
  );
  return Object.fromEntries(rows.map((r) => [r.user_id, {
    unread: r.unread_count,
    unreadMentions: r.unread_mentions,
    lastReadSeq: Number(r.last_read_seq),
  }]));
}

/** The badge on the Chat icon in the rail: everything, everywhere, for one person. */
export async function totalUnread(userId: string): Promise<{ unread: number; mentions: number }> {
  const { rows } = await getPool().query<{ unread: string; mentions: string }>(
    `SELECT COALESCE(sum(m.unread_count), 0)::text     AS unread,
            COALESCE(sum(m.unread_mentions), 0)::text  AS mentions
       FROM conversation_members m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.user_id = $1 AND m.left_at IS NULL
        AND c.deleted_at IS NULL AND m.notification <> 'none'`,
    [userId],
  );
  return { unread: Number(rows[0]?.unread ?? 0), mentions: Number(rows[0]?.mentions ?? 0) };
}
