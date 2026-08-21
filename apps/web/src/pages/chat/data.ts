import type { ConversationSummary, WireMessage } from '@tupo/shared';

/**
 * Presentation helpers for the chat log.
 *
 * Phase 0 also kept the placeholder data layer here. That is gone: conversations
 * and messages now come from `ChatProvider`, which owns the API calls and the
 * socket. What is left is the formatting and grouping logic, which is pure and
 * belongs nowhere near a fetch.
 */

/** "14:32" — the timestamp beside a message, in the viewer's own locale. */
export const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** "Today" / "Yesterday" / "12 August" — the sticky divider between day runs. */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
}

/** "4m", "2h", "Tue", "12 Aug" — the compact stamp in the conversation list. */
export function shortStamp(iso: string): string {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffMin < 1440) return `${Math.round(diffMin / 60)}h`;
  if (diffMin < 10080) return new Date(iso).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * Consecutive messages from the same author within this window collapse into
 * one block — one avatar, one name, one timestamp. It is the single biggest
 * reason a chat log reads as conversation rather than as a table of rows.
 */
export const GROUPING_WINDOW_MS = 5 * 60_000;

export function startsNewGroup(msg: WireMessage, prev: WireMessage | undefined): boolean {
  if (!prev) return true;
  if (prev.type === 'system' || msg.type === 'system') return true;
  if (prev.senderId !== msg.senderId) return true;
  // A quoted reply always starts its own block: the quote block above it needs
  // room, and hanging it under someone else's avatar reads as their words.
  if (msg.replyTo) return true;
  if (dayLabel(prev.createdAt) !== dayLabel(msg.createdAt)) return true;
  return new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() > GROUPING_WINDOW_MS;
}

/** Bytes as something a person can read: "84 KB", "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const n = bytes / 1024 ** i;
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/**
 * Where the "new messages" divider goes.
 *
 * The first message the viewer has not read, provided they have read *something*
 * — the divider is meaningless above the very first message of a conversation
 * you have never opened, where everything is new and nothing is "since last
 * time".
 */
export function firstUnreadId(
  messages: WireMessage[], lastReadSeq: number, myUserId: string,
): string | null {
  if (!lastReadSeq) return null;
  const first = messages.find(
    (m) => m.seq > lastReadSeq && m.senderId !== myUserId && m.type !== 'system',
  );
  return first?.id ?? null;
}

/** "Aline is typing" · "Aline and Jean-Paul are typing" · "3 people are typing". */
export function typingLabel(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return `${names.length} people are typing`;
}

/** How the sidebar groups conversations (FR-CHN-10). */
export type SidebarSection = 'starred' | 'channels' | 'groups' | 'direct';

export function sectionOf(c: ConversationSummary): SidebarSection {
  if (c.isStarred) return 'starred';
  if (c.type === 'dm') return 'direct';
  if (c.type === 'group') return 'groups';
  return 'channels';
}

export const SECTION_LABEL: Record<SidebarSection, string> = {
  starred: 'Starred',
  channels: 'Channels',
  groups: 'Groups',
  direct: 'Direct messages',
};

export const SECTION_ORDER: SidebarSection[] = ['starred', 'channels', 'groups', 'direct'];
