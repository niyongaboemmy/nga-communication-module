/**
 * Blocking and reporting (B-05, FR-USR-7).
 *
 * A block is personal and mutual in effect: neither person can message the
 * other directly, the blocker is not notified by the blocked person (mentions,
 * replies, reactions), and neither sees the other's presence. It is silent —
 * the blocked person is never told, they simply cannot reach the blocker.
 *
 * A report goes to the moderation queue with a snapshot of the message, so an
 * edit or delete afterwards cannot remove the evidence.
 */
import { getPool, snowflake } from '@tupo/db';
import { ChatError } from './service.js';

export const REPORT_REASONS = ['harassment', 'spam', 'inappropriate', 'safety', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface BlockedPerson { id: string; name: string; avatarUrl: string | null; blockedAt: string }

export async function blockUser(blockerId: string, blockedId: string, reason?: string | null): Promise<void> {
  if (blockerId === blockedId) throw new ChatError('You cannot block yourself.', 400);
  const { rows } = await getPool().query('SELECT 1 FROM users WHERE id = $1', [blockedId]);
  if (!rows.length) throw new ChatError('That person was not found.', 404);
  await getPool().query(
    `INSERT INTO user_blocks (blocker_id, blocked_id, reason) VALUES ($1, $2, $3)
     ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
    [blockerId, blockedId, reason ? String(reason).slice(0, 500) : null],
  );
}

export async function unblockUser(blockerId: string, blockedId: string): Promise<void> {
  await getPool().query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [blockerId, blockedId]);
}

export async function listBlocks(blockerId: string): Promise<BlockedPerson[]> {
  const { rows } = await getPool().query<{ id: string; name: string; avatar_url: string | null; created_at: Date }>(
    `SELECT u.id, u.name, u.avatar_url, b.created_at
       FROM user_blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
    [blockerId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, avatarUrl: r.avatar_url, blockedAt: r.created_at.toISOString() }));
}

/** Is there a block between these two people, either way? */
export async function blockedBetween(a: string, b: string): Promise<{ byMe: boolean; byThem: boolean }> {
  const { rows } = await getPool().query<{ blocker_id: string }>(
    `SELECT blocker_id FROM user_blocks
      WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
    [a, b],
  );
  return { byMe: rows.some((r) => r.blocker_id === a), byThem: rows.some((r) => r.blocker_id === b) };
}

/** Of `userIds`, the people a block separates from `userId` (either direction). */
export async function separatedFrom(userId: string, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const { rows } = await getPool().query<{ other: string }>(
    `SELECT CASE WHEN blocker_id = $1 THEN blocked_id ELSE blocker_id END AS other
       FROM user_blocks
      WHERE (blocker_id = $1 AND blocked_id = ANY($2::text[]))
         OR (blocked_id = $1 AND blocker_id = ANY($2::text[]))`,
    [userId, userIds],
  );
  return new Set(rows.map((r) => r.other));
}

/** Of `recipientIds`, those who have NOT blocked `senderId` — for notifications. */
export async function notBlocking(senderId: string, recipientIds: string[]): Promise<string[]> {
  if (!recipientIds.length) return [];
  const { rows } = await getPool().query<{ blocker_id: string }>(
    'SELECT blocker_id FROM user_blocks WHERE blocked_id = $1 AND blocker_id = ANY($2::text[])',
    [senderId, recipientIds],
  );
  const blockers = new Set(rows.map((r) => r.blocker_id));
  return recipientIds.filter((id) => !blockers.has(id));
}

export interface ReportInput {
  reporterId: string;
  userId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  reason: string;
  details?: string | null;
}

export async function submitReport(input: ReportInput): Promise<{ id: string; duplicate: boolean }> {
  if (!(REPORT_REASONS as readonly string[]).includes(input.reason)) {
    throw new ChatError(`Choose a reason: ${REPORT_REASONS.join(', ')}.`, 400);
  }
  let reportedUserId = input.userId ?? null;
  let excerpt: string | null = null;
  let conversationId: string | null = null;

  if (input.messageId) {
    if (!input.conversationId) throw new ChatError('Which conversation is that message in?', 400);
    // You can only report what you can see.
    const { rows: member } = await getPool().query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL',
      [input.conversationId, input.reporterId]);
    if (!member.length) throw new ChatError('Message not found.', 404);
    const { rows } = await getPool().query<{ sender_id: string; body: string | null }>(
      'SELECT sender_id, body FROM messages WHERE conversation_id = $1 AND id = $2',
      [input.conversationId, input.messageId]);
    if (!rows[0]) throw new ChatError('Message not found.', 404);
    reportedUserId = rows[0].sender_id;
    excerpt = (rows[0].body ?? '').slice(0, 2000);
    conversationId = input.conversationId;
  }
  if (!reportedUserId) throw new ChatError('Report a person or a message.', 400);
  if (reportedUserId === input.reporterId) throw new ChatError('You cannot report yourself.', 400);

  const id = snowflake();
  const { rowCount } = await getPool().query(
    `INSERT INTO user_reports (id, reporter_id, reported_user_id, conversation_id, message_id, message_excerpt, reason, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT DO NOTHING`,
    [id, input.reporterId, reportedUserId, conversationId, input.messageId ?? null, excerpt,
     input.reason, input.details ? String(input.details).slice(0, 2000) : null],
  );
  return { id, duplicate: !rowCount };
}

export interface ReportView {
  id: string; reason: string; details: string | null; status: string;
  reporter: { id: string; name: string };
  reported: { id: string; name: string; avatarUrl: string | null } | null;
  conversationId: string | null; messageId: string | null; messageExcerpt: string | null;
  createdAt: string; resolvedAt: string | null; resolutionNote: string | null;
  priorReports: number;
}

export async function listReports(status: 'open' | 'resolved' | 'dismissed' | 'all' = 'open', limit = 100): Promise<ReportView[]> {
  const { rows } = await getPool().query(
    `SELECT r.*, ru.name AS reporter_name, tu.name AS reported_name, tu.avatar_url AS reported_avatar,
            (SELECT count(*)::int FROM user_reports o WHERE o.reported_user_id = r.reported_user_id AND o.id <> r.id) AS prior
       FROM user_reports r
       JOIN users ru ON ru.id = r.reporter_id
       LEFT JOIN users tu ON tu.id = r.reported_user_id
      WHERE ($1 = 'all' OR r.status = $1)
      ORDER BY r.created_at DESC
      LIMIT $2`,
    [status, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({
    id: r.id, reason: r.reason, details: r.details, status: r.status,
    reporter: { id: r.reporter_id, name: r.reporter_name },
    reported: r.reported_user_id ? { id: r.reported_user_id, name: r.reported_name, avatarUrl: r.reported_avatar } : null,
    conversationId: r.conversation_id, messageId: r.message_id, messageExcerpt: r.message_excerpt,
    createdAt: new Date(r.created_at).toISOString(),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    resolutionNote: r.resolution_note, priorReports: r.prior,
  }));
}

export async function resolveReport(
  id: string, moderatorId: string, status: 'resolved' | 'dismissed', note?: string | null,
): Promise<{ reporterId: string }> {
  if (status !== 'resolved' && status !== 'dismissed') throw new ChatError('Resolve or dismiss.', 400);
  const { rows } = await getPool().query<{ reporter_id: string }>(
    `UPDATE user_reports SET status = $2, resolved_by = $3, resolution_note = $4, resolved_at = now()
      WHERE id = $1 AND status = 'open' RETURNING reporter_id`,
    [id, status, moderatorId, note ? String(note).slice(0, 1000) : null],
  );
  if (!rows[0]) throw new ChatError('That report is not open.', 409);
  return { reporterId: rows[0].reporter_id };
}
