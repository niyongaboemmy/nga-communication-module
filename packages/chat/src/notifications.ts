import { getPool } from '@tupo/db';
import { notifyAndPush } from '@tupo/notify';
import type { WireMessage } from '@tupo/shared';

/**
 * Who should be told about a message — and, more importantly, who should not.
 *
 * This is the file that decides whether people keep notifications switched on.
 * Every rule here exists because its absence is a reason to mute the app:
 *
 *  1. **Never notify someone about their own action.** Obvious, and the single
 *     most common bug in a fan-out written in a hurry.
 *  2. **A DM always notifies.** Someone wrote to you personally; there is no
 *     reading of "all / mentions / none" where that should be silent, short of
 *     muting that specific conversation.
 *  3. **A channel message notifies only at level `all`.** The default is `all`,
 *     but the whole point of `mentions` is that a busy class channel stops
 *     buzzing.
 *  4. **A mention pierces `mentions`** — that is what the level means — **and
 *     also pierces `all`**, but never pierces `none`. Choosing "nothing" has to
 *     mean nothing, or the setting is a lie.
 *  5. **`@channel` and `@here` are not personal mentions.** They notify people
 *     on `all`, and people on `mentions` only if the sender holds the
 *     permission to address everyone. Otherwise one person typing "@here" turns
 *     every muted channel back on for 400 people.
 *  6. **One notification per conversation.** The unique index on
 *     `(user_id, kind, subject_type, subject_id)` means a burst of fifteen
 *     messages refreshes one row rather than stacking fifteen. The badge
 *     carries the count; the notification carries the fact that something
 *     happened.
 *
 * Quiet hours and desktop/sound preferences are applied by the *client*, not
 * here: the row should exist either way, so it is waiting when someone opens
 * the app in the morning. What is suppressed is the interruption, not the
 * record.
 */

export type ChatNotificationKind = 'chat.dm' | 'chat.mention' | 'chat.message' | 'chat.thread';

interface Recipient {
  user_id: string;
  notification: 'all' | 'mentions' | 'none';
  muted_until: string | null;
}

/**
 * Decide the audience for a new message and write their notifications.
 *
 * Returns the ids actually notified, so callers can log or test the decision
 * rather than having to infer it.
 */
export async function notifyNewMessage(
  message: WireMessage,
  opts: {
    conversationName: string;
    conversationType: string;
    mentionedUserIds: string[];
    broadcast: 'channel' | 'here' | null;
    /** Whether the sender may address everyone (`CHANNEL_ANNOUNCE`). */
    senderMayBroadcast: boolean;
  },
): Promise<string[]> {
  const isDm = opts.conversationType === 'dm';
  const mentioned = new Set(opts.mentionedUserIds);

  const { rows } = await getPool().query<Recipient>(
    `SELECT user_id, notification, muted_until
       FROM conversation_members
      WHERE conversation_id = $1 AND user_id <> $2 AND left_at IS NULL`,
    [message.conversationId, message.senderId],
  );

  const now = Date.now();
  const dm: string[] = [];
  const mentions: string[] = [];
  const plain: string[] = [];

  for (const r of rows) {
    // A conversation muted until a moment in the future is silent, whatever
    // else is true. "Mute for an hour" has to actually mean an hour.
    if (r.muted_until && new Date(r.muted_until).getTime() > now) continue;
    if (r.notification === 'none') continue;

    const personallyMentioned = mentioned.has(r.user_id) && !opts.broadcast;
    const broadcastReaches = Boolean(opts.broadcast)
      && (r.notification === 'all' || opts.senderMayBroadcast);

    if (isDm) dm.push(r.user_id);
    else if (personallyMentioned || broadcastReaches) mentions.push(r.user_id);
    else if (r.notification === 'all') plain.push(r.user_id);
  }

  const preview = previewFor(message);
  const link = `/app/chat/${message.conversationId}`;
  const notified: string[] = [];

  if (dm.length) {
    await notifyAndPush(dm, {
      kind: 'chat.dm',
      title: message.senderName,
      body: preview,
      link,
      subjectType: 'conversation',
      subjectId: message.conversationId,
    });
    notified.push(...dm);
  }

  if (mentions.length) {
    await notifyAndPush(mentions, {
      kind: 'chat.mention',
      title: opts.broadcast
        ? `${message.senderName} in ${opts.conversationName}`
        : `${message.senderName} mentioned you`,
      body: preview,
      link,
      subjectType: 'conversation',
      subjectId: message.conversationId,
    });
    notified.push(...mentions);
  }

  if (plain.length) {
    await notifyAndPush(plain, {
      kind: 'chat.message',
      title: opts.conversationName,
      body: `${message.senderName}: ${preview}`,
      link,
      subjectType: 'conversation',
      subjectId: message.conversationId,
    });
    notified.push(...plain);
  }

  return notified;
}

/** A mention added by editing an existing message (FR-MSG-8 meets FR-MSG-4). */
export async function notifyMention(
  message: WireMessage, userIds: string[], conversationName: string,
): Promise<string[]> {
  const targets = userIds.filter((id) => id !== message.senderId);
  if (!targets.length) return [];
  await notifyAndPush(targets, {
    kind: 'chat.mention',
    title: `${message.senderName} mentioned you`,
    body: previewFor(message),
    link: `/app/chat/${message.conversationId}`,
    subjectType: 'conversation',
    subjectId: message.conversationId,
  });
  return targets;
}

/**
 * What the notification says.
 *
 * Mentions are resolved to real names. They used to be flattened to "@someone"
 * to save a lookup — but this line is the *whole* of what someone sees on a
 * lock screen, and "Aline mentioned you: can @someone cover period 4" is
 * actively worse than no preview: it reads as though somebody else was asked.
 *
 * The names come from `mentionNames`, which the read path already resolved for
 * the whole page, so this costs nothing extra.
 */
function previewFor(m: WireMessage): string {
  if (m.body) {
    return m.body
      .replace(/<@([A-Za-z0-9_-]{1,64})>/g,
        (_whole, id: string) => `@${m.mentionNames?.[id] ?? 'someone'}`)
      .slice(0, 140);
  }
  if (m.type === 'voice_note') return '🎤 Voice message';
  if (m.attachments.length === 1) return `📎 ${m.attachments[0]!.name}`;
  if (m.attachments.length > 1) return `📎 ${m.attachments.length} attachments`;
  return 'Sent a message';
}

/**
 * Someone reacted to something you wrote.
 *
 * Deliberately the quietest notification in the system, and the only one with
 * no "all / mentions / none" reading that makes it loud:
 *
 *  - Only the **author** of the message is told. A reaction is a reply to one
 *    person, not an event in the room.
 *  - Never for your own reaction to your own message.
 *  - It respects `none` and a live mute like everything else, and it does not
 *    pierce "mentions only" — a thumbs-up is not a mention, and treating it as
 *    one is how a channel becomes unmutable.
 *  - One row per message, so ten people reacting to the same post is one
 *    notification with the latest name on it rather than ten.
 */
export async function notifyReaction(
  conversationId: string,
  message: { id: string; senderId: string },
  reactorId: string,
  reactorName: string,
  emoji: string,
): Promise<boolean> {
  if (message.senderId === reactorId) return false;

  const { rows } = await getPool().query<Recipient>(
    `SELECT user_id, notification, muted_until
       FROM conversation_members
      WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [conversationId, message.senderId],
  );
  const author = rows[0];
  if (!author) return false;
  if (author.notification !== 'all') return false;
  if (author.muted_until && new Date(author.muted_until).getTime() > Date.now()) return false;

  await notifyAndPush([author.user_id], {
    kind: 'chat.reaction',
    title: `${reactorName} reacted ${emoji}`,
    body: null,
    link: `/app/chat/${conversationId}`,
    subjectType: 'message',
    subjectId: message.id,
  });
  return true;
}
