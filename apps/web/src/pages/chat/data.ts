import { useEffect, useMemo, useState } from 'react';
import type { Conversation, Member, Message } from './types';
import { PLACEHOLDER_CONVERSATIONS, PLACEHOLDER_MEMBERS, PLACEHOLDER_MESSAGES } from './placeholderData';

/**
 * The single seam between the chat UI and its data.
 *
 * Today it resolves the Phase 0 placeholder content after a short delay so the
 * skeleton states (UX-4) are real and reviewable rather than dead code. In
 * Phase 1 the bodies become `apiGet('/api/conversations')` and a Socket.IO
 * subscription; the signatures do not change, so no component is touched.
 */

const LOAD_MS = 350;

export function useConversations(): { conversations: Conversation[]; loading: boolean } {
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setLoading(false), LOAD_MS);
    return () => clearTimeout(t);
  }, []);
  return { conversations: loading ? [] : PLACEHOLDER_CONVERSATIONS, loading };
}

export function useMessages(conversationId: string | null): { messages: Message[]; loading: boolean } {
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => setLoading(false), LOAD_MS);
    return () => clearTimeout(t);
  }, [conversationId]);

  const messages = useMemo(
    () => (!conversationId || loading ? [] : PLACEHOLDER_MESSAGES[conversationId] ?? []),
    [conversationId, loading],
  );
  return { messages, loading };
}

export function useMembers(conversationId: string | null): Member[] {
  return conversationId ? PLACEHOLDER_MEMBERS : [];
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

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

export function startsNewGroup(msg: Message, prev: Message | undefined): boolean {
  if (!prev || prev.system || msg.system) return true;
  if (prev.authorId !== msg.authorId) return true;
  if (dayLabel(prev.at) !== dayLabel(msg.at)) return true;
  return new Date(msg.at).getTime() - new Date(prev.at).getTime() > GROUPING_WINDOW_MS;
}
