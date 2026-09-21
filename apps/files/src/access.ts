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

export type AccessReason =
  | 'owner' | 'conversation' | 'conversation_avatar' | 'mail' | 'feed'
  | 'oversight' | 'denied' | 'missing';

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

  /*
   * A group/channel logo (0019_conversation_avatar.sql). It is not attached to
   * any message, so the grant above never sees it — without this branch every
   * member except whoever uploaded it gets a 403 and a broken picture.
   *
   * Same rule as the attachment grant, deliberately: membership is the check,
   * and `left_at IS NULL` means leaving the channel takes its logo with it.
   */
  const { rows: viaAvatar } = await getPool().query<{ conversation_id: string }>(
    `SELECT c.id AS conversation_id
       FROM conversations c
       JOIN conversation_members cm
         ON cm.conversation_id = c.id
        AND cm.user_id = $2
        AND cm.left_at IS NULL
      WHERE c.avatar_file_id = $1 AND c.deleted_at IS NULL
      LIMIT 1`,
    [fileId, userId],
  );

  if (viaAvatar[0]) {
    return {
      allowed: true, reason: 'conversation_avatar',
      viaConversationId: viaAvatar[0].conversation_id,
    };
  }

  /*
   * Mail attachments (FR-MAIL-3). The sender of the message it is attached to,
   * or any of its recipients whose mailbox copy still exists, may read it. Same
   * principle as the conversation grant: attachment is the grant, being on the
   * message is the check — there is no capability token in the URL.
   */
  const { rows: viaMail } = await getPool().query(
    `SELECT 1
       FROM mail_attachments a
       JOIN mail_messages m ON m.id = a.message_id
      WHERE a.file_id = $1
        AND (m.from_user_id = $2
             OR EXISTS (SELECT 1 FROM mail_recipients r
                         WHERE r.message_id = m.id AND r.user_id = $2 AND NOT r.is_hidden))
      LIMIT 1`,
    [fileId, userId],
  );
  if (viaMail[0]) return { allowed: true, reason: 'mail' };

  /*
   * Feed media (FR-FEED-2). A page avatar or cover, or an image/video/document
   * carried by a *published, non-deleted* post or one of its comments, is
   * readable by anyone who can see the feed — which is every signed-in user
   * (FEED_VIEW is a baseline permission). The feed list itself is
   * audience-filtered; a stray image URL leaking one audience band to another
   * is not a safeguarding hole the way a conversation attachment would be, so
   * the check here is deliberately coarse: "is this file on something that is
   * actually published".
   */
  const { rows: viaFeed } = await getPool().query(
    `SELECT 1 WHERE
       EXISTS (SELECT 1 FROM feed_pages fp
                WHERE fp.deleted_at IS NULL
                  AND (fp.avatar_file_id = $1 OR fp.cover_file_id = $1))
    OR EXISTS (SELECT 1 FROM feed_posts p, jsonb_array_elements(p.media) m
                WHERE p.deleted_at IS NULL AND p.status = 'published'
                  AND m->>'fileId' = $1)
    OR EXISTS (SELECT 1 FROM feed_comments c
                JOIN feed_posts p ON p.id = c.post_id
                CROSS JOIN LATERAL jsonb_array_elements(c.media) m
                WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL
                  AND m->>'fileId' = $1)
    -- Reels (single media object) and Stories (media array), FR-FEED-13/14:
    -- person-authored, so no page/post row ever carries their file. Without
    -- these two branches only the uploader can play them — everyone else gets
    -- a 404 ticket and a black frame.
    OR EXISTS (SELECT 1 FROM feed_reels r
                WHERE r.deleted_at IS NULL AND r.media->>'fileId' = $1)
    OR EXISTS (SELECT 1 FROM feed_stories s, jsonb_array_elements(s.media) m
                WHERE s.deleted_at IS NULL AND m->>'fileId' = $1)
      LIMIT 1`,
    [fileId],
  );
  if (viaFeed[0]) return { allowed: true, reason: 'feed' };

  /*
   * Academic-conduct oversight (OVERSIGHT_VIEW_ALL).
   *
   * A reviewer with that permission may read any conversation's messages
   * whether or not they are a member (see apps/api routes/oversight.ts), so the
   * attachments carried by those messages have to open too — a redacted photo
   * they cannot see is a hole in the same review. `deleted_at` is deliberately
   * NOT filtered here: a message removed for breaking the rules is exactly the
   * one whose attachment a review needs, and the deleted-message content is
   * shown to oversight anyway. Deliberately last: only reached for a file no
   * ordinary grant covers, checked against the live permission set, not a claim
   * in the token. Same shape as the FILE_DELETE_ANY lookup in the delete route.
   */
  const { rows: viaOversight } = await getPool().query(
    `SELECT 1
       FROM message_attachments ma
       JOIN conversations c ON c.id = ma.conversation_id AND c.deleted_at IS NULL
      WHERE ma.file_id = $1
        AND EXISTS (
          SELECT 1 FROM users u
            JOIN role_permissions rp ON rp.role_id = u.role_id
            JOIN permissions p ON p.id = rp.permission_id
           WHERE u.id = $2 AND p.key = 'OVERSIGHT_VIEW_ALL')
      LIMIT 1`,
    [fileId, userId],
  );
  if (viaOversight[0]) return { allowed: true, reason: 'oversight' };

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
