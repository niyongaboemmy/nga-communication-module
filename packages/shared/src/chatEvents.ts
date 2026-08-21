/**
 * The chat socket catalogue (SRS §9.2).
 *
 * Chat rides the **default namespace**, alongside presence, rather than getting
 * one of its own the way Meet did. Meet is separate because a meeting produces
 * orders of magnitude more traffic than everything else combined and none of it
 * is interesting to a socket that only wants its sidebar kept fresh. Chat is the
 * opposite: it *is* the baseline traffic, and it shares presence and the
 * per-user notification room with the shell.
 *
 * Two room kinds:
 *   `conv:<conversationId>`  everything happening inside one conversation
 *   `user:<userId>`          cross-device state and notifications (already exists)
 *
 * Subscription is authorised against the database at subscribe time and the
 * write path re-checks membership. A socket that stays open across a removal
 * must stop receiving, and "the client asked nicely" is not an access check.
 */

import type {
  ConversationSummary, DeliveryState, MessageType, NotificationLevel,
  TypingUser, WireMessage, WireReaction,
} from './chat.js';

/* ────────────────────────────────────────────────────────────────────────── *
 * Client → server
 * ────────────────────────────────────────────────────────────────────────── */

export interface ChatClientToServerEvents {
  'conversation:subscribe': (
    p: { conversationIds: string[] },
    ack?: (r: { ok: boolean; subscribed: string[]; denied: string[] }) => void,
  ) => void;

  'conversation:unsubscribe': (p: { conversationIds: string[] }) => void;

  /**
   * Sending over the socket rather than REST.
   *
   * The round trip is already open, so this saves a TCP+TLS handshake on the
   * single most latency-visible action in the product, and the ack carries the
   * server-assigned id and seq back to the optimistic row that is already on
   * screen. The REST route exists too, and shares the same service function —
   * it is what the offline queue flushes through and what integrations use.
   */
  'message:send': (
    p: {
      conversationId: string;
      body: string;
      nonce: string;
      type?: MessageType;
      threadRootId?: string | null;
      replyToId?: string | null;
      alsoSendToChannel?: boolean;
      attachments?: string[];
      metadata?: Record<string, unknown>;
    },
    ack?: (r: { ok: boolean; message?: WireMessage; error?: string }) => void,
  ) => void;

  'message:edit': (
    p: { conversationId: string; messageId: string; body: string },
    ack?: (r: { ok: boolean; message?: WireMessage; error?: string }) => void,
  ) => void;

  'message:delete': (
    p: { conversationId: string; messageId: string },
    ack?: (r: { ok: boolean; error?: string }) => void,
  ) => void;

  'message:react': (
    p: { conversationId: string; messageId: string; emoji: string },
    ack?: (r: { ok: boolean; reactions?: WireReaction[]; error?: string }) => void,
  ) => void;

  /** Throttled client-side to one per TYPING_THROTTLE_MS; TTL'd server-side. */
  'typing:start': (p: { conversationId: string }) => void;
  'typing:stop': (p: { conversationId: string }) => void;

  /**
   * Advance the read watermark. Monotonic — a lower seq is ignored rather than
   * rejected, because two tabs racing is normal and neither is wrong.
   */
  'read:advance': (
    p: { conversationId: string; seq: number },
    ack?: (r: { ok: boolean; unread: number; unreadMentions: number }) => void,
  ) => void;

  /** Mark messages delivered — fired on receipt, before the user has read them. */
  'receipt:delivered': (p: { conversationId: string; messageIds: string[] }) => void;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Server → client
 * ────────────────────────────────────────────────────────────────────────── */

export interface ChatServerToClientEvents {
  /** A new message in a conversation this socket is subscribed to. */
  'message:new': (p: { conversationId: string; message: WireMessage }) => void;

  /** Edits, un/pins, reply-count bumps — anything that changes an existing row. */
  'message:updated': (p: { conversationId: string; message: WireMessage }) => void;

  'message:deleted': (
    p: { conversationId: string; messageId: string; deletedBy: string; byModerator: boolean },
  ) => void;

  'message:reaction': (
    p: { conversationId: string; messageId: string; reactions: WireReaction[] },
  ) => void;

  /** The complete current set for the conversation, not a delta — a delta stream
   *  of a 6-second-lived state is not worth the reconciliation bugs. */
  'typing:update': (p: { conversationId: string; users: TypingUser[] }) => void;

  /** Someone else advanced their watermark: repaint their avatar on the log. */
  'read:update': (
    p: { conversationId: string; userId: string; seq: number; at: string },
  ) => void;

  /** The sender's own view of how far a message has got (FR-MSG-13). */
  'receipt:update': (
    p: { conversationId: string; messageId: string; delivery: DeliveryState; readCount: number },
  ) => void;

  /**
   * Unread counters for *this* user, on their `user:` room.
   *
   * Delivered separately from `message:new` because it must reach devices that
   * are not subscribed to the conversation — the whole point of a sidebar badge
   * is that it works for the channel you do not currently have open. It is also
   * what makes reading on your phone clear the badge on your laptop.
   */
  'conversation:unread': (
    p: { conversationId: string; unread: number; unreadMentions: number; lastReadSeq: number },
  ) => void;

  /** Metadata changed (topic, name, archive, member count) or a conversation
   *  became visible to this user for the first time. */
  'conversation:updated': (p: { conversation: ConversationSummary }) => void;

  'conversation:member_changed': (
    p: {
      conversationId: string;
      userId: string;
      action: 'joined' | 'left' | 'removed' | 'role_changed';
      role?: string;
      memberCount: number;
    },
  ) => void;

  /** Per-conversation preference changed on another device. */
  'conversation:prefs': (
    p: {
      conversationId: string;
      isStarred?: boolean;
      notification?: NotificationLevel;
      mutedUntil?: string | null;
    },
  ) => void;

  /** A draft saved on another device (FR-MSG-17). */
  'conversation:draft': (
    p: { conversationId: string; draft: string | null; at: string },
  ) => void;
}

/** Redis key for the typing set of one conversation. Value is a hash of
 *  userId → name, each field refreshed on every keystroke burst. */
export const typingKey = (conversationId: string) => `typing:${conversationId}`;

export const conversationRoom = (conversationId: string) => `conv:${conversationId}`;
export const userRoom = (userId: string) => `user:${userId}`;
