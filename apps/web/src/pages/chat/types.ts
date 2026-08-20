/**
 * The shapes the chat UI renders.
 *
 * These are deliberately the *view* model, not the wire model. Phase 1 adds the
 * real `/api/conversations` and `/api/messages` endpoints plus the Socket.IO
 * events in `@tupo/shared`; the adapter that maps those onto these types is the
 * only thing that will need to change, and no component will.
 */

export type ConversationKind = 'channel' | 'announcement' | 'group' | 'dm';

export type Presence = 'online' | 'away' | 'busy' | 'offline';

export interface Conversation {
  id: string;
  kind: ConversationKind;
  name: string;
  /** Channel topic, or the person's role/class for a DM. */
  topic?: string;
  avatarUrl?: string;
  /** DMs only — a channel has no single presence. */
  presence?: Presence;
  unread: number;
  /** True when one of those unread messages @-mentions the viewer (UX-9). */
  mention: boolean;
  starred: boolean;
  muted: boolean;
  memberCount?: number;
  lastMessage?: { author: string; preview: string; at: string };
}

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Reaction {
  emoji: string;
  count: number;
  /** Whether the viewer is one of the reactors — drives the highlighted pill. */
  mine: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  size: string;
  kind: 'image' | 'document' | 'other';
}

export interface Message {
  id: string;
  authorId: string;
  authorName: string;
  authorRole?: string;
  avatarUrl?: string;
  body: string;
  /** ISO 8601. Rendered in the viewer's locale and timezone. */
  at: string;
  status?: MessageStatus;
  reactions?: Reaction[];
  /** Number of replies in the thread hanging off this message. */
  replyCount?: number;
  edited?: boolean;
  pinned?: boolean;
  attachments?: Attachment[];
  /** Join/leave/topic-change notices, rendered as a centred line, not a bubble. */
  system?: boolean;
}

export interface Member {
  id: string;
  name: string;
  role: string;
  presence: Presence;
  avatarUrl?: string;
}
