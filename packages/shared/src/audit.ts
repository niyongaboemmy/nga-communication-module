/**
 * Which audit entries are privileged (F-13 / ADMIN2-12).
 *
 * The audit log records two kinds of thing: someone using authority over
 * other people or the system (a role change, a suspension, a moderation
 * removal, reading a conversation under oversight), and someone doing
 * ordinary things with their own content (posting, sending mail). Both are
 * kept; the screen opens on the first kind so a reviewer is not wading
 * through a day of posts to find one role change.
 *
 * Anything not listed here counts as privileged: a new action is shown to
 * reviewers until someone decides it is routine, never the other way round.
 */
export type AuditView = 'privileged' | 'signins' | 'all';

export const AUDIT_SIGNIN_ACTIONS: readonly string[] = ['auth.login'];

/** Exact actions, and prefixes ending in '.', that are routine. */
export const AUDIT_ROUTINE: readonly string[] = [
  'feed.post.create', 'feed.post.edit', 'feed.post.delete',
  'feed.reel.', 'feed.story.',
  'mail.send', 'mail.schedule', 'mail.campaign.create', 'mail.list.create',
  'chat.block', 'chat.unblock', 'chat.report',
];

export function auditViewOf(action: string): Exclude<AuditView, 'all'> | 'routine' {
  if (AUDIT_SIGNIN_ACTIONS.includes(action)) return 'signins';
  return AUDIT_ROUTINE.some((r) => (r.endsWith('.') ? action.startsWith(r) : action === r)) ? 'routine' : 'privileged';
}
