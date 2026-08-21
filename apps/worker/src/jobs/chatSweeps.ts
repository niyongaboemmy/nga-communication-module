import * as chat from '@tupo/chat';

/**
 * Housekeeping for chat.
 *
 * Two sweeps that must happen whether or not anyone is looking:
 *
 *  - **Disappearing messages** (FR-MSG-19). Deleted for real, not tombstoned —
 *    a message that leaves "this was deleted" behind has not disappeared, since
 *    its author, its timing and the fact of it all survive.
 *  - **Expired custom statuses** (FR-USR-4). "Back at 14:00" is only useful if
 *    it stops being true at 14:00.
 *
 * Both are bounded per run. A conversation switched to 24-hour retention after
 * a year of history has a great deal to remove, and doing it in one statement
 * would hold locks on the messages table for as long as it took.
 */
export interface ChatSweepResult {
  messagesDeleted: number;
  statusesCleared: number;
}

export async function runChatSweeps(): Promise<ChatSweepResult> {
  const messagesDeleted = await chat.sweepExpiredMessages(500);
  const statusesCleared = await chat.sweepExpiredStatuses();
  return { messagesDeleted, statusesCleared };
}
