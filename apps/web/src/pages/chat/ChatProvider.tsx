import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import type { ActivityKind,
  ConversationSummary, MessageType, NotificationLevel, TypingUser, WireMessage,
} from '@tupo/shared';
import { TYPING_THROTTLE_MS, EDIT_WINDOW_MS } from '@tupo/shared';
import { getSocket, onSocket } from '../../lib/socket';
import { useAuth } from '../../context/AuthContext';
import { apiGet } from '../../lib/api';
import * as chatApi from './api';
import * as outbox from './outbox';
import { cacheGet, cacheSet, debouncedWriter } from '../../lib/localStore';
import { closeConversationNotifications } from '../../lib/swSession';

/** Newest messages kept on the device per conversation (P-02). */
const CACHED_MESSAGES = 100;

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
  /** The conversation list failed to load (F-06): show an error with a retry, not "No conversations yet". */
  conversationsError: boolean;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  active: ConversationSummary | null;

  messages: WireMessage[];
  messagesLoading: boolean;
  /** Which conversation `messages` currently belongs to (null while switching). */
  messagesConversationId: string | null;
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
  /** Drop a message that failed to send. */
  discard: (nonce: string) => Promise<void>;
  react: (messageId: string, emoji: string) => Promise<void>;

  /** The message the composer is answering, if any (FR-MSG-7). */
  replyTarget: WireMessage | null;
  setReplyTarget: (m: WireMessage | null) => void;

  /** The open thread, if any (FR-MSG-6). */
  threadRootId: string | null;
  threadMessages: WireMessage[];
  threadLoading: boolean;
  openThread: (rootId: string | null) => void;
  sendThreadReply: (body: string, alsoSendToChannel: boolean, attachments?: string[]) => Promise<void>;

  pin: (messageId: string, pinned: boolean) => Promise<void>;
  save: (messageId: string, saved: boolean) => Promise<void>;
  forward: (messageId: string, conversationIds: string[], comment?: string) => Promise<void>;

  /** Scroll a specific message into view, loading around it if needed. */
  jumpTo: (messageId: string) => Promise<void>;
  /** After a jump to an old message: newer ones exist that are not loaded (U-04). */
  hasNewer: boolean;
  loadNewer: () => Promise<void>;
  /** Back to the newest page, wherever the log is now. */
  showLatest: () => Promise<void>;
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
  /** Mute until a time (B-13); null unmutes. `forever` is the old "Mute". */
  muteUntil: (id: string, until: string | null | 'forever') => Promise<void>;
  /** Hide a direct message until the other person writes again (B-13). */
  hideConversation: (id: string) => Promise<void>;

  /** Unread across every conversation the person has not muted. */
  totalUnread: number;
  /** Unread mentions across every conversation, muted or not. */
  totalMentions: number;
  /**
   * New replies per followed thread, keyed by root message id. Thread replies
   * never move a conversation's own badge; they are counted here instead.
   */
  threadUnread: Record<string, number>;
  /** Sum of `threadUnread` — the Threads entry's badge. */
  threadsUnreadTotal: number;
  /** The reader has seen the open thread up to `seq`. */
  markThreadRead: (rootId: string, seq: number) => void;
  /** "Mark as unread": bring a conversation back to the reader's attention. */
  markUnread: (conversationId: string, fromSeq?: number) => Promise<void>;
  /** Mark one (not necessarily open) conversation read to its newest message. */
  markConversationRead: (conversationId: string) => void;
  /** Whether Enter sends, from the user's own preferences (FR-USR-8). */
  enterToSend: boolean;
  refresh: () => Promise<void>;
  /** People this reader has blocked (B-05). */
  blockedIds: ReadonlySet<string>;
  setBlocked: (userId: string, blocked: boolean) => Promise<void>;
}

const ChatContext = createContext<ChatValue | null>(null);

/**
 * Make a broadcast message this reader's own (X-01).
 *
 * A message that arrives over the socket was built for whoever caused the
 * event — the sender, the editor, the reactor — so its personal fields are
 * theirs: their saved flag, whether it mentions *them*, which reactions are
 * *theirs*. Taken as-is, someone else's edit unsaved my bookmark and their
 * reaction lit up my pill. These are worked out again for this reader, from
 * the shared fields and from what this client already knew.
 */
export function personalise(incoming: WireMessage, me: string, prev?: WireMessage | null): WireMessage {
  return {
    ...incoming,
    saved: prev?.saved ?? false,
    mentionsMe: Boolean(incoming.mentionNames && me in incoming.mentionNames) || (prev?.mentionsMe ?? false),
    reactions: personaliseReactions(incoming.reactions, me, prev?.reactions),
    // Delivery ticks are the sender's view; on someone else's message they mean nothing.
    delivery: incoming.senderId === me ? incoming.delivery : (prev?.delivery ?? incoming.delivery),
  };
}

export function personaliseReactions(
  incoming: WireMessage['reactions'], me: string, prev?: WireMessage['reactions'],
): WireMessage['reactions'] {
  return incoming.map((r) => {
    // userIds is capped; when the list is complete it is the truth, otherwise
    // fall back to what this client knew about its own reaction.
    const complete = r.userIds.length >= r.count;
    const before = prev?.find((x) => x.emoji === r.emoji)?.mine ?? false;
    return { ...r, mine: r.userIds.includes(me) || (!complete && before) };
  });
}


/**
 * Whether a conversation is muted right now. A timed mute that has run out is
 * not a mute: treating it as one hides the badge of a conversation the person
 * expects to hear from again.
 */
export function isMuted(c: Pick<ConversationSummary, 'notification' | 'mutedUntil'>): boolean {
  if (c.notification === 'none') return true;
  return Boolean(c.mutedUntil && new Date(c.mutedUntil).getTime() > Date.now());
}

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
  const [conversationsError, setConversationsError] = useState(false);
  const [activeId, setActiveIdRaw] = useState<string | null>(null);

  const [messages, setMessages] = useState<WireMessage[]>([]);
  const messagesRef = useRef<WireMessage[]>([]);
  const [hasNewer, setHasNewer] = useState(false);
  const hasNewerRef = useRef(false);
  hasNewerRef.current = hasNewer;
  messagesRef.current = messages;
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesConversationId, setMessagesConversationId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [typingByConv, setTypingByConv] = useState<Record<string, TypingUser[]>>({});
  /** When each conversation's typing set last arrived. */
  const typingSeenAt = useRef<Record<string, number>>({});

  /*
   * A typing set that has not been refreshed for a few seconds is over, even
   * if the "stop" never arrived (the sender's network dropped, their tab went
   * to sleep). Without this the indicator stayed until the next event.
   */
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now();
      setTypingByConv((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [id, users] of Object.entries(prev)) {
          if (users.length && now - (typingSeenAt.current[id] ?? 0) > 7000) { next[id] = []; changed = true; }
        }
        return changed ? next : prev;
      });
    }, 1500);
    return () => window.clearInterval(t);
  }, []);
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
  const [threadUnread, setThreadUnread] = useState<Record<string, number>>({});
  const threadRootRef = useRef<string | null>(null);
  threadRootRef.current = threadRootId;
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [enterToSend, setEnterToSend] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);

  /* `activeId` is read inside socket handlers that are registered once. A ref
   * keeps them looking at the current value instead of the one captured when
   * the effect ran — the classic stale-closure bug in a live-updating list. */
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const lastTypingSentAt = useRef(0);
  /** What each unsent message was, for an exact retry. */
  const pendingPayloads = useRef(new Map<string, Parameters<typeof chatApi.sendMessage>[1]>());
  const draftTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  /* ────────────────────────────────────────────────────────────────────── *
   * Loading
   * ────────────────────────────────────────────────────────────────────── */

  /*
   * Prefetch (P-09): the newest page of the few conversations most likely to be
   * opened next — unread ones, newest first — goes onto the device while the
   * browser is idle. Opening one is then instant, as in WhatsApp. Skipped on
   * Save-Data and slow links, and never for the conversation already open.
   */
  const prefetched = useRef(new Map<string, number>());
  const prefetchUnread = useCallback((list: ConversationSummary[]) => {
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (conn?.saveData || conn?.effectiveType === '2g' || conn?.effectiveType === 'slow-2g') return;
    const targets = list
      .filter((c) => c.unread > 0 && !c.subjectId && c.id !== activeIdRef.current
        && prefetched.current.get(c.id) !== c.lastSeq)
      .slice(0, 5);
    if (!targets.length) return;
    const idle = (cb: () => void) => ('requestIdleCallback' in window
      ? window.requestIdleCallback(cb, { timeout: 5000 })
      : globalThis.setTimeout(cb, 2000));
    idle(() => {
      void (async () => {
        for (const c of targets) {
          try {
            const page = await chatApi.listMessages(c.id, { limit: 40 });
            prefetched.current.set(c.id, c.lastSeq);
            await cacheSet(`chat:msgs:${c.id}`, page.messages);
          } catch { return; /* offline or refused: stop, it is only a head start */ }
        }
      })();
    });
  }, []);

  /*
   * Refreshes can overlap (coming back online starts one, the socket's
   * reconnect another a moment later). Only the newest request's answer is
   * applied: an older one finishing last would put back a stale list.
   */
  const refreshSeq = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++refreshSeq.current;
    try {
      const list = await chatApi.listConversations();
      if (mine !== refreshSeq.current) return;
      listFromNetwork.current = true;
      setConversations(list);
      prefetchUnread(list);
      setConversationsError(false);
      // Server-side drafts follow the user between devices; seed the local
      // cache from them, without clobbering something being typed right now.
      setDrafts((prev) => {
        const next = { ...prev };
        for (const c of list) {
          if (c.draft && !next[c.id]) next[c.id] = { text: c.draft, savedAt: Date.now() };
        }
        return next;
      });
    } catch {
      setConversationsError(true);
    } finally {
      setConversationsLoading(false);
    }
  }, []);

  /*
   * Local first (P-03): the list from the device renders at once, then the
   * network copy replaces it. The cache never overwrites what the network
   * already delivered, and an empty cache changes nothing.
   */
  const listFromNetwork = useRef(false);
  useEffect(() => {
    if (!user) return;
    listFromNetwork.current = false;
    let cancelled = false;
    void cacheGet<ConversationSummary[]>('chat:conversations').then((cached) => {
      if (cancelled || listFromNetwork.current || !cached?.length) return;
      setConversations(cached);
      setConversationsLoading(false);
    });
    void refresh();
    return () => { cancelled = true; };
  }, [user, refresh]);

  const saveConversations = useMemo(() => debouncedWriter<ConversationSummary[]>(() => 'chat:conversations'), []);
  useEffect(() => {
    if (listFromNetwork.current) saveConversations(conversations);
  }, [conversations, saveConversations]);
  // The offline queue belongs to whoever is signed in.
  useEffect(() => { outbox.setOutboxOwner(user?.id ?? null); }, [user]);

  /** Seed the per-thread counters from the Threads inbox. */
  const refreshThreadUnread = useCallback(async () => {
    try {
      const threads = await chatApi.listFollowedThreads();
      setThreadUnread(Object.fromEntries(threads.filter((t) => t.unread > 0).map((t) => [t.rootId, t.unread])));
    } catch { /* a missing marker is not worth an error */ }
  }, []);
  useEffect(() => { if (user) void refreshThreadUnread(); }, [user, refreshThreadUnread]);

  // One preference reaches this far: whether Enter sends. The rest are read by
  // the notification bridge, which is where they are acted on.
  useEffect(() => {
    if (!user) return;
    apiGet<{ prefs: { enterToSend: boolean } }>('/api/chat/prefs')
      .then((r) => setEnterToSend(r.data!.prefs.enterToSend))
      .catch(() => {});
  }, [user]);

  /** An outbox entry, drawn as the pending message it will become. */
  const queuedAsMessage = (e: outbox.OutboxEntry): WireMessage => ({
    id: `queued-${e.nonce}`, conversationId: e.conversationId, seq: Number.MAX_SAFE_INTEGER,
    type: (e.type as MessageType) ?? 'text', body: e.body || null,
    senderId: user?.id ?? '', senderName: user?.name ?? '', senderAvatarUrl: user?.avatarUrl ?? null, senderRole: null,
    createdAt: new Date(e.createdAt).toISOString(), editedAt: null, deletedAt: null, deletedBy: null, nonce: e.nonce,
    reactions: [], attachments: [], threadRootId: e.threadRootId, replyCount: 0, threadLastAt: null, replyTo: null,
    pinnedAt: null, pinnedBy: null, saved: false, editedCount: 0, forwardedFrom: null, mentionsMe: false,
    mentionNames: {}, linkPreviews: [],
    delivery: e.attempts >= outbox.MAX_ATTEMPTS ? 'failed' : 'pending', readCount: 0, metadata: e.metadata ?? {},
  });

  /** Counts windows loaded by jumpTo, so a slower first page cannot undo one. */
  const jumps = useRef(0);
  /** The conversation whose first page has come from the network (not the device). */
  const networkPageFor = useRef<string | null>(null);

  /** Load the newest page whenever the open conversation changes. */
  useEffect(() => {
    setMessagesConversationId(null);
    networkPageFor.current = null;
    setHasNewer(false);
    if (!activeId) { setMessages([]); setHasMore(false); return; }
    let cancelled = false;
    let fromNetwork = false;
    let fromCache = false;
    const jumpsAtStart = jumps.current;
    setMessagesLoading(true);
    // The newest messages from the device first (P-03): opening a conversation
    // already seen is instant, and the page below replaces them.
    void cacheGet<WireMessage[]>(`chat:msgs:${activeId}`).then((cached) => {
      if (cancelled || fromNetwork || !cached?.length) return;
      fromCache = true;
      setMessages(cached);
      setHasMore(true);
      setMessagesConversationId(activeId);
      setMessagesLoading(false);
    });
    Promise.all([chatApi.listMessages(activeId, { limit: 40 }), outbox.pending().catch(() => [])])
      .then(([page, queuedHere]) => {
        if (cancelled) return;
        fromNetwork = true;
        networkPageFor.current = activeId;
        // Shown from the device, then a jump (a link to one message) loaded the
        // window around its target: this newest page must not replace it.
        if (jumps.current !== jumpsAtStart) return;
        // What is still waiting in the outbox shows as pending after a reload
        // (CHAT-M12), instead of seeming lost until it is flushed.
        const known = new Set(page.messages.map((m) => m.nonce).filter(Boolean));
        const waiting = queuedHere
          .filter((e) => e.conversationId === activeId && !e.threadRootId && !known.has(e.nonce))
          .map((e) => queuedAsMessage(e));
        setMessages([...page.messages, ...waiting]);
        setHasMore(page.hasMore);
        setMessagesConversationId(activeId);
      })
      // Offline with a copy on the device: keep showing it rather than an empty
      // conversation. The reconnect catch-up fills in what is missing.
      .catch(() => { if (!cancelled && !fromCache) { setMessages([]); setHasMore(false); } })
      .finally(() => { if (!cancelled) setMessagesLoading(false); });
    return () => { cancelled = true; };
  }, [activeId]);

  /* The open conversation's newest confirmed messages go back to the device,
   * for the next instant open (P-02). Pending and failed sends stay in the
   * outbox, which is their real home. */
  const saveMessages = useMemo(() => debouncedWriter<WireMessage[]>(
    () => (activeIdRef.current ? `chat:msgs:${activeIdRef.current}` : null),
  ), []);
  useEffect(() => {
    if (!messagesConversationId || messagesConversationId !== activeIdRef.current) return;
    const confirmed = messages.filter((m) => m.seq > 0 && m.delivery !== 'pending' && m.delivery !== 'failed');
    if (confirmed.length) saveMessages(confirmed.slice(-CACHED_MESSAGES));
  }, [messages, messagesConversationId, saveMessages]);

  const loadOlder = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id || loadingMore || !hasMore) return;
    // The list as it is now, not as this callback last saw it: the device
    // copy (P-03) can be replaced by the network's page between the two, and
    // asking for "before" the copy's oldest message read as the end of history.
    const oldest = messagesRef.current.find((m) => m.seq > 0);
    if (!oldest) return;

    setLoadingMore(true);
    try {
      const page = await chatApi.listMessages(id, { before: oldest.seq, limit: 40 });
      // Replaced while this page was on its way (another conversation, the
      // network page, a jump): its answer is about a list that is gone.
      if (activeIdRef.current !== id || messagesRef.current.find((m) => m.seq > 0)?.id !== oldest.id) return;
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
  }, [hasMore, loadingMore]);

  /** The next page after the window a jump left the log in (U-04). */
  const loadingNewer = useRef(false);
  const loadNewer = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id || !hasNewerRef.current || loadingNewer.current) return;
    const newest = messagesRef.current.reduce(
      (max, m) => (m.seq !== Number.MAX_SAFE_INTEGER && m.seq > max ? m.seq : max), 0);
    loadingNewer.current = true;
    try {
      const page = await chatApi.listMessages(id, { after: newest, limit: 40 });
      if (activeIdRef.current !== id) return;
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...page.messages.filter((m) => !seen.has(m.id))];
      });
      setHasNewer(page.hasMore);
    } catch { /* the next scroll tries again */ }
    finally { loadingNewer.current = false; }
  }, []);

  const showLatest = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;
    if (!hasNewerRef.current) return;
    try {
      const page = await chatApi.listMessages(id, { limit: 40 });
      if (activeIdRef.current !== id) return;
      jumps.current += 1;
      setMessages(page.messages);
      setHasMore(page.hasMore);
      setHasNewer(false);
    } catch { /* stay where we are */ }
  }, []);

  /* ────────────────────────────────────────────────────────────────────── *
   * Socket
   * ────────────────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!user) return;
    const meId = user.id;
    const socket = getSocket();
    if (!socket) return;

    const onConnect = () => {
      setConnected(true);
      // Re-subscribe on every connect, not just the first. After a reconnect
      // the server has no memory of this socket's rooms.
      const id = activeIdRef.current;
      if (id) {
        socket.emit('conversation:subscribe', { conversationIds: [id] });
        void catchUp(id);
      }
      // Counters may have moved while we were away.
      void refresh();
      void refreshThreadUnread();
      // And anything typed while offline goes now, in the order it was typed.
      void flushOutbox();
    };
    const onDisconnect = () => setConnected(false);

    /*
     * Whatever arrived while this socket was down (B-04). Re-subscribing only
     * delivers what is sent from now on; the messages in between come from the
     * log, newest seq onwards, and merge in place — a dropped connection no
     * longer means a gap in the open conversation until you switch away.
     */
    const catchingUp = new Set<string>();
    const catchUp = async (conversationId: string) => {
      // One at a time per conversation: a reconnect, a gap and a returning tab
      // can all ask within the same second.
      if (catchingUp.has(conversationId)) return;
      catchingUp.add(conversationId);
      try {
        // Page forward until nothing is missing (S-11) — it used to stop after
        // 100, leaving a hole after a long absence. Past 1,000 messages the
        // newest page replaces the log instead: older ones load on scroll.
        for (let pageNo = 0; pageNo < 10; pageNo++) {
          const newest = messagesRef.current.reduce(
            (max, m) => (m.seq !== Number.MAX_SAFE_INTEGER && m.seq > max ? m.seq : max), 0);
          if (!newest) return;
          const page = await chatApi.listMessages(conversationId, { after: newest, limit: 100 });
          if (activeIdRef.current !== conversationId || !page.messages.length) return;
          setMessages((prev) => page.messages.reduce(
            (list, m) => reconcile(list, m.senderId === meId ? m : personalise(m, meId)), prev));
          messagesRef.current = page.messages.reduce(
            (list, m) => reconcile(list, m.senderId === meId ? m : personalise(m, meId)), messagesRef.current);
          if (page.messages.length < 100) return;
        }
        const fresh = await chatApi.listMessages(conversationId, { limit: 40 });
        if (activeIdRef.current !== conversationId) return;
        setMessages(fresh.messages);
        setHasMore(fresh.hasMore);
      } catch { /* the next message, reconnect or switch will fill it */ }
      finally { catchingUp.delete(conversationId); }
    };

    /*
     * Resync (S-11, S-13). A phone that slept, a tab that sat in the
     * background, a network that came back: the socket may never have noticed
     * it missed anything. Counters, the open conversation and threads are
     * brought up to date then too, not only on a socket reconnect. And when the
     * socket cannot connect at all (some school networks block it), the same
     * resync runs every 15 s so the app still moves, only less instantly.
     */
    let hiddenAt = 0;
    const resync = () => {
      const id = activeIdRef.current;
      if (id) void catchUp(id);
      void refresh();
      void refreshThreadUnread();
    };
    const onVisibility = () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 30_000) resync();
      hiddenAt = 0;
    };
    const onOnline = () => resync();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    const pollTimer = window.setInterval(() => {
      if (!socket.connected && navigator.onLine && !document.hidden) resync();
    }, 15_000);

    /*
     * "Delivered" (B-11): this device has the message. Batched per second and
     * per conversation, so a busy channel is one packet, not one per line.
     */
    const deliveredQueue = new Map<string, Set<string>>();
    let deliveredTimer: ReturnType<typeof setTimeout> | null = null;
    const reportDelivered = (conversationId: string, messageId: string) => {
      const set = deliveredQueue.get(conversationId) ?? new Set<string>();
      set.add(messageId);
      deliveredQueue.set(conversationId, set);
      if (deliveredTimer) return;
      deliveredTimer = setTimeout(() => {
        deliveredTimer = null;
        for (const [cid, ids] of deliveredQueue) socket.emit('receipt:delivered', { conversationId: cid, messageIds: [...ids] });
        deliveredQueue.clear();
      }, 1000);
    };

    const onNew = ({ conversationId, message }: { conversationId: string; message: WireMessage }) => {
      if (message.senderId !== user.id) reportDelivered(conversationId, message.id);
      // Thread replies arrive as `thread:reply`; one reaching here (an older
      // gateway) still belongs in the thread pane, not the main flow.
      if (message.threadRootId) { onThreadReply({ conversationId, rootId: message.threadRootId, message }); return; }
      if (conversationId === activeIdRef.current) {
        // A jump in sequence means something did not arrive (a dropped event
        // during a blip): fetch what is missing (S-11). Thread replies share
        // the sequence, so a jump is sometimes only that — the fetch then
        // finds nothing and costs one small request.
        const newest = messagesRef.current.reduce(
          (max, m) => (m.seq !== Number.MAX_SAFE_INTEGER && m.seq > max ? m.seq : max), 0);
        // Reading an old window after a jump (U-04): the live message is not
        // appended — that would leave a hole — it arrives with "load newer".
        if (hasNewerRef.current) { /* nothing on screen to change */ }
        else {
          if (newest && message.seq > newest + 1) void catchUp(conversationId);
          setMessages((prev) => reconcile(prev, message.senderId === user.id
            ? message : personalise(message, user.id)));
        }
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

    function onThreadReply(
      { conversationId, rootId, message }: { conversationId: string; rootId: string; message: WireMessage },
    ) {
      if (conversationId === activeIdRef.current && rootId === threadRootRef.current) {
        setThreadMessages((prev) => reconcile(prev, message.senderId === meId
          ? message : personalise(message, meId)));
      }
    }

    const onThreadUnread = (
      { rootId, unread }: { conversationId: string; rootId: string; unread: number },
    ) => {
      setThreadUnread((prev) => {
        // Reading it right now: the panel will mark it read; don't flash a marker.
        const value = rootId === threadRootRef.current && !document.hidden ? 0 : unread;
        if ((prev[rootId] ?? 0) === value) return prev;
        const next = { ...prev };
        if (value > 0) next[rootId] = value; else delete next[rootId];
        return next;
      });
    };

    // Edits, deletions and reactions apply to the open thread too — a reply
    // edited or removed must not stay stale in the thread pane.
    const inBoth = (fn: (list: WireMessage[]) => WireMessage[]) => {
      setMessages(fn);
      setThreadMessages(fn);
    };

    const onUpdated = ({ conversationId, message }: { conversationId: string; message: WireMessage }) => {
      if (conversationId !== activeIdRef.current) return;
      inBoth((prev) => prev.map((m) => (m.id === message.id ? personalise(message, user.id, m) : m)));
    };

    const onDeleted = ({ conversationId, messageId }: { conversationId: string; messageId: string }) => {
      if (conversationId !== activeIdRef.current) return;
      // Tombstoned in place rather than removed: the message keeps its slot in
      // the log, which is what "This message was deleted" is for.
      inBoth((prev) => prev.map((m) => (m.id === messageId
        ? { ...m, deletedAt: new Date().toISOString(), body: null, attachments: [], reactions: [] }
        : m)));
    };

    // The sender's ticks, live (B-11): sent → delivered → read.
    const onReceipt = (
      { conversationId, messageId, delivery, readCount }:
      { conversationId: string; messageId: string; delivery: WireMessage['delivery']; readCount: number },
    ) => {
      if (conversationId !== activeIdRef.current) return;
      inBoth((prev) => prev.map((m) => (m.id === messageId ? { ...m, delivery, readCount } : m)));
    };

    // Disappearing messages whose time ran out (B-11): gone, not tombstoned.
    const onExpired = ({ conversationId, messageIds }: { conversationId: string; messageIds: string[] }) => {
      if (conversationId !== activeIdRef.current) return;
      const gone = new Set(messageIds);
      inBoth((prev) => prev.filter((m) => !gone.has(m.id)));
    };

    const onReaction = (
      { conversationId, messageId, reactions }:
      { conversationId: string; messageId: string; reactions: WireMessage['reactions'] },
    ) => {
      if (conversationId !== activeIdRef.current) return;
      inBoth((prev) => prev.map((m) => (m.id === messageId
        ? { ...m, reactions: personaliseReactions(reactions, user.id, m.reactions) } : m)));
    };

    const onTyping = ({ conversationId, users }: { conversationId: string; users: TypingUser[] }) => {
      typingSeenAt.current[conversationId] = Date.now();
      // The server broadcasts the whole set including us; only this client
      // knows which entry is its own, so it drops it here.
      setTypingByConv((prev) => ({
        ...prev, [conversationId]: users.filter((u) => u.userId !== user.id),
      }));
    };

    const onUnread = (
      p: { conversationId: string; unread: number; unreadMentions: number; lastReadSeq: number; lastSeq?: number },
    ) => {
      // Read on another device: this device's notifications for it go too (N-03).
      if (p.unread === 0) void closeConversationNotifications(p.conversationId);
      setConversations((prev) => {
        // Told about a conversation we have never seen — added to a channel, or
        // someone opened a DM with us. Refetch rather than drop it on the
        // floor: a badge for a row that does not exist is a message the person
        // has no way to reach.
        if (!prev.some((c) => c.id === p.conversationId)) {
          void refresh();
          return prev;
        }
        const before = prev.find((c) => c.id === p.conversationId);
        // Something new in a conversation this client is not subscribed to:
        // its preview and time are stale, so fetch its row (debounced).
        if (before && (p.lastSeq ?? 0) > before.lastSeq && p.conversationId !== activeIdRef.current) {
          refreshRowSoon(p.conversationId);
        }
        return prev.map((c) => (c.id === p.conversationId
          ? {
              ...c, unread: p.unread, unreadMentions: p.unreadMentions, lastReadSeq: p.lastReadSeq,
              lastSeq: Math.max(c.lastSeq, p.lastSeq ?? 0),
            }
          : c));
      });
    };

    const rowTimers: Record<string, ReturnType<typeof setTimeout>> = {};
    const refreshRowSoon = (conversationId: string) => {
      clearTimeout(rowTimers[conversationId]);
      rowTimers[conversationId] = setTimeout(() => {
        void chatApi.getConversation(conversationId).then((row) => {
          setConversations((prev) => prev.map((c) => (c.id === conversationId
            ? { ...row, unread: c.unread, unreadMentions: c.unreadMentions, lastReadSeq: c.lastReadSeq } : c)));
        }).catch(() => {});
      }, 400);
    };

    // Removed from (or left) a conversation on any device: it goes from the
    // list everywhere, and closes if it is the one open.
    const onRemoved = ({ conversationId }: { conversationId: string; reason: 'removed' | 'left' }) => {
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      if (activeIdRef.current === conversationId) {
        activeIdRef.current = null;
        setActiveIdRaw(null);
        setMessages([]);
        setThreadRootId(null);
        setThreadMessages([]);
      }
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
      p: { conversationId: string; isStarred?: boolean; notification?: NotificationLevel; mutedUntil?: string | null; hidden?: boolean },
    ) => {
      // Hidden on another device: gone from this list too.
      if (p.hidden) { setConversations((prev) => prev.filter((c) => c.id !== p.conversationId)); return; }
      setConversations((prev) => prev.map((c) => (c.id === p.conversationId
        ? {
            ...c,
            isStarred: p.isStarred ?? c.isStarred,
            notification: p.notification ?? c.notification,
            mutedUntil: p.mutedUntil !== undefined ? p.mutedUntil : c.mutedUntil,
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
    socket.on('messages:expired', onExpired);
    socket.on('receipt:update', onReceipt);
    socket.on('message:reaction', onReaction);
    socket.on('typing:update', onTyping);
    socket.on('conversation:unread', onUnread);
    socket.on('thread:reply', onThreadReply);
    socket.on('thread:unread', onThreadUnread);
    socket.on('conversation:updated', onConversationUpdated);
    socket.on('conversation:removed', onRemoved);
    socket.on('conversation:prefs', onPrefs);
    socket.on('conversation:draft', onDraft);
    socket.on('presence:update', onPresence);
    socket.on('conversation:presence', onConvPresence);
    if (socket.connected) onConnect();

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.clearInterval(pollTimer);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('message:new', onNew);
      socket.off('message:updated', onUpdated);
      socket.off('message:deleted', onDeleted);
      socket.off('messages:expired', onExpired);
      socket.off('receipt:update', onReceipt);
      if (deliveredTimer) clearTimeout(deliveredTimer);
      socket.off('message:reaction', onReaction);
      socket.off('typing:update', onTyping);
      socket.off('conversation:unread', onUnread);
      socket.off('thread:reply', onThreadReply);
      socket.off('thread:unread', onThreadUnread);
      socket.off('conversation:updated', onConversationUpdated);
      socket.off('conversation:removed', onRemoved);
      socket.off('conversation:prefs', onPrefs);
      socket.off('conversation:draft', onDraft);
      socket.off('presence:update', onPresence);
      socket.off('conversation:presence', onConvPresence);
    };
  }, [user, refresh, refreshThreadUnread]);

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
            ...(entry.type ? { type: entry.type as MessageType } : {}),
            ...(entry.metadata ? { metadata: entry.metadata } : {}),
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
    // Sending ends typing now, not when the server's TTL runs out.
    getSocket()?.emit('typing:stop', { conversationId });
    lastTypingSentAt.current = 0;

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
      editedAt: null, deletedAt: null, deletedBy: null, nonce,
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
      type: input.type, metadata: input.metadata,
    });
    void outbox.pending().then((q) => setQueued(q.length));

    pendingPayloads.current.set(nonce, payload);
    // Acks can arrive after the person has switched conversation: they belong
    // to the conversation they were sent in, never to whichever one is open.
    const stillHere = () => activeIdRef.current === conversationId;
    const settle = async (message: WireMessage) => {
      await outbox.dequeue(nonce);
      pendingPayloads.current.delete(nonce);
      void outbox.pending().then((q) => setQueued(q.length));
      if (stillHere()) setMessages((prev) => reconcile(prev, message, nonce));
    };
    const failed = () => {
      if (!stillHere()) return;
      setMessages((prev) => prev.map((m) => (m.nonce === nonce
        ? { ...m, delivery: 'failed' as const } : m)));
    };

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

    const conversationId = failedMsg.conversationId;
    // The original payload — attachments, type and metadata included — not a
    // text-only rebuild that would post a voice note as an empty message.
    // After a reload the payload lives only in the outbox: take it from there.
    const queued = pendingPayloads.current.has(nonce)
      ? null : (await outbox.pending().catch(() => [])).find((e) => e.nonce === nonce) ?? null;
    const original = pendingPayloads.current.get(nonce) ?? (queued ? {
      body: queued.body, nonce, threadRootId: queued.threadRootId, replyToId: queued.replyToId,
      attachments: queued.attachments,
      ...(queued.type ? { type: queued.type as MessageType } : {}),
      ...(queued.metadata ? { metadata: queued.metadata } : {}),
    } : undefined);
    try {
      // Same nonce: if the original in fact landed, this resolves to it rather
      // than posting a second copy.
      const r = await chatApi.sendMessage(conversationId, original ?? {
        body: failedMsg.body ?? '', nonce,
        threadRootId: failedMsg.threadRootId, replyToId: failedMsg.replyTo?.id ?? null,
      });
      await outbox.dequeue(nonce);
      pendingPayloads.current.delete(nonce);
      void outbox.pending().then((q) => setQueued(q.length));
      if (activeIdRef.current === conversationId) setMessages((prev) => reconcile(prev, r.message, nonce));
    } catch {
      if (activeIdRef.current === conversationId) {
        setMessages((prev) => prev.map((m) => (m.nonce === nonce
          ? { ...m, delivery: 'failed' as const } : m)));
      }
    }
  }, [messages]);

  /** Give up on a message that did not send: off the screen and out of the queue. */
  const discard = useCallback(async (nonce: string) => {
    setMessages((prev) => prev.filter((m) => m.nonce !== nonce || m.delivery !== 'failed'));
    pendingPayloads.current.delete(nonce);
    await outbox.dequeue(nonce).catch(() => {});
    void outbox.pending().then((q) => setQueued(q.length));
  }, []);

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

    // What to put back if the server says no (P-04).
    let before: WireMessage['reactions'] | null = null;
    const putBack = () => {
      if (!before) return;
      const restore = before;
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions: restore } : m)));
    };
    setMessages((prev) => prev.map((m) => {
      if (m.id !== messageId) return m;
      before = m.reactions;
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
        } else {
          // Refused (rate limit, archived conversation): it bounces back.
          putBack();
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
      putBack();
    }
  }, [user]);

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

  const sendThreadReply = useCallback(async (body: string, alsoSendToChannel: boolean, attachments: string[] = []) => {
    const conversationId = activeIdRef.current;
    const rootId = threadRootId;
    if (!conversationId || !rootId || (!body.trim() && attachments.length === 0)) return;

    const nonce = newNonce();
    const r = await chatApi.replyInThread(conversationId, rootId, {
      body: body.trim(), nonce, alsoSendToChannel, ...(attachments.length ? { attachments } : {}),
    });
    setThreadMessages((prev) => reconcile(prev, r.message, nonce));
    // The parent's reply count moved; the main flow has to show it.
    if (r.root) setMessages((prev) => prev.map((m) => (m.id === r.root!.id ? r.root! : m)));
  }, [threadRootId]);

  const pin = useCallback(async (messageId: string, pinned: boolean) => {
    const conversationId = activeIdRef.current;
    if (!conversationId) return;
    // Optimistic (P-04): the pin shows (or goes) at once; a refusal puts it
    // back and is rethrown for the caller to say so.
    let before: WireMessage | undefined;
    setMessages((prev) => prev.map((m) => {
      if (m.id !== messageId) return m;
      before = m;
      return { ...m, pinnedAt: pinned ? new Date().toISOString() : null, pinnedBy: pinned ? (user?.id ?? null) : null };
    }));
    try {
      const { message } = await chatApi.setPinned(conversationId, messageId, pinned);
      setMessages((prev) => prev.map((m) => (m.id === messageId ? message : m)));
    } catch (err) {
      if (before) { const restore = before; setMessages((prev) => prev.map((m) => (m.id === messageId ? restore : m))); }
      throw err;
    }
  }, [user]);

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
      const centre = (behavior: ScrollBehavior) => document.getElementById(`msg-${messageId}`)
        ?.scrollIntoView({ behavior, block: 'center' });
      // After the new window has painted, and once more after anything that
      // loads on arrival (the older-page sentinel fires at the top of a short
      // window) has settled — otherwise the target ends up half off-screen.
      requestAnimationFrame(() => requestAnimationFrame(() => centre('smooth')));
      setTimeout(() => centre('auto'), 600);
      // Long enough to notice, short enough not to become part of the design.
      setTimeout(() => setHighlightedId((cur) => (cur === messageId ? null : cur)), 2200);
    };

    // Already on screen — unless what is on screen is the device copy, which the
    // network page is about to replace: then load the window from the server.
    if (networkPageFor.current === conversationId && messages.some((m) => m.id === messageId)) { flash(); return; }

    try {
      const context = await chatApi.messageContext(conversationId, messageId);
      jumps.current += 1;
      setMessages(context.messages);
      // Is there anything after this window? (U-04) One message is enough to know.
      const newestHere = context.messages.reduce((max, m) => Math.max(max, m.seq), 0);
      void chatApi.listMessages(conversationId, { after: newestHere, limit: 1 })
        .then((p) => { if (activeIdRef.current === conversationId) setHasNewer(p.messages.length > 0); })
        .catch(() => {});
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
    // Read here: its notifications on this device go (N-03).
    void closeConversationNotifications(id);
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

  const muteUntil = useCallback(async (id: string, until: string | null | 'forever') => {
    const patch = until === 'forever'
      ? { notification: 'none' as NotificationLevel, mutedUntil: null }
      : until === null
        ? { notification: 'all' as NotificationLevel, mutedUntil: null }
        : { mutedUntil: until };
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    try { await chatApi.setPrefs(id, patch); } catch { void refresh(); }
  }, [refresh]);

  const hideConversation = useCallback(async (id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeIdRef.current === id) setActiveId(null);
    try { await chatApi.setPrefs(id, { hidden: true }); } catch { void refresh(); }
  }, [refresh, setActiveId]);

  const markThreadRead = useCallback((rootId: string, seq: number) => {
    const conversationId = activeIdRef.current;
    if (!conversationId || !Number.isFinite(seq) || seq <= 0) return;
    // Optimistic, like the conversation badge: the marker goes the moment the
    // replies are on screen.
    setThreadUnread((prev) => {
      if (!(rootId in prev)) return prev;
      const next = { ...prev }; delete next[rootId]; return next;
    });
    void chatApi.markThreadRead(conversationId, rootId, seq).catch(() => {});
  }, []);

  const markUnread = useCallback(async (conversationId: string, fromSeq?: number) => {
    // Optimistic (P-04): bold and counted at once, exact numbers from the
    // server a moment later; a refusal restores the row and is rethrown.
    let before: ConversationSummary | undefined;
    setConversations((prev) => prev.map((c) => {
      if (c.id !== conversationId) return c;
      before = c;
      const lastReadSeq = Math.max(0, (fromSeq ?? c.lastSeq) - 1);
      return { ...c, lastReadSeq, unread: Math.max(1, c.lastSeq - lastReadSeq) };
    }));
    // Leaving the conversation open would mark it straight back as read.
    if (activeIdRef.current === conversationId) setActiveId(null);
    try {
      const r = await chatApi.markUnread(conversationId, fromSeq);
      setConversations((prev) => prev.map((c) => (c.id === conversationId
        ? { ...c, unread: r.unread, unreadMentions: r.unreadMentions, lastReadSeq: r.lastReadSeq } : c)));
    } catch (err) {
      if (before) { const restore = before; setConversations((prev) => prev.map((c) => (c.id === conversationId ? restore : c))); }
      throw err;
    }
  }, []);

  const markConversationRead = useCallback((conversationId: string) => {
    setConversations((prev) => prev.map((x) => (x.id === conversationId
      ? { ...x, unread: 0, unreadMentions: 0, lastReadSeq: Math.max(x.lastReadSeq, x.lastSeq) } : x)));
    // To the end as the server knows it: this client may never have seen the
    // newest seq of a conversation it is not looking at.
    void closeConversationNotifications(conversationId);
    void chatApi.markReadLatest(conversationId).then((r) => {
      setConversations((prev) => prev.map((x) => (x.id === conversationId
        ? { ...x, unread: r.unread, unreadMentions: r.unreadMentions, lastReadSeq: r.lastReadSeq } : x)));
    }).catch(() => {});
  }, []);

  // Subject channels have their own page (Channels) and are left out of Chat's
  // numbers, as they are left out of its list.
  const totalUnread = useMemo(
    () => conversations.reduce((n, c) => n + (isMuted(c) || c.subjectId ? 0 : c.unread), 0),
    [conversations],
  );
  const totalMentions = useMemo(
    () => conversations.reduce((n, c) => n + (c.subjectId ? 0 : c.unreadMentions), 0),
    [conversations],
  );
  const threadsUnreadTotal = useMemo(
    () => Object.values(threadUnread).reduce((n, v) => n + v, 0),
    [threadUnread],
  );

  /*
   * Blocks (B-05). Loaded once, kept in step across devices by
   * `block:changed`; the server enforces them, this only shapes the UI.
   */
  const [blockedIds, setBlockedIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    chatApi.listBlocks()
      .then((list) => { if (!cancelled) setBlockedIds(new Set(list.map((b) => b.id))); })
      .catch(() => {});
    const off = onSocket('block:changed', ({ userId, blocked }) => {
      setBlockedIds((cur) => {
        const next = new Set(cur);
        if (blocked) next.add(userId); else next.delete(userId);
        return next;
      });
    });
    return () => { cancelled = true; off(); };
  }, [user]);
  const setBlocked = useCallback(async (userId: string, blocked: boolean) => {
    await (blocked ? chatApi.blockUser(userId) : chatApi.unblockUser(userId));
    setBlockedIds((cur) => {
      const next = new Set(cur);
      if (blocked) next.add(userId); else next.delete(userId);
      return next;
    });
  }, []);

  const value: ChatValue = {
    conversations, conversationsLoading, conversationsError, activeId, setActiveId, active,
    messages, messagesLoading, messagesConversationId, hasMore, loadingMore, loadOlder,
    typing: (activeId && typingByConv[activeId]) || [],
    typingByConversation: typingByConv,
    conversationPresence: convPresence,
    connected,
    send, retry, discard, react, edit, remove, notifyTyping, markReadTo, queued,
    markEverythingRead, lastEditableOwnMessage, editingId, setEditingId,
    replyTarget, setReplyTarget,
    threadRootId, threadMessages, threadLoading, openThread, sendThreadReply,
    pin, save, forward, jumpTo, highlightedId, hasNewer, loadNewer, showLatest,
    draftFor, setDraft, toggleStar, setNotificationLevel, muteUntil, hideConversation,
    totalUnread, totalMentions, threadUnread, threadsUnreadTotal,
    markThreadRead, markUnread, markConversationRead,
    refresh, enterToSend, blockedIds, setBlocked,
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
