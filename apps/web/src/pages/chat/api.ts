import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '../../lib/api';
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

/* ────────────────────────────────────────────────────────────────────────── *
 * Reactions, edits, deletions
 * ────────────────────────────────────────────────────────────────────────── */

export const toggleReaction = (conversationId: string, messageId: string, emoji: string) =>
  apiPost<{ reactions: WireMessage['reactions']; added: boolean }>(
    `/api/chat/conversations/${conversationId}/messages/${messageId}/reactions`, { emoji },
  ).then((r) => r.data!);

export const reactorNames = (conversationId: string, messageId: string, emoji: string) =>
  apiGet<{ names: string[] }>(
    `/api/chat/conversations/${conversationId}/messages/${messageId}/reactions?emoji=${encodeURIComponent(emoji)}`,
  ).then((r) => r.data!.names);

export const editMessage = (conversationId: string, messageId: string, body: string) =>
  apiPatch<{ message: WireMessage }>(
    `/api/chat/conversations/${conversationId}/messages/${messageId}`, { body },
  ).then((r) => r.data!.message);

export const editHistory = (conversationId: string, messageId: string) =>
  apiGet<{ versions: Array<{ body: string | null; at: string; editorName: string }> }>(
    `/api/chat/conversations/${conversationId}/messages/${messageId}/history`,
  ).then((r) => r.data!.versions);

export const deleteMessage = (conversationId: string, messageId: string) =>
  apiDelete<{ deleted: boolean; byModerator: boolean }>(
    `/api/chat/conversations/${conversationId}/messages/${messageId}`,
  ).then((r) => r.data!);

/* ────────────────────────────────────────────────────────────────────────── *
 * Threads, pins, saves, forwarding, permalinks
 * ────────────────────────────────────────────────────────────────────────── */

export const replyInThread = (
  conversationId: string, rootId: string,
  payload: { body: string; nonce: string; attachments?: string[]; alsoSendToChannel?: boolean },
) => apiPost<{ message: WireMessage; root: WireMessage | null; duplicate: boolean }>(
  `/api/chat/conversations/${conversationId}/messages/${rootId}/replies`, payload,
).then((r) => r.data!);

export const listPinned = (conversationId: string) =>
  apiGet<{ messages: WireMessage[] }>(`/api/chat/conversations/${conversationId}/pins`)
    .then((r) => r.data!.messages);

export const setPinned = (conversationId: string, messageId: string, pinned: boolean) =>
  apiPost<{ message: WireMessage; pinned: boolean }>(
    `/api/chat/conversations/${conversationId}/messages/${messageId}/pin`, { pinned },
  ).then((r) => r.data!);

export const setSaved = (conversationId: string, messageId: string, saved: boolean) =>
  apiPost<{ saved: boolean }>(
    `/api/chat/conversations/${conversationId}/messages/${messageId}/save`, { saved },
  ).then((r) => r.data!.saved);

export interface SavedItem {
  message: WireMessage;
  conversationName: string;
  conversationType: string;
}

export const listSaved = () =>
  apiGet<{ items: SavedItem[] }>('/api/chat/saved').then((r) => r.data!.items);

export const forwardMessage = (
  conversationId: string, messageId: string, conversationIds: string[], comment?: string,
) => apiPost<{ forwarded: string[] }>(
  `/api/chat/conversations/${conversationId}/messages/${messageId}/forward`,
  { conversationIds, comment },
).then((r) => r.data!.forwarded);

export const messageContext = (conversationId: string, messageId: string, radius = 20) =>
  apiGet<{ messages: WireMessage[]; target: WireMessage; hasMore: boolean }>(
    `/api/chat/conversations/${conversationId}/messages/${messageId}/context?radius=${radius}`,
  ).then((r) => r.data!);
