import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import type {
  ConversationSummary, MessageType, NotificationLevel, TypingUser, WireMessage,
} from '@tupo/shared';
import { TYPING_THROTTLE_MS } from '@tupo/shared';
import { getSocket } from '../../lib/socket';
import { useAuth } from '../../context/AuthContext';
import * as chatApi from './api';

/**
 * The chat store.
 *
 * One provider owns every piece of chat state, because almost all of it is
 * shared between panes that are siblings rather than ancestors: the sidebar
 * needs the unread count that the thread clears, the composer needs the draft
 * the sidebar shows, the header needs the typing set the thread renders. Lifting
 * it here is what stops those three from each holding their own copy and
 * disagreeing.
 *
 * ── Optimistic send ─────────────────────────────────────────────────────────
 * A message appears the instant it is typed, marked `pending`, keyed by a
 * client-generated nonce. The server's ack carries the real id and seq, and the
 * pending row is *replaced* rather than appended — matched on nonce, so the
 * broadcast copy arriving over the socket at the same moment cannot produce a
 * duplicate. That nonce match is the whole reason a retry is safe.
 */

interface Draft { text: string; savedAt: number }

interface ChatValue {
  conversations: ConversationSummary[];
  conversationsLoading: boolean;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  active: ConversationSummary | null;

  messages: WireMessage[];
  messagesLoading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadOlder: () => Promise<void>;

  typing: TypingUser[];
  connected: boolean;

  send: (input: {
    body: string; replyToId?: string | null; threadRootId?: string | null;
    attachments?: string[]; type?: MessageType;
  }) => Promise<void>;
  retry: (nonce: string) => Promise<void>;
  notifyTyping: () => void;
  markReadTo: (seq: number) => void;

  draftFor: (conversationId: string) => string;
  setDraft: (conversationId: string, text: string) => void;

  toggleStar: (id: string) => Promise<void>;
  setNotificationLevel: (id: string, level: NotificationLevel) => Promise<void>;

  totalUnread: number;
  refresh: () => Promise<void>;
}

const ChatContext = createContext<ChatValue | null>(null);

/** A client-side id for a send, so a retry resolves to the same message. */
const newNonce = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [activeId, setActiveIdRaw] = useState<string | null>(null);

  const [messages, setMessages] = useState<WireMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [typingByConv, setTypingByConv] = useState<Record<string, TypingUser[]>>({});
  const [connected, setConnected] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  /* `activeId` is read inside socket handlers that are registered once. A ref
   * keeps them looking at the current value instead of the one captured when
   * the effect ran — the classic stale-closure bug in a live-updating list. */
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const lastTypingSentAt = useRef(0);
  const draftTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  /* ────────────────────────────────────────────────────────────────────── *
   * Loading
   * ────────────────────────────────────────────────────────────────────── */

  const refresh = useCallback(async () => {
    try {
      const list = await chatApi.listConversations();
      setConversations(list);
      // Server-side drafts follow the user between devices; seed the local
      // cache from them, without clobbering something being typed right now.
      setDrafts((prev) => {
        const next = { ...prev };
        for (const c of list) {
          if (c.draft && !next[c.id]) next[c.id] = { text: c.draft, savedAt: Date.now() };
        }
        return next;
      });
    } finally {
      setConversationsLoading(false);
    }
  }, []);

  useEffect(() => { if (user) void refresh(); }, [user, refresh]);

  /** Load the newest page whenever the open conversation changes. */
  useEffect(() => {
    if (!activeId) { setMessages([]); setHasMore(false); return; }
    let cancelled = false;
    setMessagesLoading(true);
    chatApi.listMessages(activeId, { limit: 40 })
      .then((page) => {
        if (cancelled) return;
        setMessages(page.messages);
        setHasMore(page.hasMore);
      })
      .catch(() => { if (!cancelled) { setMessages([]); setHasMore(false); } })
      .finally(() => { if (!cancelled) setMessagesLoading(false); });
    return () => { cancelled = true; };
  }, [activeId]);

  const loadOlder = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id || loadingMore || !hasMore) return;
    const oldest = messages.find((m) => m.seq > 0);
    if (!oldest) return;

    setLoadingMore(true);
    try {
      const page = await chatApi.listMessages(id, { before: oldest.seq, limit: 40 });
      // Prepend, and de-duplicate by id: a page boundary that overlaps a live
      // message arriving mid-scroll would otherwise show it twice.
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...page.messages.filter((m) => !seen.has(m.id)), ...prev];
      });
      setHasMore(page.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }, [messages, hasMore, loadingMore]);

  /* ────────────────────────────────────────────────────────────────────── *
   * Socket
   * ────────────────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!user) return;
    const socket = getSocket();
    if (!socket) return;

    const onConnect = () => {
      setConnected(true);
      // Re-subscribe on every connect, not just the first. After a reconnect
      // the server has no memory of this socket's rooms.
      const id = activeIdRef.current;
      if (id) socket.emit('conversation:subscribe', { conversationIds: [id] });
      // Counters may have moved while we were away.
      void refresh();
    };
    const onDisconnect = () => setConnected(false);

    const onNew = ({ conversationId, message }: { conversationId: string; message: WireMessage }) => {
      if (conversationId === activeIdRef.current) {
        setMessages((prev) => reconcile(prev, message));
      }
      // The sidebar preview moves whether or not the conversation is open.
      setConversations((prev) => prev.map((c) => c.id === conversationId
        ? {
            ...c,
            lastSeq: Math.max(c.lastSeq, message.seq),
            lastMessage: {
              at: message.createdAt,
              preview: message.body ?? (message.attachments.length ? '📎 Attachment' : ''),
              senderId: message.senderId,
              senderName: message.senderName,
            },
          }
        : c));
    };

    const onUpdated = ({ conversationId, message }: { conversationId: string; message: WireMessage }) => {
      if (conversationId !== activeIdRef.current) return;
      setMessages((prev) => prev.map((m) => (m.id === message.id ? message : m)));
    };

    const onDeleted = ({ conversationId, messageId }: { conversationId: string; messageId: string }) => {
      if (conversationId !== activeIdRef.current) return;
      // Tombstoned in place rather than removed: the message keeps its slot in
      // the log, which is what "This message was deleted" is for.
      setMessages((prev) => prev.map((m) => (m.id === messageId
        ? { ...m, deletedAt: new Date().toISOString(), body: null, attachments: [], reactions: [] }
        : m)));
    };

    const onReaction = (
      { conversationId, messageId, reactions }:
      { conversationId: string; messageId: string; reactions: WireMessage['reactions'] },
    ) => {
      if (conversationId !== activeIdRef.current) return;
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions } : m)));
    };

    const onTyping = ({ conversationId, users }: { conversationId: string; users: TypingUser[] }) => {
      // The server broadcasts the whole set including us; only this client
      // knows which entry is its own, so it drops it here.
      setTypingByConv((prev) => ({
        ...prev, [conversationId]: users.filter((u) => u.userId !== user.id),
      }));
    };

    const onUnread = (
      p: { conversationId: string; unread: number; unreadMentions: number; lastReadSeq: number },
    ) => {
      setConversations((prev) => {
        // Told about a conversation we have never seen — added to a channel, or
        // someone opened a DM with us. Refetch rather than drop it on the
        // floor: a badge for a row that does not exist is a message the person
        // has no way to reach.
        if (!prev.some((c) => c.id === p.conversationId)) {
          void refresh();
          return prev;
        }
        return prev.map((c) => (c.id === p.conversationId
          ? { ...c, unread: p.unread, unreadMentions: p.unreadMentions, lastReadSeq: p.lastReadSeq }
          : c));
      });
    };

    const onConversationUpdated = ({ conversation }: { conversation: ConversationSummary }) => {
      setConversations((prev) => {
        const i = prev.findIndex((c) => c.id === conversation.id);
        if (i === -1) return [conversation, ...prev];
        const next = [...prev];
        next[i] = conversation;
        return next;
      });
    };

    const onPrefs = (
      p: { conversationId: string; isStarred?: boolean; notification?: NotificationLevel },
    ) => {
      setConversations((prev) => prev.map((c) => (c.id === p.conversationId
        ? {
            ...c,
            isStarred: p.isStarred ?? c.isStarred,
            notification: p.notification ?? c.notification,
          }
        : c)));
    };

    const onDraft = ({ conversationId, draft }: { conversationId: string; draft: string | null }) => {
      setDrafts((prev) => ({ ...prev, [conversationId]: { text: draft ?? '', savedAt: Date.now() } }));
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('message:new', onNew);
    socket.on('message:updated', onUpdated);
    socket.on('message:deleted', onDeleted);
    socket.on('message:reaction', onReaction);
    socket.on('typing:update', onTyping);
    socket.on('conversation:unread', onUnread);
    socket.on('conversation:updated', onConversationUpdated);
    socket.on('conversation:prefs', onPrefs);
    socket.on('conversation:draft', onDraft);
    if (socket.connected) onConnect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('message:new', onNew);
      socket.off('message:updated', onUpdated);
      socket.off('message:deleted', onDeleted);
      socket.off('message:reaction', onReaction);
      socket.off('typing:update', onTyping);
      socket.off('conversation:unread', onUnread);
      socket.off('conversation:updated', onConversationUpdated);
      socket.off('conversation:prefs', onPrefs);
      socket.off('conversation:draft', onDraft);
    };
  }, [user, refresh]);

  /** Join the room for whatever is open, and leave the one being left. */
  const setActiveId = useCallback((id: string | null) => {
    const socket = getSocket();
    const previous = activeIdRef.current;
    if (socket && previous && previous !== id) {
      socket.emit('conversation:unsubscribe', { conversationIds: [previous] });
    }
    if (socket && id) socket.emit('conversation:subscribe', { conversationIds: [id] });
    activeIdRef.current = id;
    setActiveIdRaw(id);
  }, []);

  /* ────────────────────────────────────────────────────────────────────── *
   * Sending
   * ────────────────────────────────────────────────────────────────────── */

  const send = useCallback(async (input: {
    body: string; replyToId?: string | null; threadRootId?: string | null;
    attachments?: string[]; type?: MessageType;
  }) => {
    const conversationId = activeIdRef.current;
    if (!conversationId || !user) return;

    const body = input.body.trim();
    if (!body && !(input.attachments?.length)) return;

    const nonce = newNonce();
    const optimistic: WireMessage = {
      id: `pending:${nonce}`,
      conversationId,
      // Sorted after everything real; replaced by the server's value on ack.
      seq: Number.MAX_SAFE_INTEGER,
      type: input.type ?? 'text',
      body: body || null,
      senderId: user.id,
      senderName: user.name,
      senderAvatarUrl: user.avatarUrl ?? null,
      senderRole: null,
      createdAt: new Date().toISOString(),
      editedAt: null, deletedAt: null, nonce,
      reactions: [], attachments: [],
      threadRootId: input.threadRootId ?? null,
      replyCount: 0, threadLastAt: null,
      replyTo: null,
      pinnedAt: null, pinnedBy: null, saved: false, editedCount: 0,
      forwardedFrom: null, mentionsMe: false,
      delivery: 'pending', readCount: 0, metadata: {},
    };

    setMessages((prev) => [...prev, optimistic]);
    setDraft(conversationId, '');

    const payload = {
      conversationId, body, nonce,
      type: input.type, threadRootId: input.threadRootId ?? null,
      replyToId: input.replyToId ?? null, attachments: input.attachments ?? [],
    };

    const socket = getSocket();
    const settle = (message: WireMessage) =>
      setMessages((prev) => reconcile(prev, message, nonce));
    const failed = () =>
      setMessages((prev) => prev.map((m) => (m.nonce === nonce
        ? { ...m, delivery: 'failed' as const } : m)));

    if (socket?.connected) {
      socket.emit('message:send', payload, (r) => {
        if (r?.ok && r.message) settle(r.message);
        else failed();
      });
      return;
    }

    // No socket — fall back to REST with the same nonce, so whichever arrives
    // first wins and the other resolves to the same message.
    try {
      const r = await chatApi.sendMessage(conversationId, payload);
      settle(r.message);
    } catch {
      failed();
    }
  }, [user]);

  const retry = useCallback(async (nonce: string) => {
    const failedMsg = messages.find((m) => m.nonce === nonce);
    if (!failedMsg) return;
    setMessages((prev) => prev.map((m) => (m.nonce === nonce
      ? { ...m, delivery: 'pending' as const } : m)));

    const conversationId = activeIdRef.current;
    if (!conversationId) return;
    try {
      // Same nonce: if the original in fact landed, this resolves to it rather
      // than posting a second copy.
      const r = await chatApi.sendMessage(conversationId, {
        body: failedMsg.body ?? '', nonce,
        threadRootId: failedMsg.threadRootId, replyToId: failedMsg.replyTo?.id ?? null,
      });
      setMessages((prev) => reconcile(prev, r.message, nonce));
    } catch {
      setMessages((prev) => prev.map((m) => (m.nonce === nonce
        ? { ...m, delivery: 'failed' as const } : m)));
    }
  }, [messages]);

  /* ────────────────────────────────────────────────────────────────────── *
   * Typing, reading, drafts
   * ────────────────────────────────────────────────────────────────────── */

  const notifyTyping = useCallback(() => {
    const id = activeIdRef.current;
    const socket = getSocket();
    if (!id || !socket?.connected) return;
    // Throttled client-side. One event per keystroke would be thousands of
    // packets for a piece of information that is true for six seconds.
    const now = Date.now();
    if (now - lastTypingSentAt.current < TYPING_THROTTLE_MS) return;
    lastTypingSentAt.current = now;
    socket.emit('typing:start', { conversationId: id });
  }, []);

  const markReadTo = useCallback((seq: number) => {
    const id = activeIdRef.current;
    if (!id || !Number.isFinite(seq) || seq <= 0) return;
    const current = conversations.find((c) => c.id === id);
    if (current && current.lastReadSeq >= seq) return;

    // Optimistic: the badge must clear the moment the messages are on screen,
    // not a round trip later.
    setConversations((prev) => prev.map((c) => (c.id === id
      ? { ...c, unread: 0, unreadMentions: 0, lastReadSeq: Math.max(c.lastReadSeq, seq) } : c)));

    const socket = getSocket();
    if (socket?.connected) socket.emit('read:advance', { conversationId: id, seq });
    else void chatApi.markRead(id, seq).catch(() => {});
  }, [conversations]);

  const draftFor = useCallback((id: string) => drafts[id]?.text ?? '', [drafts]);

  const setDraft = useCallback((id: string, text: string) => {
    setDrafts((prev) => ({ ...prev, [id]: { text, savedAt: Date.now() } }));
    // Debounced to the server. A draft is worth persisting so it survives a
    // reload and follows you to another device — but not on every keystroke.
    clearTimeout(draftTimers.current[id]);
    draftTimers.current[id] = setTimeout(() => {
      void chatApi.saveDraft(id, text || null).catch(() => {});
    }, 800);
  }, []);

  const toggleStar = useCallback(async (id: string) => {
    const current = conversations.find((c) => c.id === id);
    if (!current) return;
    const next = !current.isStarred;
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, isStarred: next } : c)));
    try { await chatApi.setPrefs(id, { isStarred: next }); }
    catch {
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, isStarred: !next } : c)));
    }
  }, [conversations]);

  const setNotificationLevel = useCallback(async (id: string, level: NotificationLevel) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, notification: level } : c)));
    try { await chatApi.setPrefs(id, { notification: level }); }
    catch { void refresh(); }
  }, [refresh]);

  const totalUnread = useMemo(
    () => conversations.reduce((n, c) => n + (c.notification === 'none' ? 0 : c.unread), 0),
    [conversations],
  );

  const value: ChatValue = {
    conversations, conversationsLoading, activeId, setActiveId, active,
    messages, messagesLoading, hasMore, loadingMore, loadOlder,
    typing: (activeId && typingByConv[activeId]) || [],
    connected,
    send, retry, notifyTyping, markReadTo,
    draftFor, setDraft, toggleStar, setNotificationLevel,
    totalUnread, refresh,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

/**
 * Insert or replace a message in the log.
 *
 * Matched on nonce first, then id. The nonce match is what makes an optimistic
 * bubble *become* the real message instead of sitting beside it: the ack and
 * the socket broadcast both describe the same send, and whichever arrives
 * second must find the row the first one left.
 */
function reconcile(list: WireMessage[], incoming: WireMessage, nonce?: string): WireMessage[] {
  const key = nonce ?? incoming.nonce;
  const at = list.findIndex(
    (m) => m.id === incoming.id || (key && m.nonce === key),
  );
  if (at >= 0) {
    const next = [...list];
    next[at] = incoming;
    return next;
  }
  // Ordered by seq, with pending sends (MAX_SAFE_INTEGER) always last.
  const out = [...list, incoming];
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

export function useChat(): ChatValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used inside <ChatProvider>');
  return ctx;
}
