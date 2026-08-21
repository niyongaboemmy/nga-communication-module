import { getPool } from '@tupo/db';

/**
 * Who may read a file.
 *
 * Phase 0 shipped `owner_id = caller` and a comment saying conversation-scoped
 * ACLs would arrive later. That is not a missing feature, it is a broken one:
 * the moment a file is attached to a message, every recipient of that message
 * needs to read it, and none of them owns it. An attachment nobody but the
 * sender can open is not an attachment.
 *
 * The rule implemented here:
 *
 *   1. The **owner** may always read their own upload — including before it has
 *      been attached to anything, which is what makes the two-step upload
 *      pipeline (ticket → bytes → send) work at all.
 *   2. Anyone who is a **live member of a conversation the file is attached to**
 *      may read it. Attachment is the grant; membership is the check.
 *   3. Nobody else. Not by guessing an id, and not by having once been a member.
 *
 * Deliberately *not* implemented: a capability token in the URL. A signed link
 * that works for anyone holding it is exactly how a safeguarding incident
 * becomes a forwarded link, and it cannot be revoked when someone leaves a
 * channel. Every download is authorised against live membership, on every
 * request.
 */

export type AccessReason = 'owner' | 'conversation' | 'denied' | 'missing';

export interface AccessDecision {
  allowed: boolean;
  reason: AccessReason;
  /** The conversation that granted access, for the audit trail. */
  viaConversationId?: string;
}

export async function canReadFile(userId: string, fileId: string): Promise<AccessDecision> {
  const { rows } = await getPool().query<{ owner_id: string }>(
    'SELECT owner_id FROM files WHERE id = $1 AND deleted_at IS NULL',
    [fileId],
  );
  if (!rows[0]) return { allowed: false, reason: 'missing' };
  if (rows[0].owner_id === userId) return { allowed: true, reason: 'owner' };

  /*
   * One query, not two. The interesting case — "is this file attached to
   * something this person is still in" — is a single join, and splitting it
   * into "find the conversations" then "check membership" invites the version
   * where the second half is skipped on a fast path.
   *
   * `left_at IS NULL` is the part that matters: a file stays attached to a
   * channel's history forever, but someone who left that channel loses the
   * conversation's grant along with everything else in it.
   */
  const { rows: viaConversation } = await getPool().query<{ conversation_id: string }>(
    `SELECT ma.conversation_id
       FROM message_attachments ma
       JOIN conversation_members cm
         ON cm.conversation_id = ma.conversation_id
        AND cm.user_id = $2
        AND cm.left_at IS NULL
       JOIN conversations c
         ON c.id = ma.conversation_id AND c.deleted_at IS NULL
       -- A file whose message was deleted is no longer shared with anyone. The
       -- tombstone keeps the row; it must not keep the attachment readable.
       JOIN messages m
         ON m.id = ma.message_id AND m.conversation_id = ma.conversation_id
        AND m.deleted_at IS NULL
      WHERE ma.file_id = $1
      LIMIT 1`,
    [fileId, userId],
  );

  if (viaConversation[0]) {
    return {
      allowed: true, reason: 'conversation',
      viaConversationId: viaConversation[0].conversation_id,
    };
  }
  return { allowed: false, reason: 'denied' };
}

/**
 * Who may delete a file.
 *
 * The owner, or a moderator of a conversation it is attached to. Deleting a
 * file is not the same as deleting the message that carried it — a message may
 * be perfectly fine while its attachment is not — so the two are separate
 * actions with separate checks.
 */
export async function canDeleteFile(
  userId: string, fileId: string, hasDeleteAny: boolean,
): Promise<boolean> {
  if (hasDeleteAny) return true;
  const { rows } = await getPool().query<{ owner_id: string }>(
    'SELECT owner_id FROM files WHERE id = $1 AND deleted_at IS NULL', [fileId]);
  if (!rows[0]) return false;
  if (rows[0].owner_id === userId) return true;

  const { rows: mod } = await getPool().query(
    `SELECT 1
       FROM message_attachments ma
       JOIN conversation_members cm
         ON cm.conversation_id = ma.conversation_id AND cm.user_id = $2
        AND cm.left_at IS NULL
        AND cm.role IN ('owner', 'admin', 'moderator')
      WHERE ma.file_id = $1
      LIMIT 1`,
    [fileId, userId],
  );
  return mod.length > 0;
}

/**
 * Files shared in one conversation, newest first — the Files tab.
 *
 * Membership is checked by the caller before this runs; the query then reads
 * only that conversation, so there is no path by which it can return a file
 * from anywhere else.
 */
export interface ConversationFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: string;
  messageId: string;
  senderId: string;
  senderName: string;
  createdAt: string;
}

export async function listConversationFiles(
  conversationId: string, opts: { kind?: string; limit?: number } = {},
): Promise<ConversationFile[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const { rows } = await getPool().query<{
    id: string; original_name: string; mime_type: string; size_bytes: string;
    kind: string; message_id: string; sender_id: string; sender_name: string;
    created_at: string;
  }>(
    `SELECT f.id, f.original_name, f.mime_type, f.size_bytes, ma.kind,
            ma.message_id, m.sender_id, u.name AS sender_name, ma.created_at
       FROM message_attachments ma
       JOIN files f ON f.id = ma.file_id AND f.deleted_at IS NULL
       JOIN messages m
         ON m.id = ma.message_id AND m.conversation_id = ma.conversation_id
        AND m.deleted_at IS NULL
       LEFT JOIN users u ON u.id = m.sender_id
      WHERE ma.conversation_id = $1
        AND ($2::text IS NULL OR ma.kind = $2)
      ORDER BY ma.created_at DESC
      LIMIT $3`,
    [conversationId, opts.kind ?? null, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.original_name,
    mime: r.mime_type,
    size: Number(r.size_bytes),
    kind: r.kind,
    messageId: r.message_id,
    senderId: r.sender_id,
    senderName: r.sender_name ?? 'Unknown',
    createdAt: r.created_at,
  }));
}
