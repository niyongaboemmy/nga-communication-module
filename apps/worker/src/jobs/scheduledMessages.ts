import { Redis } from 'ioredis';
import * as chat from '@tupo/chat';

/**
 * Send messages whose time has come (FR-MSG-18).
 *
 * Runs on a short repeating interval rather than one delayed job per message.
 * A delayed job per scheduled message sounds tidier and is worse: cancelling
 * means finding and removing a job by id, a Redis flush loses every pending
 * send silently, and the queue becomes the source of truth for something the
 * database already knows. Here the database is authoritative and the worker is
 * just a clock — losing Redis costs a few minutes of punctuality, not a
 * message.
 *
 * Claiming is `FOR UPDATE SKIP LOCKED`, so running two workers is safe: they
 * take disjoint sets rather than both sending the same thing.
 */

const CHAT_CHANNEL = 'tupo:chat';

let publisher: Redis | null = null;

function getPublisher(url: string): Redis | null {
  if (publisher) return publisher;
  try {
    publisher = new Redis(url, {
      lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false,
    });
    publisher.on('error', () => { /* reported by the first failed publish */ });
    void publisher.connect().catch(() => {});
  } catch {
    publisher = null;
  }
  return publisher;
}

export interface ScheduledSweepResult {
  claimed: number;
  sent: number;
  failed: number;
}

export async function runScheduledMessages(redisUrl: string): Promise<ScheduledSweepResult> {
  const due = await chat.claimDueScheduled(20);
  if (!due.length) return { claimed: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (const item of due) {
    try {
      /*
       * Membership is re-checked by `sendMessage` at send time, not at schedule
       * time. Someone who scheduled a message to a channel and then left it
       * must not have it posted on their behalf a week later.
       */
      const result = await chat.sendMessage({
        conversationId: item.conversationId,
        senderId: item.senderId,
        body: item.body,
        // Deterministic, so a retry after a crash between send and mark cannot
        // post the message twice.
        nonce: `sched-${item.id}`,
        attachments: item.attachments,
      });

      await chat.markScheduledSent(item.id, result.message.id);
      sent += 1;

      // Delivered to open sockets through the same relay the API uses, so a
      // scheduled message arrives live rather than on the next refresh.
      const client = getPublisher(redisUrl);
      if (client && result.created) {
        const members = await chat.memberIdsOf(item.conversationId);
        await client.publish(CHAT_CHANNEL, JSON.stringify({
          rooms: [`conv:${item.conversationId}`],
          event: 'message:new',
          payload: { conversationId: item.conversationId, message: result.message },
        })).catch(() => {});

        const counts = await chat.unreadFor(
          members.filter((m) => m !== item.senderId), item.conversationId);
        for (const [userId, c] of Object.entries(counts)) {
          await client.publish(CHAT_CHANNEL, JSON.stringify({
            rooms: [`user:${userId}`],
            event: 'conversation:unread',
            payload: {
              conversationId: item.conversationId,
              unread: c.unread, unreadMentions: c.unreadMentions, lastReadSeq: c.lastReadSeq,
            },
          })).catch(() => {});
        }
      }

      const conversation = await chat.getConversation(item.senderId, item.conversationId)
        .catch(() => null);
      if (result.created) {
        await chat.notifyNewMessage(result.message, {
          conversationName: conversation?.name ?? 'a conversation',
          conversationType: conversation?.type ?? 'channel',
          mentionedUserIds: result.mentionedUserIds,
          broadcast: result.broadcast,
          // A scheduled send cannot check platform permissions from here, so it
          // takes the conservative branch: a broadcast reaches people on `all`
          // and nobody who has narrowed it.
          senderMayBroadcast: false,
        }).catch(() => {});
      }
    } catch (err) {
      // Recorded on the row, so the sender can see *why* in their pending list
      // rather than watching a message quietly never arrive.
      failed += 1;
      await chat.markScheduledFailed(
        item.id, err instanceof Error ? err.message : 'Send failed.',
      ).catch(() => {});
    }
  }

  return { claimed: due.length, sent, failed };
}
