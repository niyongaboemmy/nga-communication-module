import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import type { ActivityKind,
  ConversationSummary, MessageType, NotificationLevel, TypingUser, WireMessage,
} from '@tupo/shared';
import { TYPING_THROTTLE_MS, EDIT_WINDOW_MS } from '@tupo/shared';
import { getSocket } from '../../lib/socket';
import { useAuth } from '../../context/AuthContext';
import { apiGet } from '../../lib/api';
import * as chatApi from './api';
import * as outbox from './outbox';

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
  /** Typing sets for every conversation, so the sidebar can show them too. */
  typingByConversation: Record<string, TypingUser[]>;
  connected: boolean;

  /**
   * Who is online in, and who is actively looking at, each open conversation.
   *
   * Pushed by the gateway whenever the room's membership changes — someone
   * opens the conversation, closes it, or disconnects. Only conversations this
   * client has subscribed to ever appear here.
   */
  conversationPresence: Record<string, { online: string[]; viewing: string[] }>;

  send: (input: {
    body: string; replyToId?: string | null; threadRootId?: string | null;
    attachments?: string[]; type?: MessageType;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  retry: (nonce: string) => Promise<void>;
  react: (messageId: string, emoji: string) => Promise<void>;

  /** The message the composer is answering, if any (FR-MSG-7). */
  replyTarget: WireMessage | null;
  setReplyTarget: (m: WireMessage | null) => void;

  /** The open thread, if any (FR-MSG-6). */
  threadRootId: string | null;
  threadMessages: WireMessage[];
  threadLoading: boolean;
  openThread: (rootId: string | null) => void;
  sendThreadReply: (body: string, alsoSendToChannel: boolean) => Promise<void>;

  pin: (messageId: string, pinned: boolean) => Promise<void>;
  save: (messageId: string, saved: boolean) => Promise<void>;
  forward: (messageId: string, conversationIds: string[], comment?: string) => Promise<void>;

  /** Scroll a specific message into view, loading around it if needed. */
  jumpTo: (messageId: string) => Promise<void>;
  /** Set briefly after a jump so the target can flash. */
  highlightedId: string | null;
  edit: (messageId: string, body: string) => Promise<void>;
  remove: (messageId: string) => Promise<void>;
  /** Messages still waiting for a connection (FR-MSG-24). */
  queued: number;
  /** `kind` widens the indicator past typing — see ActivityKind. */
  notifyTyping: (kind?: ActivityKind) => void;
  markReadTo: (seq: number) => void;
  markEverythingRead: () => Promise<void>;
  /** The newest message of mine that can still be edited — what ↑ targets. */
  lastEditableOwnMessage: () => WireMessage | null;
  /** Which message the log should render in its inline editor, if any. */
  editingId: string | null;
  setEditingId: (id: string | null) => void;

  draftFor: (conversationId: string) => string;
  setDraft: (conversationId: string, text: string) => void;

  toggleStar: (id: string) => Promise<void>;
  setNotificationLevel: (id: string, level: NotificationLevel) => Promise<void>;

  totalUnread: number;
  /** Whether Enter sends, from the user's own preferences (FR-USR-8). */
  enterToSend: boolean;
  refresh: () => Promise<void>;
}

const ChatContext = createContext<ChatValue | null>(null);

/**
 * The one-line summary the sidebar shows for a message that just arrived.
 *
 * Mirrors the server's stored preview, including resolving `<@id>` to a name.
 * The socket path rebuilds it locally so the list moves immediately rather than
 * waiting for a refetch, which means the resolution has to exist in both
 * places — the alternative is a row that reads "You: <@2161…>" until something
 * else happens to reload it.
 */
function previewOf(message: WireMessage): string {
  if (message.body) {
    return message.body.replace(
      /<@([A-Za-z0-9_-]{1,64})>/g,
      (_whole, id: string) => `@${message.mentionNames?.[id] ?? 'someone'}`,
    );
  }
  if (message.type === 'voice_note') return '🎤 Voice message';
  if (message.type === 'poll') return '📊 Poll';
  if (message.attachments.length === 1) return '📎 Attachment';
  if (message.attachments.length > 1) return `📎 ${message.attachments.length} attachments`;
  return '';
}

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
  const [convPresence, setConvPresence] = useState<
    Record<string, { online: string[]; viewing: string[] }>
  >({});
  const [connected, setConnected] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [queued, setQueued] = useState(0);
  const [replyTarget, setReplyTarget] = useState<WireMessage | null>(null);
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<WireMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [enterToSend, setEnterToSend] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);

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

  // One preference reaches this far: whether Enter sends. The rest are read by
  // the notification bridge, which is where they are acted on.
  useEffect(() => {
    if (!user) return;
    apiGet<{ prefs: { enterToSend: boolean } }>('/api/chat/prefs')
      .then((r) => setEnterToSend(r.data!.prefs.enterToSend))
      .catch(() => {});
  }, [user]);

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
    } catch {
      // Deliberately leave hasMore alone. A page that failed to load is not the
      // top of the conversation, and treating it as one silently truncates the
      // history — the next scroll should try again.
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
      // And anything typed while offline goes now, in the order it was typed.
      void flushOutbox();
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
              // Resolved here as well as on the server. The stored preview
              // already has names in it, but this path rebuilds the preview
              // locally so the sidebar moves the instant a message arrives —
              // and using the raw body put "<@2161…>" in front of the reader.
              preview: previewOf(message),
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

    // Presence arrives per person, and the sidebar shows it per DM row, so it
    // is applied to whichever conversation has that person as its counterpart.
    const onPresence = ({ userId, status }: { userId: string; status: string }) => {
      setConversations((prev) => prev.map((c) => (c.peer?.id === userId
        ? { ...c, peer: { ...c.peer, presence: status } }
        : c)));
    };

    const onConvPresence = (p: {
      conversationId: string; online: string[]; viewing: string[];
    }) => {
      setConvPresence((prev) => ({
        ...prev, [p.conversationId]: { online: p.online, viewing: p.viewing },
      }));
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
    socket.on('presence:update', onPresence);
    socket.on('conversation:presence', onConvPresence);
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
      socket.off('presence:update', onPresence);
      socket.off('conversation:presence', onConvPresence);
    };
  }, [user, refresh]);

  /**
   * Send whatever was composed while offline (FR-MSG-24).
   *
   * Strictly in order, stopping at the first failure — delivering a later
   * message before an earlier one is worse than being briefly behind. Each
   * carries the nonce it was created with, so an entry that in fact reached the
   * server before the connection dropped resolves to the message that already
   * exists rather than posting a second copy.
   */
  const flushOutbox = useCallback(async () => {
    const result = await outbox.flush(
      async (entry) => {
        try {
          const r = await chatApi.sendMessage(entry.conversationId, {
            body: entry.body, nonce: entry.nonce,
            threadRootId: entry.threadRootId, replyToId: entry.replyToId,
            attachments: entry.attachments,
          });
          if (entry.conversationId === activeIdRef.current) {
            setMessages((prev) => reconcile(prev, r.message, entry.nonce));
          }
          return true;
        } catch {
          return false;
        }
      },
      (entry) => {
        // Out of retries. Show it as failed on the message itself, where the
        // retry button is, rather than dropping it silently.
        setMessages((prev) => prev.map((m) => (m.nonce === entry.nonce
          ? { ...m, delivery: 'failed' as const } : m)));
      },
    );
    setQueued(result.remaining);
  }, []);

  // Anything left from a previous session goes as soon as the app is up.
  useEffect(() => {
    if (!user) return;
    void outbox.pending().then((q) => setQueued(q.length));
    const onOnline = () => { void flushOutbox(); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [user, flushOutbox]);

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
    // Answering a message in one channel and then switching would otherwise
    // attach the quote to a conversation it does not belong to.
    setReplyTarget(null);
    setEditingId(null);
    setThreadRootId(null);
    setThreadMessages([]);
  }, []);

  /* ────────────────────────────────────────────────────────────────────── *
   * Sending
   * ────────────────────────────────────────────────────────────────────── */

  const markEverythingRead = useCallback(async () => {
    // Applied locally first: the badges are the whole point of the action, and
    // waiting a round trip to see them clear feels like the key did nothing.
    setConversations((prev) => prev.map((c) => ({
      ...c, unread: 0, unreadMentions: 0, lastReadSeq: Math.max(c.lastReadSeq, c.lastSeq),
    })));
    try { await chatApi.markAllRead(); }
    catch { void refresh(); }
  }, [refresh]);

  /**
   * The message ↑ should open for editing.
   *
   * Newest first, mine, not deleted, not a system notice, and still inside the
   * edit window — anything else and the key opens an editor that cannot save.
   */
  const lastEditableOwnMessage = useCallback((): WireMessage | null => {
    if (!user) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.senderId !== user.id) continue;
      if (m.deletedAt || m.type === 'system' || m.delivery === 'pending') continue;
      if (Date.now() - new Date(m.createdAt).getTime() > EDIT_WINDOW_MS) continue;
      return m;
    }
    return null;
  }, [messages, user]);

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


  const send = useCallback(async (input: {
    body: string; replyToId?: string | null; threadRootId?: string | null;
    attachments?: string[]; type?: MessageType;
    metadata?: Record<string, unknown>;
  }) => {
    const conversationId = activeIdRef.current;
    if (!conversationId || !user) return;

    const body = input.body.trim();
    if (!body && !(input.attachments?.length)) return;

    const nonce = newNonce();
    const replyToId = input.replyToId ?? replyTarget?.id ?? null;
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
      replyTo: replyTarget && !input.replyToId
        ? {
            id: replyTarget.id, senderId: replyTarget.senderId,
            senderName: replyTarget.senderName, body: replyTarget.body, deleted: false,
          }
        : null,
      pinnedAt: null, pinnedBy: null, saved: false, editedCount: 0,
      forwardedFrom: null, mentionsMe: false, mentionNames: {}, linkPreviews: [],
      delivery: 'pending', readCount: 0, metadata: input.metadata ?? {},
    };

    setMessages((prev) => [...prev, optimistic]);
    setDraft(conversationId, '');
    setReplyTarget(null);

    const payload = {
      conversationId, body, nonce,
      type: input.type, threadRootId: input.threadRootId ?? null,
      replyToId, attachments: input.attachments ?? [],
      metadata: input.metadata ?? {},
    };

    /*
     * Durable first, then optimistic.
     *
     * The entry is written to IndexedDB *before* the send is attempted, so a
     * tab closed or crashed between typing and delivery still has the message
     * on the next load. It is removed only when the server has acknowledged
     * it — never on a timeout, because "I did not hear back" and "it did not
     * arrive" are different things and only the nonce can tell them apart.
     */
    await outbox.enqueue({
      nonce, conversationId, body,
      replyToId,
      threadRootId: input.threadRootId ?? null,
      attachments: input.attachments ?? [],
    });
    void outbox.pending().then((q) => setQueued(q.length));

    const settle = async (message: WireMessage) => {
      await outbox.dequeue(nonce);
      void outbox.pending().then((q) => setQueued(q.length));
      setMessages((prev) => reconcile(prev, message, nonce));
    };
    const failed = () =>
      setMessages((prev) => prev.map((m) => (m.nonce === nonce
        ? { ...m, delivery: 'failed' as const } : m)));

    const socket = getSocket();
    if (socket?.connected) {
      socket.emit('message:send', payload, (r) => {
        if (r?.ok && r.message) void settle(r.message);
        else failed();
      });
      return;
    }

    // No socket — fall back to REST with the same nonce, so whichever arrives
    // first wins and the other resolves to the same message.
    try {
      const r = await chatApi.sendMessage(conversationId, payload);
      await settle(r.message);
    } catch {
      failed();
    }
  }, [user, setDraft, replyTarget]);

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
   * Reactions, edits, deletions
   * ────────────────────────────────────────────────────────────────────── */

  /**
   * Toggle a reaction, optimistically.
   *
   * The pill has to move on the same frame as the click — a reaction that waits
   * for a round trip feels broken in a way a message does not, because there is
   * no "sending" state a person would accept for one tap. The server's
   * authoritative counts replace this the moment they arrive, over the same
   * `message:reaction` event everyone else receives.
   */
  const react = useCallback(async (messageId: string, emoji: string) => {
    const conversationId = activeIdRef.current;
    if (!conversationId || !user) return;

    setMessages((prev) => prev.map((m) => {
      if (m.id !== messageId) return m;
      const existing = m.reactions.find((r) => r.emoji === emoji);
      if (!existing) {
        return { ...m, reactions: [...m.reactions, { emoji, count: 1, mine: true, userIds: [user.id] }] };
      }
      const count = existing.count + (existing.mine ? -1 : 1);
      const reactions = count <= 0
        ? m.reactions.filter((r) => r.emoji !== emoji)
        : m.reactions.map((r) => (r.emoji === emoji
          ? { ...r, count, mine: !r.mine } : r));
      return { ...m, reactions };
    }));

    const socket = getSocket();
    if (socket?.connected) {
      socket.emit('message:react', { conversationId, messageId, emoji }, (r) => {
        if (r?.ok && r.reactions) {
          setMessages((prev) => prev.map((m) => (m.id === messageId
            ? { ...m, reactions: r.reactions! } : m)));
        }
      });
      return;
    }
    try {
      const r = await chatApi.toggleReaction(conversationId, messageId, emoji);
      setMessages((prev) => prev.map((m) => (m.id === messageId
        ? { ...m, reactions: r.reactions } : m)));
    } catch {
      // Put it back. A reaction that silently did not stick is worse than one
      // that visibly bounced.
      void refresh();
    }
  }, [user, refresh]);

  const edit = useCallback(async (messageId: string, body: string) => {
    const conversationId = activeIdRef.current;
    if (!conversationId) return;
    const message = await chatApi.editMessage(conversationId, messageId, body);
    setMessages((prev) => prev.map((m) => (m.id === messageId ? message : m)));
  }, []);

  const remove = useCallback(async (messageId: string) => {
    const conversationId = activeIdRef.current;
    if (!conversationId) return;
    await chatApi.deleteMessage(conversationId, messageId);
    // The socket broadcast tombstones it for everyone including us, but doing
    // it here too means the row changes on the click rather than on the echo.
    setMessages((prev) => prev.map((m) => (m.id === messageId
      ? { ...m, deletedAt: new Date().toISOString(), body: null, attachments: [], reactions: [] }
      : m)));
  }, []);

  /* ────────────────────────────────────────────────────────────────────── *
   * Threads, pins, saves, forwarding, jumping
   * ────────────────────────────────────────────────────────────────────── */

  const openThread = useCallback((rootId: string | null) => {
    setThreadRootId(rootId);
    setThreadMessages([]);
    if (!rootId) return;
    const conversationId = activeIdRef.current;
    if (!conversationId) return;

    setThreadLoading(true);
    // `thread` returns the root plus its replies — opening a thread without its
    // root shows answers to a question you cannot see.
    chatApi.listMessages(conversationId, { thread: rootId, limit: 100 })
      .then((page) => setThreadMessages(page.messages))
      .catch(() => setThreadMessages([]))
      .finally(() => setThreadLoading(false));
  }, []);

  const sendThreadReply = useCallback(async (body: string, alsoSendToChannel: boolean) => {
    const conversationId = activeIdRef.current;
    const rootId = threadRootId;
    if (!conversationId || !rootId || !body.trim()) return;

    const nonce = newNonce();
    const r = await chatApi.replyInThread(conversationId, rootId, {
      body: body.trim(), nonce, alsoSendToChannel,
    });
    setThreadMessages((prev) => reconcile(prev, r.message, nonce));
    // The parent's reply count moved; the main flow has to show it.
    if (r.root) setMessages((prev) => prev.map((m) => (m.id === r.root!.id ? r.root! : m)));
  }, [threadRootId]);

  const pin = useCallback(async (messageId: string, pinned: boolean) => {
    const conversationId = activeIdRef.current;
    if (!conversationId) return;
    const { message } = await chatApi.setPinned(conversationId, messageId, pinned);
    setMessages((prev) => prev.map((m) => (m.id === messageId ? message : m)));
  }, []);

  const save = useCallback(async (messageId: string, saved: boolean) => {
    const conversationId = activeIdRef.current;
    if (!conversationId) return;
    // Optimistic: saving is a private bookmark with no failure worth a spinner.
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, saved } : m)));
    try { await chatApi.setSaved(conversationId, messageId, saved); }
    catch {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, saved: !saved } : m)));
    }
  }, []);

  const forward = useCallback(async (
    messageId: string, conversationIds: string[], comment?: string,
  ) => {
    const conversationId = activeIdRef.current;
    if (!conversationId) return;
    await chatApi.forwardMessage(conversationId, messageId, conversationIds, comment);
    await refresh();
  }, [refresh]);

  /**
   * Bring a message into view, loading around it if it is not in the window.
   *
   * The already-loaded case is the common one — a quote-reply usually points a
   * few lines up — and re-fetching there would replace the whole log and lose
   * the reader's place for no reason.
   */
  const jumpTo = useCallback(async (messageId: string) => {
    const conversationId = activeIdRef.current;
    if (!conversationId) return;

    const flash = () => {
      setHighlightedId(messageId);
      requestAnimationFrame(() => {
        document.getElementById(`msg-${messageId}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      // Long enough to notice, short enough not to become part of the design.
      setTimeout(() => setHighlightedId((cur) => (cur === messageId ? null : cur)), 2200);
    };

    if (messages.some((m) => m.id === messageId)) { flash(); return; }

    try {
      const context = await chatApi.messageContext(conversationId, messageId);
      setMessages(context.messages);
      setHasMore(context.hasMore);
      flash();
    } catch { /* the message is gone; leave the reader where they are */ }
  }, [messages]);

  /* ────────────────────────────────────────────────────────────────────── *
   * Typing, reading, drafts
   * ────────────────────────────────────────────────────────────────────── */

  const notifyTyping = useCallback((kind: ActivityKind = 'typing') => {
    const id = activeIdRef.current;
    const socket = getSocket();
    if (!id || !socket?.connected) return;
    // Throttled client-side. One event per keystroke would be thousands of
    // packets for a piece of information that is true for six seconds.
    const now = Date.now();
    if (now - lastTypingSentAt.current < TYPING_THROTTLE_MS) return;
    lastTypingSentAt.current = now;
    socket.emit('typing:start', { conversationId: id, kind });
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
    typingByConversation: typingByConv,
    conversationPresence: convPresence,
    connected,
    send, retry, react, edit, remove, notifyTyping, markReadTo, queued,
    markEverythingRead, lastEditableOwnMessage, editingId, setEditingId,
    replyTarget, setReplyTarget,
    threadRootId, threadMessages, threadLoading, openThread, sendThreadReply,
    pin, save, forward, jumpTo, highlightedId,
    draftFor, setDraft, toggleStar, setNotificationLevel,
    totalUnread, refresh, enterToSend,
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
