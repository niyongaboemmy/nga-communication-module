import { getPool, snowflake } from '@tupo/db';
import type { PoolClient } from 'pg';
import {
  DEFAULT_PAGE_SIZE, EDIT_WINDOW_MS, MAX_MESSAGE_LENGTH, MAX_PAGE_SIZE,
  MENTION_PATTERN, BROADCAST_MENTION_PATTERN,
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

/* ────────────────────────────────────────────────────────────────────────── *
 * Reactions  (FR-MSG-5)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Emoji are stored as the literal grapheme, not a shortcode.
 *
 * A shortcode table is one more thing to keep in step with the picker, and the
 * moment someone reacts with an emoji the table does not know about, the
 * reaction is lost. The length cap is what stops the column being used as
 * general-purpose storage: no legitimate emoji, including a flag or a
 * multi-person family sequence with skin tones, exceeds it.
 */
const MAX_EMOJI_LENGTH = 64;

export interface ReactionResult {
  reactions: WireReaction[];
  /** True when the click added one, false when it removed the viewer's own. */
  added: boolean;
}

/**
 * Toggle one person's reaction.
 *
 * Toggle rather than add/remove as separate calls: the client cannot know
 * whether its view of "have I reacted" is current, and asking the database to
 * decide removes a whole class of double-click race.
 */
export async function toggleReaction(
  userId: string, conversationId: string, messageId: string, emoji: string,
): Promise<ReactionResult> {
  const clean = (emoji ?? '').trim();
  if (!clean) throw new ChatError('An emoji is required.', 400);
  if (clean.length > MAX_EMOJI_LENGTH) throw new ChatError('That is not an emoji.', 400);

  // Reacting to a tombstone is meaningless, and letting it through would leave
  // reactions hanging off a message with nothing to hang from.
  const { rows: existing } = await getPool().query<{ id: string }>(
    `SELECT id FROM messages
      WHERE conversation_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [conversationId, messageId],
  );
  if (!existing[0]) throw new ChatError('Message not found.', 404);

  const { rowCount } = await getPool().query(
    `DELETE FROM message_reactions
      WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
    [messageId, userId, clean],
  );

  const added = (rowCount ?? 0) === 0;
  if (added) {
    await getPool().query(
      `INSERT INTO message_reactions (message_id, conversation_id, user_id, emoji)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [messageId, conversationId, userId, clean],
    );
  }

  return { reactions: await reactionsFor(messageId, userId), added };
}

export async function reactionsFor(messageId: string, viewerId: string): Promise<WireReaction[]> {
  const { rows } = await getPool().query<{
    emoji: string; count: string; mine: boolean; user_ids: string[];
  }>(
    `SELECT emoji,
            count(*)::text AS count,
            bool_or(user_id = $2) AS mine,
            (array_agg(user_id ORDER BY created_at))[1:12] AS user_ids
       FROM message_reactions
      WHERE message_id = $1
      GROUP BY emoji
      ORDER BY count(*) DESC, emoji ASC`,
    [messageId, viewerId],
  );
  return rows.map((r) => ({
    emoji: r.emoji, count: Number(r.count), mine: r.mine, userIds: r.user_ids ?? [],
  }));
}

/** Names behind a reaction pill — "Ada, Bosco and 3 others". */
export async function reactorNames(messageId: string, emoji: string): Promise<string[]> {
  const { rows } = await getPool().query<{ name: string }>(
    `SELECT u.name FROM message_reactions r
       JOIN users u ON u.id = r.user_id
      WHERE r.message_id = $1 AND r.emoji = $2
      ORDER BY r.created_at LIMIT 50`,
    [messageId, emoji],
  );
  return rows.map((r) => r.name);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Editing  (FR-MSG-8)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Edit a message.
 *
 * Only the author, only within the window, and the previous body is archived
 * first. "What did it say before they edited it" is a question a school will be
 * asked, and the only time to answer it is before the row is overwritten.
 *
 * Mentions are recomputed: editing a message to add an @mention should notify
 * the person mentioned, and editing one to remove a mention should stop that
 * person's badge counting it.
 */
export async function editMessage(
  userId: string, conversationId: string, messageId: string, newBody: string,
): Promise<{ message: WireMessage; newlyMentioned: string[] }> {
  const body = (newBody ?? '').trim();
  if (!body) throw new ChatError('An edited message cannot be empty. Delete it instead.', 400);
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new ChatError(`A message may not exceed ${MAX_MESSAGE_LENGTH} characters.`, 400);
  }

  const client = await getPool().connect();
  let newlyMentioned: string[] = [];
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{
      sender_id: string; body: string | null; created_at: string;
      deleted_at: string | null; type: MessageType; seq: string;
    }>(
      `SELECT sender_id, body, created_at, deleted_at, type, seq
         FROM messages WHERE conversation_id = $1 AND id = $2
         FOR UPDATE`,
      [conversationId, messageId],
    );
    const row = rows[0];
    if (!row) throw new ChatError('Message not found.', 404);
    if (row.deleted_at) throw new ChatError('That message was deleted.', 409);
    // Not even a moderator may edit someone else's words. Removing them is a
    // moderation action; rewriting them is impersonation.
    if (row.sender_id !== userId) throw new ChatError('You can only edit your own messages.', 403);
    if (row.type === 'system') throw new ChatError('System messages cannot be edited.', 400);
    if (Date.now() - new Date(row.created_at).getTime() > EDIT_WINDOW_MS) {
      throw new ChatError('The edit window for this message has passed.', 409);
    }

    await client.query(
      `INSERT INTO message_edits (id, message_id, editor_id, previous_body)
       VALUES ($1,$2,$3,$4)`,
      [snowflake(), messageId, userId, row.body],
    );

    await client.query(
      `UPDATE messages
          SET body = $3, edited_at = now(), edited_count = edited_count + 1
        WHERE conversation_id = $1 AND id = $2`,
      [conversationId, messageId, body],
    );

    // Recomputed rather than merged: the message says what it says now.
    const before = await client.query<{ user_id: string }>(
      'SELECT user_id FROM message_mentions WHERE message_id = $1', [messageId]);
    const had = new Set(before.rows.map((r) => r.user_id));

    await client.query('DELETE FROM message_mentions WHERE message_id = $1', [messageId]);
    const { mentioned, broadcast } = await resolveMentions(client, conversationId, body, userId);
    for (const uid of mentioned) {
      await client.query(
        `INSERT INTO message_mentions (message_id, conversation_id, user_id, kind, seq)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [messageId, conversationId, uid, broadcast ?? 'user', Number(row.seq)],
      );
    }
    newlyMentioned = mentioned.filter((id) => !had.has(id));

    // The sidebar preview has to follow the edit, or the list shows a sentence
    // that no longer exists anywhere.
    await client.query(
      `UPDATE conversations
          SET last_message_preview = $2
        WHERE id = $1 AND last_seq = $3::bigint`,
      [conversationId, previewOf(body, 0), row.seq],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const message = await getMessage(userId, conversationId, messageId);
  if (!message) throw new ChatError('Message could not be read back.', 500);
  return { message, newlyMentioned };
}

/** Every version of a message, newest first (FR-MSG-8). */
export async function editHistory(
  conversationId: string, messageId: string,
): Promise<Array<{ body: string | null; at: string; editorName: string }>> {
  const { rows } = await getPool().query<{
    previous_body: string | null; edited_at: string; name: string;
  }>(
    `SELECT e.previous_body, e.edited_at, u.name
       FROM message_edits e JOIN users u ON u.id = e.editor_id
      WHERE e.message_id = $1 ORDER BY e.edited_at DESC`,
    [messageId],
  );
  return rows.map((r) => ({ body: r.previous_body, at: r.edited_at, editorName: r.name }));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Deleting  (FR-MSG-9)
 * ────────────────────────────────────────────────────────────────────────── */

export interface DeleteResult {
  /** True when a moderator removed someone else's message — always audited. */
  byModerator: boolean;
  senderId: string;
  seq: number;
}

/**
 * Soft-delete a message.
 *
 * A tombstone, never a `DELETE`. The row keeps its sequence number, so the log
 * does not silently reorder around the gap and every other member's read
 * watermark still means what it meant. The body and attachments are cleared on
 * the way out in `toWireMessage`, so a deleted message discloses nothing even
 * though the row survives for moderation and legal export.
 */
export async function deleteMessage(
  userId: string, conversationId: string, messageId: string,
  opts: { canDeleteAny?: boolean; memberRole?: MemberRole } = {},
): Promise<DeleteResult> {
  const { rows } = await getPool().query<{
    sender_id: string; deleted_at: string | null; type: MessageType; seq: string;
  }>(
    `SELECT sender_id, deleted_at, type, seq FROM messages
      WHERE conversation_id = $1 AND id = $2`,
    [conversationId, messageId],
  );
  const row = rows[0];
  if (!row) throw new ChatError('Message not found.', 404);
  if (row.deleted_at) throw new ChatError('That message is already deleted.', 409);
  if (row.type === 'system') throw new ChatError('System messages cannot be deleted.', 400);

  const mine = row.sender_id === userId;
  const asModerator = !mine
    && (opts.canDeleteAny === true || (opts.memberRole ? canModerate(opts.memberRole) : false));
  if (!mine && !asModerator) {
    throw new ChatError('You can only delete your own messages.', 403);
  }

  await getPool().query(
    `UPDATE messages
        SET deleted_at = now(), deleted_by = $3, body = NULL, attachments = '[]'::jsonb
      WHERE conversation_id = $1 AND id = $2`,
    [conversationId, messageId, userId],
  );

  // A deleted message must stop counting against anyone's badge, and must stop
  // being a mention. Leaving either behind means a red dot pointing at a
  // tombstone.
  await getPool().query('DELETE FROM message_mentions WHERE message_id = $1', [messageId]);
  await getPool().query('DELETE FROM message_reactions WHERE message_id = $1', [messageId]);
  await getPool().query(
    `UPDATE conversation_members m
        SET unread_count = (
              SELECT count(*) FROM messages x
               WHERE x.conversation_id = m.conversation_id
                 AND x.seq > m.last_read_seq AND x.sender_id <> m.user_id
                 AND x.deleted_at IS NULL AND x.type <> 'system'),
            unread_mentions = (
              SELECT count(*) FROM message_mentions mm
               WHERE mm.conversation_id = m.conversation_id
                 AND mm.user_id = m.user_id AND mm.seq > m.last_read_seq)
      WHERE m.conversation_id = $1 AND m.left_at IS NULL`,
    [conversationId],
  );

  // If it was the latest message, the sidebar preview is now a lie.
  await refreshPreview(conversationId);

  return { byModerator: asModerator, senderId: row.sender_id, seq: Number(row.seq) };
}

/** Recompute the denormalised sidebar preview from the newest live message. */
export async function refreshPreview(conversationId: string): Promise<void> {
  await getPool().query(
    `UPDATE conversations c
        SET last_message_at = latest.created_at,
            last_message_preview = COALESCE(latest.preview, ''),
            last_message_sender = latest.sender_id
       FROM (
         SELECT m.created_at, m.sender_id,
                CASE WHEN m.body IS NOT NULL THEN left(m.body, 200)
                     WHEN jsonb_array_length(m.attachments) > 0 THEN '📎 Attachment'
                     ELSE '' END AS preview
           FROM messages m
          WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
          ORDER BY m.seq DESC LIMIT 1
       ) latest
      WHERE c.id = $1`,
    [conversationId],
  );
}

/**
 * Everyone who has a DM open with this person.
 *
 * Presence is only *displayed* against DM counterparts — a channel has no
 * single presence, and no sidebar row shows one. So this is exactly the
 * audience for a presence change, and broadcasting more widely would mean
 * every member of every 400-person channel getting a packet each time someone
 * switched tabs.
 */
export async function dmPeerIdsOf(userId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ user_id: string }>(
    `SELECT DISTINCT peer.user_id
       FROM conversation_members mine
       JOIN conversations c ON c.id = mine.conversation_id AND c.type = 'dm'
       JOIN conversation_members peer
         ON peer.conversation_id = c.id AND peer.user_id <> mine.user_id
      WHERE mine.user_id = $1 AND mine.left_at IS NULL AND peer.left_at IS NULL
        AND c.deleted_at IS NULL`,
    [userId],
  );
  return rows.map((r) => r.user_id);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Threads  (FR-MSG-6)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Reply in a thread.
 *
 * A thread is a second axis, not a nested message. The reply carries
 * `thread_root_id` and is therefore excluded from the main channel flow by
 * `listMessages` — which is the whole point: a side conversation about one
 * message must not push forty unrelated lines past everyone else.
 *
 * `alsoSendToChannel` is the escape hatch Slack got right. Sometimes the
 * conclusion of a thread belongs in the room, and forcing people to copy-paste
 * it is how threads end up abandoned. It writes a *second* message in the main
 * flow that quotes the reply, rather than moving the reply out of the thread,
 * so the thread stays readable as a thread.
 */
export async function replyInThread(input: {
  conversationId: string;
  senderId: string;
  threadRootId: string;
  body: string;
  nonce: string;
  attachments?: string[];
  alsoSendToChannel?: boolean;
}): Promise<{ reply: SendResult; echo: SendResult | null; root: WireMessage | null }> {
  const { rows } = await getPool().query<{ id: string; thread_root_id: string | null }>(
    `SELECT id, thread_root_id FROM messages
      WHERE conversation_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [input.conversationId, input.threadRootId],
  );
  const target = rows[0];
  if (!target) throw new ChatError('That message is no longer there to reply to.', 404);

  // Replying to a reply threads onto the same root rather than nesting. Chat
  // threads are one level deep in every product that has shipped them, because
  // the second level is unreadable in a column 400px wide.
  const rootId = target.thread_root_id ?? target.id;

  const reply = await sendMessage({
    conversationId: input.conversationId,
    senderId: input.senderId,
    body: input.body,
    nonce: input.nonce,
    threadRootId: rootId,
    attachments: input.attachments ?? [],
  });

  let echo: SendResult | null = null;
  if (input.alsoSendToChannel && reply.created) {
    echo = await sendMessage({
      conversationId: input.conversationId,
      senderId: input.senderId,
      body: input.body,
      nonce: `${input.nonce}-echo`,
      replyToId: rootId,
      metadata: { fromThread: rootId },
    });
  }

  return {
    reply,
    echo,
    root: await getMessage(input.senderId, input.conversationId, rootId),
  };
}

/**
 * Everyone who has written in a thread — its followers (FR-MSG-6).
 *
 * Participation *is* the subscription. Asking people to press a "follow" button
 * they cannot see means threads notify nobody, and following everyone in the
 * channel means threads notify everyone; the people who spoke are the honest
 * middle.
 */
export async function threadParticipants(
  conversationId: string, rootId: string,
): Promise<string[]> {
  const { rows } = await getPool().query<{ sender_id: string }>(
    `SELECT DISTINCT sender_id FROM messages
      WHERE conversation_id = $1 AND (id = $2 OR thread_root_id = $2)
        AND deleted_at IS NULL AND type <> 'system'`,
    [conversationId, rootId],
  );
  return rows.map((r) => r.sender_id);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Pins  (FR-MSG-11)
 * ────────────────────────────────────────────────────────────────────────── */

/** How many messages may be pinned at once, before a pin list stops being one. */
export const MAX_PINS = 50;

export async function setPinned(
  userId: string, conversationId: string, messageId: string, pinned: boolean,
): Promise<WireMessage> {
  if (pinned) {
    const { rows: count } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM messages
        WHERE conversation_id = $1 AND pinned_at IS NOT NULL AND deleted_at IS NULL`,
      [conversationId],
    );
    if (Number(count[0]?.n ?? 0) >= MAX_PINS) {
      throw new ChatError(
        `A conversation can hold ${MAX_PINS} pinned messages. Unpin something first.`, 409);
    }
  }

  const { rowCount } = await getPool().query(
    `UPDATE messages
        SET pinned_at = ${pinned ? 'now()' : 'NULL'},
            pinned_by = ${pinned ? '$3' : 'NULL'}
      WHERE conversation_id = $1 AND id = $2 AND deleted_at IS NULL`,
    pinned ? [conversationId, messageId, userId] : [conversationId, messageId],
  );
  if (!rowCount) throw new ChatError('Message not found.', 404);

  const message = await getMessage(userId, conversationId, messageId);
  if (!message) throw new ChatError('Message could not be read back.', 500);
  return message;
}

export async function listPinned(
  viewerId: string, conversationId: string,
): Promise<WireMessage[]> {
  const { rows } = await getPool().query<MessageRow>(
    `${MESSAGE_SELECT}
      WHERE m.conversation_id = $2 AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL
      ORDER BY m.pinned_at DESC
      LIMIT ${MAX_PINS}`,
    [viewerId, conversationId],
  );
  const count = await memberCountOf(conversationId);
  return rows.map((r) => toWireMessage(r, viewerId, count));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Saved items  (FR-MSG-12)
 * ────────────────────────────────────────────────────────────────────────── */

export async function setSaved(
  userId: string, conversationId: string, messageId: string, saved: boolean,
): Promise<boolean> {
  if (saved) {
    await getPool().query(
      `INSERT INTO message_saves (user_id, message_id, conversation_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [userId, messageId, conversationId],
    );
  } else {
    await getPool().query(
      `DELETE FROM message_saves WHERE user_id = $1 AND message_id = $2`,
      [userId, messageId],
    );
  }
  return saved;
}

/**
 * A personal reading list, across every conversation.
 *
 * Each row carries where it came from, because a saved message with no context
 * is a sentence you cannot act on. Membership is re-checked in the join: saving
 * a message from a channel you later left must not keep it readable.
 */
export async function listSaved(
  userId: string, limit = 50,
): Promise<Array<{ message: WireMessage; conversationName: string; conversationType: string }>> {
  /*
   * Written out rather than composed from MESSAGE_SELECT.
   *
   * This query needs three extra columns and three extra joins, and bolting
   * them onto the shared fragment by string substitution produced something
   * that compiled, ran, and would break silently the next time a column was
   * renamed. A saved-items list is read rarely; the duplication is cheaper than
   * the trap.
   */
  const { rows } = await getPool().query<
    MessageRow & {
      conversation_name: string | null;
      conversation_type: string;
      peer_name: string | null;
    }
  >(
    `SELECT m.id, m.conversation_id, m.seq, m.type, m.body, m.sender_id, m.created_at,
            m.edited_at, m.deleted_at, m.nonce, m.thread_root_id, m.reply_count,
            m.thread_last_at, m.reply_to_id, m.pinned_at, m.pinned_by, m.edited_count,
            m.forwarded_from, m.metadata, m.attachments,
            u.name AS sender_name, u.avatar_url AS sender_avatar, u.role AS sender_role,
            (SELECT json_agg(json_build_object('emoji', r.emoji, 'user_id', r.user_id))
               FROM message_reactions r WHERE r.message_id = m.id) AS reactions,
            NULL::text AS reply_body, NULL::text AS reply_sender_id,
            NULL::text AS reply_sender_name, false AS reply_deleted,
            EXISTS (SELECT 1 FROM message_mentions mm
                     WHERE mm.message_id = m.id AND mm.user_id = $1) AS mentions_me,
            true AS saved,
            '0'::text AS read_count,
            c.name AS conversation_name, c.type AS conversation_type, peer.name AS peer_name
       FROM message_saves ms
       JOIN messages m ON m.id = ms.message_id AND m.conversation_id = ms.conversation_id
       LEFT JOIN users u ON u.id = m.sender_id
       JOIN conversations c ON c.id = m.conversation_id
       -- Re-checked, not assumed: saving a message from a channel you later
       -- left must not keep it readable.
       JOIN conversation_members cm
         ON cm.conversation_id = c.id AND cm.user_id = $1 AND cm.left_at IS NULL
       LEFT JOIN LATERAL (
         SELECT pu.name FROM conversation_members pm
           JOIN users pu ON pu.id = pm.user_id
          WHERE pm.conversation_id = c.id AND pm.user_id <> $1 AND pm.left_at IS NULL
          LIMIT 1
       ) peer ON c.type = 'dm'
      WHERE ms.user_id = $1 AND m.deleted_at IS NULL AND c.deleted_at IS NULL
      ORDER BY ms.created_at DESC
      LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 100)],
  );

  return rows.map((r) => ({
    message: toWireMessage(r, userId),
    conversationName: r.conversation_type === 'dm'
      ? (r.peer_name ?? 'Direct message')
      : (r.conversation_name ?? 'Conversation'),
    conversationType: r.conversation_type,
  }));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Forwarding  (FR-MSG-10)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Forward a message into other conversations, keeping attribution.
 *
 * The original author travels with it. Forwarding that strips attribution is
 * how a message ends up quoted as the forwarder's own words — in a school, with
 * something a pupil said, that is a safeguarding problem rather than an etiquette
 * one.
 *
 * Each destination is authorised separately. Being a member of the source says
 * nothing about the target.
 */
export async function forwardMessage(
  userId: string, sourceConversationId: string, messageId: string,
  targetConversationIds: string[], comment?: string,
): Promise<Array<{ conversationId: string; result: SendResult }>> {
  await requireMembership(userId, sourceConversationId);

  const original = await getMessage(userId, sourceConversationId, messageId);
  if (!original || original.deletedAt) throw new ChatError('Message not found.', 404);

  const { rows: src } = await getPool().query<{ name: string | null; type: string }>(
    'SELECT name, type FROM conversations WHERE id = $1', [sourceConversationId]);
  // A DM's name is not disclosed to the destination: "forwarded from Ada Umutoni"
  // in a channel would leak who is talking to whom.
  const sourceName = src[0]?.type === 'dm' ? null : (src[0]?.name ?? null);

  const out: Array<{ conversationId: string; result: SendResult }> = [];
  for (const targetId of [...new Set(targetConversationIds)].slice(0, 20)) {
    const membership = await requireMembership(userId, targetId);
    if (membership.isArchived) continue;

    if (comment?.trim()) {
      await sendMessage({
        conversationId: targetId, senderId: userId,
        body: comment.trim(), nonce: `fwd-note-${snowflake()}`,
      });
    }

    const result = await sendMessage({
      conversationId: targetId,
      senderId: userId,
      body: original.body ?? '',
      nonce: `fwd-${messageId}-${targetId}`,
      type: original.type === 'system' ? 'text' : original.type,
      attachments: original.attachments.map((a) => a.fileId),
      // Attribution rides on the message itself, not on a convention in the
      // body text that a client could choose not to render.
      metadata: {
        forwardedFrom: {
          senderId: original.senderId,
          senderName: original.senderName,
          conversationName: sourceName,
          messageId,
          at: original.createdAt,
        },
      },
      system: true,
    });

    await getPool().query(
      `UPDATE messages SET forwarded_from = $3
        WHERE conversation_id = $1 AND id = $2`,
      [targetId, result.message.id, JSON.stringify({
        senderId: original.senderId,
        senderName: original.senderName,
        conversationName: sourceName,
      })],
    );

    out.push({ conversationId: targetId, result });
  }

  if (!out.length) throw new ChatError('Nowhere to forward that to.', 400);
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Jump to a message  (FR-MSG-16)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * A window of messages centred on one.
 *
 * What a permalink, a search result and a "jump to original" all need: the
 * message plus enough either side to read it in context, in one round trip.
 * Fetching the target and then paging backwards would show the message alone
 * for a frame, which is exactly the jarring thing the affordance exists to
 * avoid.
 */
export async function messageContext(
  viewerId: string, conversationId: string, messageId: string, radius = 20,
): Promise<{ messages: WireMessage[]; target: WireMessage; hasMore: boolean }> {
  const { rows: found } = await getPool().query<{ seq: string; thread_root_id: string | null }>(
    'SELECT seq, thread_root_id FROM messages WHERE conversation_id = $1 AND id = $2',
    [conversationId, messageId],
  );
  if (!found[0]) throw new ChatError('Message not found.', 404);
  const seq = Number(found[0].seq);
  const span = Math.min(Math.max(radius, 5), 50);

  const { rows } = await getPool().query<MessageRow>(
    `${MESSAGE_SELECT}
      WHERE m.conversation_id = $2
        AND m.seq BETWEEN $3 AND $4
        AND (m.thread_root_id IS NULL OR m.id = $5)
      ORDER BY m.seq ASC`,
    [viewerId, conversationId, seq - span, seq + span, messageId],
  );

  const count = await memberCountOf(conversationId);
  const messages = rows.map((r) => toWireMessage(r, viewerId, count));
  const target = messages.find((m) => m.id === messageId);
  if (!target) throw new ChatError('Message not found.', 404);

  return { messages, target, hasMore: seq - span > 1 };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Per-user chat preferences  (FR-USR-8)
 * ────────────────────────────────────────────────────────────────────────── */

export interface ChatPrefs {
  readReceipts: boolean;
  enterToSend: boolean;
  desktopNotifications: boolean;
  sound: boolean;
  defaultLevel: NotificationLevel;
  /** Local minutes from midnight. Null on either side means no quiet hours. */
  quietFromMinute: number | null;
  quietToMinute: number | null;
  timezone: string | null;
  showPresence: boolean;
}

const DEFAULT_PREFS: ChatPrefs = {
  readReceipts: true,
  enterToSend: true,
  desktopNotifications: true,
  sound: true,
  defaultLevel: 'all',
  quietFromMinute: null,
  quietToMinute: null,
  timezone: null,
  showPresence: true,
};

export async function getPrefs(userId: string): Promise<ChatPrefs> {
  const { rows } = await getPool().query<{
    read_receipts: boolean; enter_to_send: boolean; desktop_notifications: boolean;
    sound: boolean; default_level: NotificationLevel;
    quiet_from_minute: number | null; quiet_to_minute: number | null;
    timezone: string | null; show_presence: boolean;
  }>('SELECT * FROM user_chat_prefs WHERE user_id = $1', [userId]);

  const r = rows[0];
  // Absent means default, not missing. A user who has never opened settings has
  // preferences; they are simply the ones nobody changed.
  if (!r) return { ...DEFAULT_PREFS };

  return {
    readReceipts: r.read_receipts,
    enterToSend: r.enter_to_send,
    desktopNotifications: r.desktop_notifications,
    sound: r.sound,
    defaultLevel: r.default_level,
    quietFromMinute: r.quiet_from_minute,
    quietToMinute: r.quiet_to_minute,
    timezone: r.timezone,
    showPresence: r.show_presence,
  };
}

export async function setPrefs(
  userId: string, patch: Partial<ChatPrefs>,
): Promise<ChatPrefs> {
  const current = await getPrefs(userId);
  const next = { ...current, ...patch };

  // Quiet hours are stored as minutes-from-midnight rather than a UTC range so
  // a change of timezone does not silently move somebody's evening.
  const minute = (v: number | null | undefined) =>
    (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1440) ? Math.floor(v) : null;

  await getPool().query(
    `INSERT INTO user_chat_prefs
       (user_id, read_receipts, enter_to_send, desktop_notifications, sound,
        default_level, quiet_from_minute, quiet_to_minute, timezone, show_presence, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (user_id) DO UPDATE SET
       read_receipts = EXCLUDED.read_receipts,
       enter_to_send = EXCLUDED.enter_to_send,
       desktop_notifications = EXCLUDED.desktop_notifications,
       sound = EXCLUDED.sound,
       default_level = EXCLUDED.default_level,
       quiet_from_minute = EXCLUDED.quiet_from_minute,
       quiet_to_minute = EXCLUDED.quiet_to_minute,
       timezone = EXCLUDED.timezone,
       show_presence = EXCLUDED.show_presence,
       updated_at = now()`,
    [userId, next.readReceipts, next.enterToSend, next.desktopNotifications, next.sound,
     NOTIFICATION_LEVELS_SET.has(next.defaultLevel) ? next.defaultLevel : 'all',
     minute(next.quietFromMinute), minute(next.quietToMinute),
     next.timezone ?? null, next.showPresence],
  );

  return getPrefs(userId);
}

const NOTIFICATION_LEVELS_SET = new Set<string>(['all', 'mentions', 'none']);

/**
 * Is this moment inside the user's quiet hours?
 *
 * Evaluated against local minutes, and it wraps: 22:00 → 07:00 is a range that
 * crosses midnight, which is what quiet hours almost always are. Getting the
 * wrap wrong means the setting works only for people who sleep during the
 * afternoon.
 *
 * This suppresses the *interruption*, never the record. The notification row is
 * written either way, so it is waiting in the morning.
 */
export function inQuietHours(prefs: ChatPrefs, now = new Date()): boolean {
  const { quietFromMinute: from, quietToMinute: to } = prefs;
  if (from === null || to === null || from === to) return false;

  const minutes = now.getHours() * 60 + now.getMinutes();
  return from < to
    ? minutes >= from && minutes < to
    : minutes >= from || minutes < to;
}
