import { apiGet, apiPatch, apiPost, apiPut } from '../../lib/api';
import type {
  ConversationSummary, MessagePage, NotificationLevel, WireMember, WireMessage,
} from '@tupo/shared';

/**
 * The REST half of the chat client.
 *
 * Reads and slow-path writes come through here; sending goes over the socket
 * because the connection is already open. Both reach the same service on the
 * server, so a message posted by either route is identical.
 */

export const listConversations = () =>
  apiGet<{ conversations: ConversationSummary[] }>('/api/chat/conversations')
    .then((r) => r.data!.conversations);

export const getConversation = (id: string) =>
  apiGet<{ conversation: ConversationSummary }>(`/api/chat/conversations/${id}`)
    .then((r) => r.data!.conversation);

export const listMembers = (id: string) =>
  apiGet<{ members: WireMember[] }>(`/api/chat/conversations/${id}/members`)
    .then((r) => r.data!.members);

export interface PageQuery {
  before?: number;
  after?: number;
  limit?: number;
  thread?: string;
}

export const listMessages = (id: string, q: PageQuery = {}) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
  const qs = params.toString();
  return apiGet<MessagePage>(`/api/chat/conversations/${id}/messages${qs ? `?${qs}` : ''}`)
    .then((r) => r.data!);
};

/**
 * Send over REST.
 *
 * The socket is the normal path. This is the fallback the offline queue flushes
 * through when the socket is not up — which is exactly when it matters, so it
 * carries the same nonce and is equally idempotent.
 */
export const sendMessage = (
  id: string,
  payload: {
    body: string; nonce: string; type?: string;
    threadRootId?: string | null; replyToId?: string | null;
    attachments?: string[]; metadata?: Record<string, unknown>;
  },
) => apiPost<{ message: WireMessage; duplicate: boolean }>(
  `/api/chat/conversations/${id}/messages`, payload,
).then((r) => r.data!);

export const markRead = (id: string, seq: number) =>
  apiPost<{ lastReadSeq: number; unread: number; unreadMentions: number }>(
    `/api/chat/conversations/${id}/read`, { seq },
  ).then((r) => r.data!);

export const setPrefs = (
  id: string,
  prefs: { isStarred?: boolean; notification?: NotificationLevel; mutedUntil?: string | null },
) => apiPatch<{ conversation: ConversationSummary }>(
  `/api/chat/conversations/${id}/prefs`, prefs,
).then((r) => r.data!.conversation);

export const saveDraft = (id: string, draft: string | null) =>
  apiPut<{ saved: boolean }>(`/api/chat/conversations/${id}/draft`, { draft });

export const openDirect = (userId: string) =>
  apiPost<{ conversation: ConversationSummary }>('/api/chat/conversations/direct', { userId })
    .then((r) => r.data!.conversation);

export const createConversation = (input: {
  type: 'channel' | 'announcement' | 'group';
  name?: string; topic?: string; description?: string;
  isPrivate?: boolean; iconEmoji?: string; avatarColor?: string; memberIds?: string[];
}) => apiPost<{ conversation: ConversationSummary }>('/api/chat/conversations', input)
  .then((r) => r.data!.conversation);
