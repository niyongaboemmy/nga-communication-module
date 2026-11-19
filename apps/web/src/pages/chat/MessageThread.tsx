import { QuotePreview } from './QuotePreview';
import { isComposing, isSubmitEnter } from './composerKeys';
import { noteRowRender } from '../../lib/perf';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStartCall } from './useStartCall';
import {
  Hash, Megaphone, Users, ArrowLeft, Phone, Video, Info, Pin, Search,
  SmilePlus, Reply, MoreHorizontal, Clock, Check, CheckCheck, AlertCircle,
  RotateCcw, ChevronDown, FileText, MessageSquare, Lock, Pencil, Trash2,
  X, Bookmark, Forward, PinOff, Link2, Quote, Settings, Flag, Timer, Copy, Mail, CornerUpLeft,
} from 'lucide-react';
import { useNotify } from '../../context/NotificationContext';
import { MessageRow } from './MessageRow';
import { jumpHistory, useJumpDepth } from './jumpHistory';
import { useFlag } from '../../lib/flags';
import { Avatar, IconButton, Skeleton, EmptyState, Spinner } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../context/AuthContext';
import {
  dayLabel, startsNewGroup, timeOf, formatBytes, firstUnreadId, typingLabel, emojiOnly,
  lastSeenLabel,
} from './data';
import { useChat, useChatActions } from './ChatProvider';
import * as chatApi from './api';
import { ConversationAvatar } from './ConversationAvatar';
import { toPresence } from './types';
import type { Conversation, Message } from './types';
import { RichText } from './RichText';
import { EmojiPicker } from './EmojiPicker';
import { ForwardDialog } from './ForwardDialog';
import { ReportDialog } from './ReportDialog';
import { ProfileCard } from './ProfileCard';
import { MessageAttachments } from './Attachments';
import { PinnedBar } from './PinnedBar';
import { PollCard } from './PollCard';
import { MeetCard } from './MeetCard';
import { LinkPreviewCard } from './LinkPreviewCard';
import { TranslateControl } from './TranslateButton';
import { useVirtualWindow } from './useVirtualWindow';
import type { MeetMessageMetadata } from './MeetCard';
import { QUICK_REACTIONS, EDIT_WINDOW_MS, PRESENCE_REFRESH_MS } from '@tupo/shared';
import { useTouchGestures } from '../../hooks/useTouchGestures';
import { MessageInfoDialog } from './MessageInfoDialog';

/**
 * The message pane: header, scrollback, composer slot.
 *
 * Three behaviours here are load-bearing rather than decorative:
 *
 *  - UX-2 the list is pinned to the bottom and only auto-scrolls when the user
 *    is already at the bottom. Scrolling up to read is never interrupted by an
 *    arriving message.
 *  - UX-3 once the user has scrolled away, a "jump to latest" pill appears
 *    carrying the unread count, so the escape route is always one tap away.
 *  - FR-MSG-16 scrolling to the top loads the previous page and *holds the
 *    reading position*, which is the difference between infinite scroll and
 *    being thrown back to the top every time.
 *
 * The scroll container is a plain flex column in natural order, not the
 * `flex-col-reverse` trick. Reverse ordering makes reading position stable for
 * free but breaks keyboard tab order, `scrollIntoView`, and every screen reader
 * that walks the DOM — the wrong trade for an app that has to pass an
 * accessibility audit (§16).
 */

const KIND_ICON = { channel: Hash, announcement: Megaphone, group: Users } as const;

/* ------------------------------------------------------------------ *
 * Header
 * ------------------------------------------------------------------ */

const ThreadHeader: React.FC<{
  conversation: Conversation;
  onBack: () => void;
  onToggleContext: () => void;
  contextOpen: boolean;
  onOpenSearch: () => void;
  onOpenChannelSettings: () => void;
  onOpenPinned: () => void;
}> = ({ conversation: c, onBack, onToggleContext, contextOpen, onOpenSearch, onOpenChannelSettings, onOpenPinned }) => {
  const { start: startCall, starting } = useStartCall(c);
  const { can } = usePermissions();
  const { typing, conversationPresence } = useChat();
  const Icon = c.type === 'dm' ? null : KIND_ICON[c.type];

  // The typing line replaces the subtitle rather than pushing it aside: two
  // lines of status in a 56px header is one line too many, and "typing" is
  // always the more urgent of the two.
  const typingText = typingLabel(
    typing.map((t) => t.name.split(' ')[0]!),
    // Whatever the first of them is doing. Mixing verbs across people would
    // need a sentence, and this is a 56px header.
    typing[0]?.kind,
  );

  /*
   * "3 of 12 online" for a group or channel.
   *
   * Pulled, not pushed. Presence is fanned out to DM counterparts only — on
   * purpose, so a 400-member channel does not get a packet every time somebody
   * switches tab — so the count is fetched with the roster and refreshed on a
   * slow timer while this conversation is open. One request a minute for a
   * header line is a fair trade; a broadcast per member per tab switch is not.
   */
  const [polledOnline, setPolledOnline] = useState<number | null>(null);
  useEffect(() => {
    if (c.type === 'dm') { setPolledOnline(null); return; }
    let cancelled = false;
    const load = () => {
      chatApi.listMemberRoster(c.id)
        .then((r) => { if (!cancelled) setPolledOnline(r.onlineCount); })
        .catch(() => { if (!cancelled) setPolledOnline(null); });
    };
    load();
    const t = setInterval(load, PRESENCE_REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [c.id, c.type]);

  /*
   * The pushed figure wins whenever there is one.
   *
   * `conversation:presence` arrives the instant somebody opens or closes this
   * conversation, which is the change people actually notice. It does not fire
   * for a status flick elsewhere, so the poll above stays as the slow backstop
   * — but while both have an answer, the pushed one is the fresher.
   */
  const pushedOnline = conversationPresence[c.id]?.online.length;
  const onlineCount = pushedOnline ?? polledOnline;

  // A grey dot with no explanation is worse than one with a date on it.
  const peerLastSeen = lastSeenLabel(c.peer?.lastSeenAt);

  return (
    <header className="relative z-20 flex h-14 min-w-0 shrink-0 items-center gap-2 border-b border-border-light bg-white/90 px-2 backdrop-blur-md sm:px-4 dark:border-border-dark/30 dark:bg-chrome-dark/80">
      {/* Back is the mobile push-navigation affordance; on md+ both panes are
          visible at once so it would be meaningless. */}
      <IconButton label="Back to conversations" className="md:hidden" onClick={onBack}>
        <ArrowLeft size={18} />
      </IconButton>

      <button
        onClick={onToggleContext}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-1.5 py-1 text-left transition-colors duration-150 hover:bg-surface-light dark:hover:bg-surface-dark"
      >
        <ConversationAvatar
          conversation={c}
          size={34}
          fallback={Icon ? <Icon size={17} /> : null}
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="block truncate text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
              {c.name}
            </span>
            {c.isPrivate && c.type !== 'dm' && <Lock size={12} className="shrink-0 opacity-60" />}
            {/* Disappearing messages are on (B-07): everyone here should know. */}
            {c.retentionDays != null && (
              <span
                title={`Messages disappear after ${c.retentionDays === 1 ? '24 hours' : `${c.retentionDays} days`}`}
                className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-200"
              >
                <Timer size={10} aria-hidden="true" />
                {c.retentionDays === 1 ? '24h' : `${c.retentionDays}d`}
                <span className="sr-only"> — messages disappear after {c.retentionDays === 1 ? '24 hours' : `${c.retentionDays} days`}</span>
              </span>
            )}
          </span>
          <span
            className={`block truncate text-xs ${
              typingText
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-text-secondary-light dark:text-text-secondary-dark'
            }`}
            aria-live="polite"
          >
            {typingText || (c.type === 'dm'
              ? (toPresence(c.peer?.presence) === 'online'
                  ? 'Online'
                  : (peerLastSeen ?? c.peer?.role ?? 'Offline'))
              : `${onlineCount !== null ? `${onlineCount} of ${c.memberCount} online` : `${c.memberCount} members`}${c.topic ? ` · ${c.topic}` : ''}`)}
          </span>
        </span>
      </button>

      <div className="flex items-center gap-0.5">
        {can('MESSAGE_PIN') && (
          <IconButton label="Pinned messages" className="hidden sm:grid" onClick={onOpenPinned}><Pin size={17} /></IconButton>
        )}
        <IconButton label="Search in conversation" className="hidden sm:grid" onClick={onOpenSearch}>
          <Search size={17} />
        </IconButton>
        {can('MEET_START') && (
          <>
            <IconButton label="Start an audio call" disabled={starting} onClick={() => void startCall(true)}><Phone size={17} /></IconButton>
            <IconButton label="Start a video meeting" disabled={starting} onClick={() => void startCall(false)}><Video size={17} /></IconButton>
          </>
        )}
        {c.type !== 'dm' && (c.myRole === 'owner' || c.myRole === 'admin') && (
          <IconButton label={c.type === 'group' ? 'Group settings' : 'Channel settings'} onClick={onOpenChannelSettings}>
            <Settings size={17} />
          </IconButton>
        )}
        <IconButton label="Conversation details" active={contextOpen} onClick={onToggleContext}>
          <Info size={17} />
        </IconButton>
      </div>
    </header>
  );
};

/* ------------------------------------------------------------------ *
 * Message
 * ------------------------------------------------------------------ */

const MessageSkeleton: React.FC<{ mine?: boolean; width: string }> = ({ mine, width }) => (
  <li className={`flex gap-2.5 px-2 sm:px-4 ${mine ? 'flex-row-reverse' : ''}`}>
    <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
    <div className="space-y-1.5">
      <Skeleton className="h-3 w-24" />
      <Skeleton className={`h-10 rounded-2xl ${width}`} />
    </div>
  </li>
);

/* ------------------------------------------------------------------ *
 * Thread
 * ------------------------------------------------------------------ */

export const MessageThread: React.FC<{
  conversation: Conversation;
  onBack: () => void;
  onToggleContext: () => void;
  contextOpen: boolean;
  onOpenSearch: () => void;
  onOpenChannelSettings: () => void;
  onOpenPinned: () => void;
  children: React.ReactNode; // the composer
}> = ({
  conversation, onBack, onToggleContext, contextOpen, onOpenSearch,
  onOpenChannelSettings, onOpenPinned, children,
}) => {
  const { user } = useAuth();
  const {
    messages, messagesLoading: loading, hasMore, loadingMore, loadOlder, messagesConversationId,
    markReadTo, hasNewer, loadNewer, showLatest,
    highlightedId, editingId, threadUnread, blockedIds, typingByConversation, doubleTapLike,
  } = useChat();
  // Who is typing in which thread, as one sentence per root.
  const replyingByRoot = useMemo(() => {
    const byRoot: Record<string, string[]> = {};
    for (const u of typingByConversation[conversation.id] ?? []) {
      if (u.threadRootId && u.userId !== user?.id) (byRoot[u.threadRootId] ??= []).push(u.name.split(' ')[0] ?? u.name);
    }
    const out: Record<string, string> = {};
    for (const [root, names] of Object.entries(byRoot)) {
      out[root] = names.length === 1 ? `${names[0]} is replying…` : `${names.slice(0, 2).join(' and ')} are replying…`;
    }
    return out;
  }, [typingByConversation, conversation.id, user?.id]);
  // A channel's own owner, admins and moderators may remove what is posted
  // there (B-13) — the server always allowed it; the menu never offered it.
  const { can } = usePermissions();
  // Facebook-style replies under each message (R-02/R-03), behind its flag.
  const inlineReplies = useFlag('chat.inlineReplies');
  // The server's assertCanPost: an announcement channel's threads are for announcers too.
  const canReply = can('MESSAGE_SEND') && !conversation.isArchived
    && (conversation.type !== 'announcement' || can('CHANNEL_ANNOUNCE')
        || conversation.myRole === 'owner' || conversation.myRole === 'admin');
  // "Back to reply" after following a quote (R-10); stale once the room changes.
  const jumpDepth = useJumpDepth();
  const { jumpTo } = useChatActions();
  useEffect(() => () => jumpHistory.clear(), [conversation.id]);
  const runsThisRoom = conversation.type !== 'dm'
    && (conversation.myRole === 'owner' || conversation.myRole === 'admin' || conversation.myRole === 'moderator');

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  /** Names for resolving `<@id>` mentions without a lookup per message. */
  // Kept the same object while nobody new has spoken, so a new message does
  // not re-render every memoised row through this prop (G-02).
  const namesRef = useRef<Record<string, string>>({});
  const names = useMemo(() => {
    const out: Record<string, string> = {};
    for (const m of messages) out[m.senderId] = m.senderName;
    if (user) out[user.id] = user.name;
    const prev = namesRef.current;
    const same = Object.keys(out).length === Object.keys(prev).length
      && Object.entries(out).every(([k, v]) => prev[k] === v);
    if (!same) namesRef.current = out;
    return namesRef.current;
  }, [messages, user]);

  /*
   * Windowing (U-6). Inert below 200 messages; above it, only a slice of the
   * log is in the DOM. See useVirtualWindow for why this is not a conventional
   * absolute-positioned virtualiser.
   */
  const window_ = useVirtualWindow(scrollRef, messages.length, conversation.id);
  const visibleMessages = window_.disabled
    ? messages
    : messages.slice(window_.start, window_.end);

  const dividerId = useMemo(
    () => firstUnreadId(messages, conversation.lastReadSeq, user?.id ?? ''),
    [messages, conversation.lastReadSeq, user?.id],
  );

  // UX-2: only follow the tail when the reader is already at it — and it is
  // the real tail. Reading an old window after a jump (U-04), the bottom is
  // just where "load newer" appends; following it would chain every page in
  // and lose the place the jump was for.
  /*
   * C-03: open where the reader left off. Returning to forty unread messages
   * used to land on the last one, with the "New" line somewhere above. The
   * first time this conversation's own messages are on screen, a "New" line
   * more than a screen up is placed a third of the way down the view instead
   * (the jump button carries the count to the end). Decided once per opening.
   */
  const positionedFor = useRef<string | null>(null);
  const olderFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    const ready = !loading && messages.length > 0 && messagesConversationId === conversation.id;
    if (ready && positionedFor.current !== conversation.id) {
      // The first page holds the newest messages. If the first unread is older
      // than that, the "New" line would sit on the oldest *loaded* message and
      // jump once the real one arrives: load back to it first (up to a few
      // pages' worth), then place the view.
      const oldest = messages.find((m) => m.seq > 0 && m.seq !== Number.MAX_SAFE_INTEGER);
      const startLoaded = !hasMore || (oldest !== undefined && oldest.seq <= conversation.lastReadSeq + 1);
      if (!startLoaded && conversation.unread <= 150) {
        if (!loadingMore && olderFor.current !== `${conversation.id}:${messages.length}`) {
          olderFor.current = `${conversation.id}:${messages.length}`;
          void loadOlder();
        }
        return;
      }
      positionedFor.current = conversation.id;
      const el = scrollRef.current;
      const line = dividerId ? el?.querySelector<HTMLElement>('[aria-label="New messages"]') : null;
      if (el && line) {
        const top = line.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        if (el.scrollHeight - top > el.clientHeight) {
          el.scrollTop = Math.max(0, top - el.clientHeight * 0.3);
          setAtBottom(false);
          return;
        }
      }
    }
    if (atBottom && !hasNewer) bottomRef.current?.scrollIntoView({ block: 'end' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, conversation.id, loading, messagesConversationId, loadingMore]);

  /*
   * C-07: opening a side panel narrows the log, rows re-wrap, and the reader's
   * place used to slide away under them. The message at the top of the view
   * is tracked as they scroll (once a frame), and after a width change it is
   * put back at the same offset — unless they are following the newest
   * message, which the tail rule already keeps in view.
   */
  const atBottomRef = useRef(true);
  atBottomRef.current = atBottom;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let anchor: { id: string; offset: number } | null = null;
    let width = el.clientWidth;
    let frame = 0;
    const record = () => {
      frame = 0;
      const top = el.getBoundingClientRect().top;
      for (const row of el.querySelectorAll<HTMLElement>('li[data-message-row]')) {
        const box = row.getBoundingClientRect();
        if (box.bottom > top + 4) { anchor = { id: row.id, offset: box.top - top }; return; }
      }
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(record); };
    record();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      if (atBottomRef.current || !anchor) return;
      const target = anchor.id ? document.getElementById(anchor.id) : null;
      if (!target) return;
      el.scrollTop += (target.getBoundingClientRect().top - el.getBoundingClientRect().top) - anchor.offset;
    });
    ro.observe(el);
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [conversation.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      // 80px of slack: "near the bottom" should count as being at it, or the
      // pill flickers every time a bubble grows by a line.
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  /*
   * Infinite scroll upward, holding the reading position.
   *
   * Prepending rows moves everything below them down by exactly the height of
   * what was added, so the scroll offset is corrected by the change in
   * scrollHeight. Without this the reader is thrown to the top on every page —
   * the single most common way infinite scroll is got wrong.
   */
  const loadOlderHoldingPosition = useCallback(async () => {
    const el = scrollRef.current;
    if (!el) return;
    const before = el.scrollHeight;
    await loadOlder();
    requestAnimationFrame(() => {
      const after = el.scrollHeight;
      el.scrollTop += after - before;
    });
  }, [loadOlder]);

  const oldestId = messages[0]?.id;
  useEffect(() => {
    const sentinel = topSentinel.current;
    const root = scrollRef.current;
    if (!sentinel || !root || !hasMore || loading) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting && !loadingMore) void loadOlderHoldingPosition(); },
      { root, rootMargin: '200px 0px 0px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // `oldestId`: an observer only reports changes, so when the list under it
    // is replaced (the device copy giving way to the network's page, P-03)
    // while the top is already in view, it would never fire again and older
    // messages would never load. Observing afresh asks the question again.
  }, [hasMore, loading, loadingMore, loadOlderHoldingPosition, oldestId]);

  /*
   * Mark read when the newest message is actually on screen.
   *
   * Not on open: a conversation opened on a phone and immediately backed out of
   * has not been read, and clearing the badge for it is how people lose
   * messages. Being scrolled to the bottom with the tab visible is the closest
   * honest proxy for "these were seen".
   */
  useEffect(() => {
    if (!atBottom || loading || messages.length === 0) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    // Measured, not remembered: the first render after opening still holds the
    // initial "at bottom" while the log is being placed at the first unread (C-03).
    const sc = scrollRef.current;
    if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight >= 80) return;
    const newest = messages.reduce(
      (max, m) => (m.seq !== Number.MAX_SAFE_INTEGER && m.seq > max ? m.seq : max), 0);
    if (newest > 0) markReadTo(newest);
  }, [atBottom, loading, messages, markReadTo]);

  // After a jump into the past (U-04) "latest" is not on the page yet: fetch
  // the newest page first, then go to the end.
  const jumpToLatest = async () => {
    if (hasNewer) await showLatest();
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }));
  };

  // Reaching the bottom of an old window loads what came after it (U-04).
  useEffect(() => {
    const el = bottomRef.current;
    const root = scrollRef.current;
    if (!el || !root || !hasNewer || loading) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) void loadNewer(); },
      { root, rootMargin: '0px 0px 200px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNewer, loading, loadNewer, messages.length]);

  let lastDay = '';

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-surface-light dark:bg-background-dark"
      aria-label={conversation.name}
    >
      <ThreadHeader
        conversation={conversation}
        onBack={onBack}
        onToggleContext={onToggleContext}
        contextOpen={contextOpen}
        onOpenSearch={onOpenSearch}
        onOpenChannelSettings={onOpenChannelSettings}
        onOpenPinned={onOpenPinned}
      />

      <PinnedBar conversation={conversation} />

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain pb-16 pt-4 [scroll-padding-bottom:4rem]">
          <div ref={topSentinel} />

          {loadingMore && (
            <div className="flex justify-center py-2"><Spinner className="h-4 w-4" /></div>
          )}
          {!hasMore && !loading && messages.length > 0 && (
            <p className="px-4 py-3 text-center text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
              This is the beginning of {conversation.type === 'dm' ? 'your conversation' : `#${conversation.name}`}.
            </p>
          )}

          {loading ? (
            <ul aria-busy="true" aria-label="Loading messages" className="space-y-4">
              <MessageSkeleton width="w-52" />
              <MessageSkeleton width="w-72" />
              <MessageSkeleton mine width="w-40" />
              <MessageSkeleton width="w-64" />
            </ul>
          ) : messages.length === 0 ? (
            <EmptyState
              icon={<MessageSquare size={22} />}
              title="No messages yet"
              /* UX-11: an empty state names the next action, with the actual
                 conversation in it, rather than stating the obvious. */
              hint={
                conversation.type === 'dm'
                  ? `Say hello to ${conversation.name.split(' ')[0]}.`
                  : `Be the first to post in #${conversation.name}.`
              }
            />
          ) : (
            /* `role="log"` is the correct role for a chat transcript: it carries
               an implicit polite live region, so a screen reader announces
               arriving messages without the whole list being re-read, and it
               gives the transcript a name of its own separate from the pane. */
            <ul role="log" aria-label="Messages" aria-relevant="additions">
              {/* Spacers hold the scrollbar the right length while the rows
                  above the window are not rendered. Plain height, no absolute
                  positioning, so every row keeps its natural size. */}
              {window_.padTop > 0 && (
                <li style={{ height: window_.padTop }} aria-hidden="true" />
              )}
              {visibleMessages.map((m, vi) => {
                const i = window_.start + vi;
                const day = dayLabel(m.createdAt);
                const showDay = day !== lastDay;
                lastDay = day;
                return (
                  <React.Fragment key={m.id}>
                    {showDay && (
                      /* A full-width strip in the list's own colour (C-01): text
                         scrolls under the date instead of through it. */
                      <li className="sticky top-0 z-10 flex justify-center bg-surface-light/95 py-1.5 backdrop-blur-sm dark:bg-background-dark/95">
                        <span className="rounded-full border border-border-light bg-white px-3 py-0.5 text-[11px] font-semibold text-text-secondary-light dark:border-border-dark/50 dark:bg-elevated-dark dark:text-text-secondary-dark">
                          {day}
                        </span>
                      </li>
                    )}
                    {/* FR-MSG-15: where you left off, so returning to a busy
                        channel does not mean guessing. */}
                    {m.id === dividerId && (
                      <li className="flex items-center gap-2 px-4 py-2" aria-label="New messages">
                        <span className="h-px flex-1 bg-red-400/60" />
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-red-500">New</span>
                        <span className="h-px flex-1 bg-red-400/60" />
                      </li>
                    )}
                    <MessageRow
                      message={m}
                      newGroup={startsNewGroup(m, messages[i - 1])}
                      names={names}
                      isHighlighted={highlightedId === m.id}
                      editRequested={editingId === m.id}
                      newReplies={threadUnread[m.id] ?? 0}
                      senderBlocked={blockedIds.has(m.senderId)}
                      runsThisRoom={runsThisRoom}
                      isDm={conversation.type === 'dm'}
                      canReply={canReply}
                      inlineReplies={inlineReplies}
                      replying={replyingByRoot[m.id]}
                      doubleTapLike={doubleTapLike}
                    />
                  </React.Fragment>
                );
              })}
              {window_.padBottom > 0 && (
                <li style={{ height: window_.padBottom }} aria-hidden="true" />
              )}
            </ul>
          )}
          <div ref={bottomRef} />
        </div>

        {/* UX-3 */}
        {/* R-10: back to the reply a quote was followed from. */}
        {jumpDepth > 0 && (
          <button
            onClick={() => { const id = jumpHistory.pop(); if (id) void jumpTo(id); }}
            className="animate-fade-in absolute bottom-3 left-1/2 z-20 flex min-h-10 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-light bg-white px-4 text-xs font-semibold text-blue-700 hover:bg-blue-50 dark:border-border-dark/60 dark:bg-elevated-dark dark:text-blue-300 dark:hover:bg-blue-900/30"
          >
            <CornerUpLeft size={14} aria-hidden="true" /> Back to reply
          </button>
        )}

        {/* C-04: a round button in the corner rather than a pill across the
            middle of the text it was covering; the unread count rides on it. */}
        {(!atBottom || hasNewer) && !loading && messages.length > 0 && (
          <button
            onClick={() => void jumpToLatest()}
            aria-label={conversation.unread > 0 ? `Jump to latest, ${conversation.unread} new` : 'Jump to latest'}
            title="Jump to latest"
            className="animate-fade-in absolute bottom-3 right-3 z-20 grid h-11 w-11 place-items-center rounded-full border border-border-light bg-white text-blue-600 transition-colors duration-150 hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:right-5 dark:border-border-dark/60 dark:bg-elevated-dark dark:text-blue-400 dark:hover:bg-blue-900/30"
          >
            <ChevronDown size={20} />
            {conversation.unread > 0 && (
              <span className="absolute -top-1.5 left-1/2 min-w-5 -translate-x-1/2 rounded-full bg-blue-600 px-1.5 text-center text-[10px] font-semibold leading-5 tabular-nums text-white">
                {conversation.unread > 99 ? '99+' : conversation.unread}
              </span>
            )}
          </button>
        )}
      </div>

      {children}
    </section>
  );
};
