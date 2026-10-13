import { getPool } from '@tupo/db';
import * as notifications from '@tupo/notify';
import { emitToUsers } from './chatRealtime.js';

/**
 * Reading something clears its notifications (F-01): opening a conversation,
 * a thread, a mail thread, a post or a meeting marks what the bell had about
 * it as read, and every device's bell updates. Best effort — never fails the
 * read that triggered it.
 */
export async function clearNotificationsAbout(userId: string, subjectType: string, subjectIds: string[]): Promise<void> {
  try {
    const ids = await notifications.markSubjectRead(userId, subjectType, subjectIds);
    if (!ids.length) return;
    emitToUsers([userId], 'notification:read', { ids, unread: await notifications.unreadCount(userId) });
  } catch {
    /* the bell catches up on its next fetch */
  }
}

/** A conversation was read to its end: its own notifications, and reactions in it. */
export async function clearConversationNotifications(userId: string, conversationId: string): Promise<void> {
  try {
    const ids = await notifications.markConversationNotificationsRead(userId, conversationId);
    if (ids.length) emitToUsers([userId], 'notification:read', { ids, unread: await notifications.unreadCount(userId) });
  } catch { /* best effort */ }
}

/** A mail thread was opened: the notifications for each message in it. */
export async function clearMailThreadNotifications(userId: string, threadId: string): Promise<void> {
  try {
    const { rows } = await getPool().query<{ id: string }>('SELECT id FROM mail_messages WHERE thread_id = $1', [threadId]);
    if (rows.length) await clearNotificationsAbout(userId, 'mail_message', rows.map((r) => r.id));
  } catch { /* best effort */ }
}
