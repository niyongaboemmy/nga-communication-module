/**
 * Academic-conduct oversight.
 *
 * Tupo is a communication tool for a school, so someone accountable has to be
 * able to check what is being said in it — including in private groups and
 * peer-to-peer DMs they are not a member of. That power is deliberately narrow:
 * an oversight reviewer may **read** any conversation and **remove** a message
 * that breaks the rules, and nothing else. They cannot post, join, rename,
 * add members or otherwise take part — reading and redacting are the whole
 * surface.
 *
 * Every function here is gated in the route by `OVERSIGHT_VIEW_ALL` (read) or
 * `OVERSIGHT_MESSAGE_DELETE` (redact), and every read of a conversation's
 * contents and every removal is written to the audit log by the route. The
 * service intentionally does no membership check — that is the point — so it
 * must never be reachable except behind those permissions.
 */
import { getPool } from '@tupo/db';
import type { ConversationType, WireMember } from '@tupo/shared';
import { ChatError, listMembers, refreshPreview } from './service.js';

export interface OversightConversation {
  id: string;
  type: ConversationType;
  /** A channel/group name, or the participants' names for a DM. */
  name: string;
  slug: string | null;
  topic: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  memberCount: number;
  messageCount: number;
  createdAt: string;
  createdById: string | null;
  createdByName: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  /** Participant names, for DMs and groups where the row has no name of its own. */
  participants: string | null;
}

export interface OversightListOptions {
  query?: string;
  type?: ConversationType | 'all';
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

const CONVERSATION_TYPES: ConversationType[] = ['dm', 'group', 'channel', 'announcement'];

/**
 * Every conversation in the institution, newest activity first.
 *
 * Named rows (channels, announcements) match on their name and topic; nameless
 * rows (DMs, groups) match on their participants, so searching a student's name
 * surfaces the DMs they are in. `string_agg` of member names is only computed
 * for the small conversations where it is needed and rendered — a 400-member
 * channel does not get its whole roster concatenated for a list row.
 */
export async function oversightListConversations(
  opts: OversightListOptions = {},
): Promise<{ conversations: OversightConversation[]; total: number }> {
  const q = (opts.query ?? '').trim().toLowerCase();
  const type = opts.type && opts.type !== 'all' && CONVERSATION_TYPES.includes(opts.type)
    ? opts.type : '';
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const archived = opts.includeArchived === true;

  const where = `
    c.deleted_at IS NULL
    AND ($1 = '' OR c.type = $1)
    AND ($2 = true OR c.is_archived = false)
    AND (
      $3 = ''
      OR lower(coalesce(c.name, '')) LIKE '%' || $3 || '%'
      OR lower(coalesce(c.topic, '')) LIKE '%' || $3 || '%'
      OR EXISTS (
        SELECT 1 FROM conversation_members mm
          JOIN users uu ON uu.id = mm.user_id
         WHERE mm.conversation_id = c.id AND mm.left_at IS NULL
           AND lower(uu.name) LIKE '%' || $3 || '%'
      )
    )`;

  const pool = getPool();
  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query<{
      id: string; type: ConversationType; name: string | null; slug: string | null;
      topic: string | null; is_private: boolean; is_archived: boolean;
      member_count: number; message_count: string; created_at: string;
      created_by: string | null; creator_name: string | null;
      last_message_at: string | null; last_message_preview: string | null;
      participants: string | null;
    }>(
      `SELECT c.id, c.type, c.name, c.slug, c.topic, c.is_private, c.is_archived,
              c.member_count, c.created_at, c.created_by, c.last_message_at,
              c.last_message_preview,
              cu.name AS creator_name,
              (SELECT count(*) FROM messages m
                 WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
                   AND m.type <> 'system')::text AS message_count,
              CASE WHEN c.type IN ('dm', 'group') THEN (
                SELECT string_agg(u.name, ', ' ORDER BY u.name)
                  FROM conversation_members m JOIN users u ON u.id = m.user_id
                 WHERE m.conversation_id = c.id AND m.left_at IS NULL
              ) END AS participants
         FROM conversations c
         LEFT JOIN users cu ON cu.id = c.created_by
        WHERE ${where}
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
        LIMIT $4 OFFSET $5`,
      [type, archived, q, limit, offset],
    ),
    pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM conversations c WHERE ${where}`,
      [type, archived, q],
    ),
  ]);

  return {
    total: Number(countRows[0]?.n ?? 0),
    conversations: rows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name ?? r.participants ?? (r.type === 'dm' ? 'Direct message' : 'Untitled'),
      slug: r.slug,
      topic: r.topic,
      isPrivate: r.is_private,
      isArchived: r.is_archived,
      memberCount: r.member_count,
      messageCount: Number(r.message_count),
      createdAt: r.created_at,
      createdById: r.created_by,
      createdByName: r.creator_name,
      lastMessageAt: r.last_message_at,
      lastMessagePreview: r.last_message_preview,
      participants: r.participants,
    })),
  };
}

export interface OversightConversationDetail extends OversightConversation {
  description: string | null;
  members: WireMember[];
}

/** One conversation's metadata and full roster, membership be damned. */
export async function oversightGetConversation(
  conversationId: string,
): Promise<OversightConversationDetail> {
  const { rows } = await getPool().query<{
    id: string; type: ConversationType; name: string | null; slug: string | null;
    topic: string | null; description: string | null; is_private: boolean;
    is_archived: boolean; member_count: number; message_count: string;
    created_at: string; created_by: string | null; creator_name: string | null;
    last_message_at: string | null; last_message_preview: string | null;
  }>(
    `SELECT c.id, c.type, c.name, c.slug, c.topic, c.description, c.is_private,
            c.is_archived, c.member_count, c.created_at, c.created_by,
            c.last_message_at, c.last_message_preview,
            cu.name AS creator_name,
            (SELECT count(*) FROM messages m
               WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
                 AND m.type <> 'system')::text AS message_count
       FROM conversations c
       LEFT JOIN users cu ON cu.id = c.created_by
      WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [conversationId],
  );
  const r = rows[0];
  if (!r) throw new ChatError('Conversation not found.', 404);

  const members = await listMembers(conversationId);
  const participants = r.type === 'dm' || r.type === 'group'
    ? members.map((m) => m.name).sort().join(', ') : null;

  return {
    id: r.id,
    type: r.type,
    name: r.name ?? participants ?? (r.type === 'dm' ? 'Direct message' : 'Untitled'),
    slug: r.slug,
    topic: r.topic,
    description: r.description,
    isPrivate: r.is_private,
    isArchived: r.is_archived,
    memberCount: r.member_count,
    messageCount: Number(r.message_count),
    createdAt: r.created_at,
    createdById: r.created_by,
    createdByName: r.creator_name,
    lastMessageAt: r.last_message_at,
    lastMessagePreview: r.last_message_preview,
    participants,
    members,
  };
}

export interface OversightDeleteResult {
  senderId: string | null;
  senderName: string | null;
  seq: number;
  conversationName: string | null;
  /** The text that was removed, kept only so the audit row can record what it was. */
  removedBody: string | null;
}

/**
 * Redact one message as an oversight action.
 *
 * The same tombstone a moderator delete leaves — the row and its sequence
 * number stay, the body and attachments are cleared, `deleted_by` records who
 * did it — so unread counts, mentions and the sidebar preview all self-heal
 * exactly as they do for an ordinary moderator removal. The caller must pass a
 * reason and must write the audit row; this function only returns what it needs
 * to.
 */
export async function oversightDeleteMessage(
  actorId: string, conversationId: string, messageId: string,
): Promise<OversightDeleteResult> {
  const pool = getPool();
  const { rows } = await pool.query<{
    sender_id: string | null; deleted_at: string | null; type: string;
    seq: string; body: string | null; sender_name: string | null;
    conversation_name: string | null;
  }>(
    `SELECT m.sender_id, m.deleted_at, m.type, m.seq, m.body,
            u.name AS sender_name, c.name AS conversation_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = $1 AND m.id = $2`,
    [conversationId, messageId],
  );
  const row = rows[0];
  if (!row) throw new ChatError('Message not found.', 404);
  if (row.deleted_at) throw new ChatError('That message is already deleted.', 409);
  if (row.type === 'system') throw new ChatError('System messages cannot be removed.', 400);

  await pool.query(
    `UPDATE messages
        SET deleted_at = now(), deleted_by = $3, body = NULL, attachments = '[]'::jsonb
      WHERE conversation_id = $1 AND id = $2`,
    [conversationId, messageId, actorId],
  );
  await pool.query('DELETE FROM message_mentions WHERE message_id = $1', [messageId]);
  await pool.query('DELETE FROM message_reactions WHERE message_id = $1', [messageId]);
  await pool.query(
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
  await refreshPreview(conversationId);

  return {
    senderId: row.sender_id,
    senderName: row.sender_name,
    seq: Number(row.seq),
    conversationName: row.conversation_name,
    removedBody: row.body,
  };
}

/** Headline counts for the oversight landing page. */
export async function oversightStats(): Promise<{
  conversations: number; dms: number; groups: number; channels: number;
  messages: number; redactions: number;
}> {
  const { rows } = await getPool().query<{
    conversations: string; dms: string; groups: string; channels: string;
    messages: string; redactions: string;
  }>(
    `SELECT
       (SELECT count(*) FROM conversations WHERE deleted_at IS NULL)::text AS conversations,
       (SELECT count(*) FROM conversations WHERE deleted_at IS NULL AND type = 'dm')::text AS dms,
       (SELECT count(*) FROM conversations WHERE deleted_at IS NULL AND type = 'group')::text AS groups,
       (SELECT count(*) FROM conversations WHERE deleted_at IS NULL AND type IN ('channel','announcement'))::text AS channels,
       (SELECT count(*) FROM messages WHERE deleted_at IS NULL AND type <> 'system')::text AS messages,
       (SELECT count(*) FROM audit_log WHERE action = 'chat.oversight.message.remove')::text AS redactions`,
  );
  const r = rows[0]!;
  return {
    conversations: Number(r.conversations),
    dms: Number(r.dms),
    groups: Number(r.groups),
    channels: Number(r.channels),
    messages: Number(r.messages),
    redactions: Number(r.redactions),
  };
}
