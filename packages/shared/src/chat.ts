/**
 * The chat wire model.
 *
 * One definition, imported by the API, the realtime gateway and the browser, so
 * a field cannot be written with one shape and read with another. These are the
 * shapes that cross the network; the database rows behind them are snake_case
 * and are mapped once, in `apps/api/src/services/chatService.ts`.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Conversations
 * ────────────────────────────────────────────────────────────────────────── */

export const CONVERSATION_TYPES = ['channel', 'announcement', 'group', 'dm'] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

/** Channel-scoped role (FR-CHN-4), distinct from the platform-wide RBAC role. */
export const MEMBER_ROLES = ['owner', 'admin', 'moderator', 'member', 'guest'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const NOTIFICATION_LEVELS = ['all', 'mentions', 'none'] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export interface ConversationSummary {
  id: string;
  type: ConversationType;
  /** For a DM this is resolved to the *other* person's name, per viewer. */
  name: string;
  slug: string | null;
  topic: string | null;
  description: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  iconEmoji: string | null;
  avatarColor: string | null;
  avatarUrl: string | null;
  memberCount: number;
  lastSeq: number;

  /* Viewer-scoped state — the same conversation looks different to each member. */
  myRole: MemberRole;
  unread: number;
  unreadMentions: number;
  lastReadSeq: number;
  isStarred: boolean;
  notification: NotificationLevel;
  mutedUntil: string | null;
  draft: string | null;

  /** The DM counterpart, so the UI can show presence and open a profile.
   *  `presence` is filled in from Redis by the route, not the database. */
  peer: {
    id: string; name: string; avatarUrl: string | null;
    role: string | null; presence?: string;
  } | null;

  lastMessage: {
    at: string;
    preview: string;
    senderId: string | null;
    senderName: string | null;
  } | null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Messages
 * ────────────────────────────────────────────────────────────────────────── */

export const MESSAGE_TYPES = [
  'text', 'rich_text', 'file', 'image', 'video', 'voice_note',
  'poll', 'system', 'call_event', 'post_share',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Per-recipient delivery state, aggregated for the sender's ✓ / ✓✓ (FR-MSG-13). */
export type DeliveryState = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface WireReaction {
  emoji: string;
  count: number;
  /** Whether the viewer is one of the reactors — drives the highlighted pill. */
  mine: boolean;
  /** Capped at a handful; the full list is fetched on hover. */
  userIds: string[];
}

export interface WireAttachment {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'video' | 'audio' | 'document' | 'other';
  /** Populated for images and video so the grid can reserve the right box. */
  width?: number;
  height?: number;
  durationMs?: number;
  /** Peak samples for a voice note's waveform, 0–1, pre-computed client-side. */
  waveform?: number[];
}

export interface WireMessage {
  id: string;
  conversationId: string;
  seq: number;
  type: MessageType;
  body: string | null;
  senderId: string;
  senderName: string;
  senderAvatarUrl: string | null;
  senderRole: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  /** The client's own id for this send, echoed back so an optimistic row can be
   *  reconciled instead of duplicated (FR-MSG-23). */
  nonce: string | null;

  reactions: WireReaction[];
  attachments: WireAttachment[];

  threadRootId: string | null;
  replyCount: number;
  threadLastAt: string | null;
  /** Quote-reply target, denormalised so the quote block needs no second fetch. */
  replyTo: {
    id: string; senderId: string; senderName: string; body: string | null; deleted: boolean;
  } | null;

  pinnedAt: string | null;
  pinnedBy: string | null;
  saved: boolean;
  editedCount: number;
  forwardedFrom: { senderId: string; senderName: string; conversationName: string | null } | null;

  /** Unfurled links in this message's body (FR-MSG-22). Empty until fetched. */
  linkPreviews: Array<{
    url: string;
    title: string | null;
    description: string | null;
    imageUrl: string | null;
    siteName: string | null;
  }>;

  mentionsMe: boolean;
  /**
   * userId → display name, for every `<@id>` in this message's body.
   *
   * Resolved server-side per page. The client used to infer names from whoever
   * was loaded in the log, which rendered a mention of anyone who had not
   * spoken recently as "@someone".
   */
  mentionNames: Record<string, string>;
  /** Sender-side aggregate: the weakest state across recipients. */
  delivery: DeliveryState;
  /** How many members have read it — shown on the receipt sheet, not the bubble. */
  readCount: number;
  metadata: Record<string, unknown>;
}

export interface MessagePage {
  messages: WireMessage[];
  /** Pass back as `before` to fetch the next page upward. Null at the top. */
  nextCursor: string | null;
  hasMore: boolean;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Members & typing
 * ────────────────────────────────────────────────────────────────────────── */

export interface WireMember {
  userId: string;
  name: string;
  avatarUrl: string | null;
  role: MemberRole;
  platformRole: string | null;
  presence: string;
  joinedAt: string;
  lastReadSeq: number;
}

export interface TypingUser {
  userId: string;
  name: string;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Limits and policy constants
 * ────────────────────────────────────────────────────────────────────────── */

/** Bodies beyond this are rejected at the API, not silently truncated. */
export const MAX_MESSAGE_LENGTH = 8_000;

/** How long a message may be edited after sending (FR-MSG-8). */
export const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One typing event per user per conversation per this window (FR-MSG-14). */
export const TYPING_THROTTLE_MS = 3_000;

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 40;

/** Attachments per message. Beyond this it is a folder, not a message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * The mention grammar.
 *
 * `<@id>` is the canonical stored form — the display name is *not* stored in the
 * body, because a person who changes their name must not leave stale copies of
 * the old one scattered through history. The composer converts a typed
 * "@Aline Uwase" into `<@2161…>` on send, and the renderer resolves it back.
 */
export const MENTION_PATTERN = /<@([A-Za-z0-9_-]{1,64})>/g;
export const BROADCAST_MENTION_PATTERN = /(?:^|\s)@(channel|here|everyone)\b/gi;

/** Emoji offered as one-tap reactions before the picker is opened. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🙏'] as const;
