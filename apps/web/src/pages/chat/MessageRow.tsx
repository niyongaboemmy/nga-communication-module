import { useFlag } from '../../lib/flags';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { jumpHistory } from './jumpHistory';
import { ThreadSummary } from './ThreadSummary';
import { isInlineOpen, setInlineOpen } from './inlineThreadState';
import { QuotePreview } from './QuotePreview';
import { isComposing, isSubmitEnter } from './composerKeys';
import { noteRowRender } from '../../lib/perf';
import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';

/*
 * Loaded on first use, not with the chat (bundle budget, P-01): the replies
 * under a message and the phone sheet appear only when asked for, and every
 * row in the log would otherwise carry them in the first download.
 */
const InlineThread = lazy(() => import('./InlineThread').then((m) => ({ default: m.InlineThread })));
const MessageActionSheet = lazy(() => import('./MessageActionSheet').then((m) => ({ default: m.MessageActionSheet })));
import {
  Info, Pin, SmilePlus, Reply, MoreHorizontal, Clock, Check, CheckCheck, AlertCircle,
  RotateCcw, MessageSquare, Pencil, Trash2, Bookmark, Forward, PinOff, Link2, Quote,
  Flag, Copy, Mail, CornerDownRight, CornerUpLeft,
} from 'lucide-react';
import { useNotify } from '../../context/NotificationContext';
import { Avatar, IconButton } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../context/AuthContext';
import { timeOf, emojiOnly } from './data';
import { useChatActions } from './ChatProvider';
import type { Message } from './types';
import { RichText } from './RichText';
import { EmojiPicker } from './EmojiPicker';
import { ForwardDialog } from './ForwardDialog';
import { ReportDialog } from './ReportDialog';
import { ProfileCard } from './ProfileCard';
import { MessageAttachments } from './Attachments';
import { PollCard } from './PollCard';
import { MeetCard } from './MeetCard';
import { LinkPreviewCard } from './LinkPreviewCard';
import { TranslateControl } from './TranslateButton';
import type { MeetMessageMetadata } from './MeetCard';
import { QUICK_REACTIONS, EDIT_WINDOW_MS } from '@tupo/shared';
import { useTouchGestures } from '../../hooks/useTouchGestures';
import { MessageInfoDialog } from './MessageInfoDialog';


const StatusIcon: React.FC<{ status: Message['delivery'] }> = ({ status }) => {
  switch (status) {
    case 'pending': return <Clock size={12} aria-label="Sending" className="opacity-70" />;
    case 'sent': return <Check size={13} aria-label="Sent" className="opacity-70" />;
    case 'delivered': return <CheckCheck size={13} aria-label="Delivered" className="opacity-70" />;
    case 'read': return <CheckCheck size={13} aria-label="Read" className="text-blue-200" />;
    case 'failed': return <AlertCircle size={13} aria-label="Failed to send" className="text-red-300" />;
    default: return null;
  }
};

/**
 * What a message still waiting to send says about itself (G-13). Nothing for
 * the first 3 s (most sends land well inside that); then "Sending…"; after
 * 15 s, that the line is slow and it is still trying; offline, that it will
 * go when the connection is back. A 1 s ticker runs only while it is pending.
 */
const PendingNote: React.FC<{ createdAt: string; mine: boolean }> = ({ createdAt, mine }) => {
  const [now, setNow] = useState(() => Date.now());
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { clearInterval(t); window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  const age = now - new Date(createdAt).getTime();
  const text = !online ? 'Waiting for a connection — it will send by itself'
    : age > 15_000 ? 'Slow connection — still trying'
      : age > 3_000 ? 'Sending…' : null;
  if (!text) return null;
  return (
    <p role="status" className={`mt-1 text-[11px] text-text-secondary-light dark:text-text-secondary-dark ${mine ? 'text-right' : ''}`}>
      {text}
    </p>
  );
};

export interface MessageRowProps {
  message: Message;
  newGroup: boolean;
  names: Record<string, string>;
  /** The log is flashing this row after a jump. */
  isHighlighted?: boolean;
  /** ↑ in the composer asked this row to open its editor. */
  editRequested?: boolean;
  /** Unread replies in this message's thread. */
  newReplies?: number;
  /** The sender is someone the reader blocked. */
  senderBlocked?: boolean;
  /** The reader owns, admins or moderates this room (B-13). */
  runsThisRoom?: boolean;
  /** A direct message: Reply quotes, there is no thread line (R-06). */
  isDm?: boolean;
  /** The reader may post here; gates the inline reply box. */
  canReply?: boolean;
  /** Facebook-style replies are on (flag chat.inlineReplies). */
  inlineReplies?: boolean;
  /**
   * `compact`: a reply inside a thread (panel or inline) — left-aligned for
   * everyone, a lighter bubble, a smaller face (R-04).
   */
  variant?: 'default' | 'compact';
  /** Overrides Reply (a reply inside a thread answers with "@Name"). */
  onReply?: (m: Message) => void;
  /** "Didier is replying…" for this message's thread. */
  replying?: string;
  /** Double-tap adds 👍 on a phone (a chat preference). */
  doubleTapLike?: boolean;
}

/**
 * One message. Memoised, and fed by props plus the stable actions context —
 * never by the whole chat context — so it re-renders only when its own
 * message or flags change (G-02). Typing renders none of them.
 */
const MessageRowInner: React.FC<MessageRowProps> = ({
  message: m, newGroup, names, isHighlighted = false, editRequested = false,
  newReplies = 0, senderBlocked = false, runsThisRoom = false,
  isDm = false, canReply = true, inlineReplies = false, variant = 'default', onReply, replying,
  doubleTapLike = false,
}) => {
  noteRowRender();
  const { can } = usePermissions();
  const { user } = useAuth();
  const {
    react, edit, remove, pin, save, openThread, setReplyTarget, jumpTo,
    setEditingId, discard, markUnread, retry: onRetry,
  } = useChatActions();
  const compact = variant === 'compact';
  const sheetOn = useFlag('chat.actionSheet');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmOther, confirmDialog] = useConfirmDialog();
  // The thread line and inline replies belong to a top-level message in a room.
  const threadable = !compact && !isDm && inlineReplies && !m.threadRootId;
  const [threadOpen, setThreadOpenState] = useState(() => threadable && isInlineOpen(m.id));
  const [focusReply, setFocusReply] = useState(0);
  const setThreadOpen = (open: boolean) => { setThreadOpenState(open); setInlineOpen(m.id, open); };
  // Unread replies open the thread in place (R-03): what is new is shown, not hinted at.
  useEffect(() => { if (threadable && newReplies > 0) setThreadOpenState(true); }, [threadable, newReplies]);
  /*
   * One Reply (R-06). Inside a thread: "@Name" in the same thread. In a direct
   * message: a quote. In a room: the replies open under the message, caret
   * in the box. With the flag off, the old thread pane.
   */
  const reply = () => {
    if (onReply) { onReply(m); return; }
    if (isDm || m.threadRootId) { setReplyTarget(m); return; }
    if (!inlineReplies) { openThread(m.id); return; }
    setThreadOpen(true);
    setFocusReply((n) => n + 1);
  };
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const { notify, confirm: confirmed } = useNotify();
  /** Every action says so when it fails (B-10) — they used to fail silently. */
  const attempt = (what: () => Promise<unknown>, failed: string, done?: string) => {
    void what().then(() => { if (done) confirmed(done); })
      .catch((err) => notify({ title: failed, body: err instanceof Error ? err.message : undefined, tone: 'error' }));
  };
  const copy = (text: string, done: string) => attempt(async () => {
    if (!navigator.clipboard) throw new Error('This browser does not allow copying here.');
    await navigator.clipboard.writeText(text);
  }, 'Could not copy', done);
  const [reporting, setReporting] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  // The card behind every avatar: who this is, message them, block, report.
  const [profileOpen, setProfileOpen] = useState(false);
  // A message from someone you blocked is folded away until you ask (B-05).
  const [revealBlocked, setRevealBlocked] = useState(false);
  const [picking, setPicking] = useState(false);
  const [forwarding, setForwarding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Phones (U-01): swipe right to reply, long-press for the actions menu.
  const gestures = useTouchGestures({
    onSwipe: () => reply(),
    // C-02: on a phone, a labelled bottom sheet rather than the desktop menu.
    onLongPress: () => (sheetOn ? setSheetOpen(true) : setMenuOpen(true)),
    disabled: m.type === 'system' || Boolean(m.deletedAt),
  });
  const editRef = useRef<HTMLTextAreaElement>(null);

  const mine = m.senderId === user?.id;
  // Own messages sit on the right in a bubble of their own colour — except
  // inside a thread, where every reply reads left to right like a comment.
  const right = mine && !compact;
  const onDark = mine && !compact;
  const fromThread = typeof m.metadata?.fromThread === 'string' ? m.metadata.fromThread as string : null;

  // ↑ in the composer names a message; this is the row that answers.
  useEffect(() => {
    if (!editRequested) return;
    setDraft(m.body ?? '');
    setEditing(true);
    setEditingId(null);
  }, [editRequested, m.body, setEditingId]);

  useEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.focus();
    // Caret at the end, not the start: an edit is nearly always an addition or
    // a correction at the tail, and starting at position 0 means every edit
    // begins with a keypress to get out of the way.
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  if (m.type === 'system') {
    return (
      <li className="flex justify-center px-4 py-2">
        <span className="rounded-full bg-surface-light px-3 py-1 text-xs text-text-secondary-light dark:bg-elevated-dark/70 dark:text-text-secondary-dark">
          {m.body}
        </span>
      </li>
    );
  }

  if (m.deletedAt) {
    return (
      <li className={`flex gap-2.5 px-2 sm:px-4 ${newGroup ? 'mt-3' : 'mt-0.5'} ${mine ? 'flex-row-reverse' : ''}`}>
        <span className="w-9 shrink-0" />
        <span className="rounded-2xl border border-dashed border-border-light px-3 py-1.5 text-xs italic text-text-secondary-light dark:border-border-dark/50 dark:text-text-secondary-dark">
          This message was deleted
        </span>
      </li>
    );
  }

  if (!mine && senderBlocked && !revealBlocked) {
    return (
      <li className={`flex gap-2.5 px-2 sm:px-4 ${newGroup ? 'mt-3' : 'mt-0.5'}`}>
        <span className="w-9 shrink-0" />
        <button
          onClick={() => setRevealBlocked(true)}
          className="rounded-2xl border border-dashed border-border-light px-3 py-1.5 text-xs text-text-secondary-light hover:bg-surface-light dark:border-border-dark/50 dark:text-text-secondary-dark dark:hover:bg-surface-dark"
        >
          Message from someone you blocked · <span className="font-medium text-blue-600 dark:text-blue-400">Show</span>
        </button>
      </li>
    );
  }

  const failed = m.delivery === 'failed';
  const pending = m.delivery === 'pending';
  // A bare 👍 gets no bubble and three times the size.
  const bigEmoji = emojiOnly(m.body) && m.attachments.length === 0 && !m.replyTo;
  const meetMeta = m.type === 'call_event'
    ? (m.metadata as { meet?: MeetMessageMetadata })?.meet ?? null
    : null;
  // Editing is the author's, within the window, and never on a message that has
  // not landed yet — there is nothing on the server to edit.
  const withinEditWindow = Date.now() - new Date(m.createdAt).getTime() < EDIT_WINDOW_MS;
  const canEdit = mine && !pending && !failed && withinEditWindow && can('MESSAGE_EDIT_OWN');
  // A channel's own owner, admins and moderators may remove what is posted
  // there (B-13) — the server always allowed it; the menu never offered it.
  const canDelete = (mine && can('MESSAGE_DELETE_OWN')) || can('MESSAGE_DELETE_ANY') || (!mine && runsThisRoom);

  /*
   * The edit shows at once (the provider applies it optimistically). If the
   * server refuses, the old text comes back and the editor reopens holding
   * what was typed, with a toast that can retry it (G-04).
   */
  const submitEdit = async (text: string = draft) => {
    const next = text.trim();
    setEditing(false);
    if (!next || next === (m.body ?? '')) return;
    try {
      await edit(m.id, next);
    } catch (err) {
      setDraft(next);
      setEditing(true);
      notify({
        title: 'Your edit was not saved',
        body: err instanceof Error ? err.message : undefined,
        tone: 'error',
        action: { label: 'Retry', onClick: () => { void submitEdit(next); } },
      });
    }
  };

  return (
    <>
    <li
      id={`msg-${m.id}`}
      data-message-row=""
      {...gestures.handlers}
      // C-02: on a phone, a double tap is a 👍 — the commonest reaction, in one gesture.
      onDoubleClick={sheetOn && doubleTapLike && !m.deletedAt && !pending && !failed
        && typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
        ? () => { navigator.vibrate?.(8); void react(m.id, '👍'); }
        : undefined}
      style={gestures.dx ? { transform: `translateX(${gestures.dx}px)`, transition: 'none' } : { transition: 'transform 150ms ease-out' }}
      className={`group relative flex ${compact ? 'gap-2 px-1' : 'gap-2.5 px-2 sm:px-4'} [touch-action:pan-y] ${newGroup ? (compact ? 'mt-1.5' : 'mt-3') : 'mt-0.5'} ${
        right ? 'flex-row-reverse' : ''
      } ${m.mentionsMe ? 'bg-amber-50/60 dark:bg-amber-500/5' : ''} ${
        isHighlighted ? 'animate-fade-in rounded-xl bg-blue-100/70 dark:bg-blue-500/15' : ''
      }`}
    >
      {/* The gutter keeps its width when the avatar is hidden, so a grouped run
          stays aligned instead of stepping left. */}
      <span className={`relative shrink-0 ${compact ? 'w-6' : 'w-9'}`}>
        {newGroup && (
          <button
            onClick={() => setProfileOpen((v) => !v)}
            aria-label={`${m.senderName}, profile`}
            className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <Avatar name={m.senderName} src={m.senderAvatarUrl ?? undefined} size={compact ? 24 : 36} />
          </button>
        )}
        {profileOpen && (
          <ProfileCard userId={m.senderId} anchor={right ? 'right' : 'left'} onClose={() => setProfileOpen(false)} />
        )}
      </span>

      <div className={`min-w-0 ${compact ? 'max-w-full flex-1' : 'max-w-[min(46rem,85%)]'} ${right ? 'items-end' : 'items-start'} flex flex-col`}>
        {newGroup && (
          <div className={`${compact ? 'mb-0.5' : 'mb-1'} flex items-baseline gap-2 ${right ? 'flex-row-reverse' : ''}`}>
            <button
              onClick={() => setProfileOpen((v) => !v)}
              className={`${compact ? 'text-xs' : 'text-sm'} font-semibold text-text-primary-light hover:underline dark:text-text-primary-dark`}
            >
              {mine ? 'You' : m.senderName}
            </button>
            {m.senderRole && !mine && (
              <span className="hidden text-[11px] capitalize text-text-secondary-light sm:inline dark:text-text-secondary-dark">
                {m.senderRole}
              </span>
            )}
            <span className="text-[11px] tabular-nums text-text-secondary-light dark:text-text-secondary-dark">
              {timeOf(m.createdAt)}
            </span>
          </div>
        )}

        {/* Messenger's label (R-08): a reply says whom it answers, so it never
            reads as a forward or a pasted note. */}
        {m.replyTo && !fromThread && !compact && !m.deletedAt && (
          <p className="mb-0.5 flex items-center gap-1 text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
            <CornerUpLeft size={11} aria-hidden="true" />
            {mine ? 'You' : m.senderName.split(' ')[0]} replied to{' '}
            {m.replyTo.senderId === user?.id ? (mine ? 'yourself' : 'you') : m.replyTo.senderName.split(' ')[0]}
          </p>
        )}

        {editing ? (
          /* Edit in place rather than in a modal. The surrounding conversation
             is the context you are editing against, and a dialog hides it. */
          <div className="w-full min-w-[16rem]">
            <textarea
              ref={editRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (isComposing(e)) return;
                if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
                // Same rule as the composer (G-08): on a phone Enter is a new line.
                if (isSubmitEnter(e)) { e.preventDefault(); void submitEdit(); }
              }}
              rows={Math.min((draft.match(/\n/g)?.length ?? 0) + 1, 8)}
              aria-label="Edit message text"
              className="w-full resize-none rounded-xl border border-blue-500 bg-white px-3 py-2 text-sm text-text-primary-light outline-none ring-2 ring-blue-500/20 dark:bg-elevated-dark dark:text-text-primary-dark"
            />
            <div className="mt-1 flex items-center gap-2 text-[11px]">
              <button onClick={() => void submitEdit()} className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                Save
              </button>
              <button onClick={() => setEditing(false)} className="text-text-secondary-light hover:underline dark:text-text-secondary-dark">
                Cancel
              </button>
              <span className="hidden text-text-secondary-light/70 [@media(pointer:fine)]:inline dark:text-text-secondary-dark/60">
                Escape to cancel · Enter to save
              </span>
            </div>
          </div>
        ) : (
          <div
            className={
              bigEmoji
                // No bubble, no padding: the emoji *is* the message.
                ? `text-4xl leading-tight ${pending ? 'opacity-75' : ''}`
                // `min-w-0 max-w-full`: nothing inside may widen the bubble past its column (R-01).
                : `message-body min-w-0 max-w-full ${compact ? 'px-3 py-1.5' : 'px-3.5 py-2'} text-sm [overflow-wrap:anywhere] ${
                    compact
                      ? 'rounded-2xl bg-surface-light text-text-primary-light dark:bg-elevated-dark dark:text-text-primary-dark'
                      : mine
                      ? 'bubble-out bg-blue-600 text-white'
                      : 'bubble-in border border-border-light bg-white text-text-primary-light dark:border-border-dark/40 dark:bg-elevated-dark dark:text-text-primary-dark'
                  } ${failed ? 'ring-1 ring-red-400' : ''} ${pending ? 'opacity-75' : ''}`
            }
          >
            {/* A thread reply also sent to the room says where it came from (R-07). */}
            {fromThread && (
              <button
                type="button"
                onClick={() => openThread(fromThread)}
                className={`mb-1.5 flex items-center gap-1 text-[11px] font-semibold hover:underline ${onDark ? 'text-white/90' : 'text-blue-700 dark:text-blue-300'}`}
              >
                <CornerDownRight size={12} aria-hidden="true" /> Replied in a thread · View thread
              </button>
            )}
            {/* Quote-reply context, rendered above the message it answers. */}
            {m.replyTo && !fromThread && (
              /* Tappable, and it *jumps* rather than following an anchor: the
                 original may not be loaded, in which case the surrounding page
                 has to be fetched first (FR-MSG-7). */
              <QuotePreview replyTo={m.replyTo} onDark={onDark} onJump={() => { jumpHistory.push(m.id); void jumpTo(m.replyTo!.id); }} />
            )}

            {/* FR-MSG-10: attribution travels with a forward, so it can never be
                passed off as the forwarder's own words. */}
            {m.forwardedFrom && (
              <p className={`mb-1 flex items-center gap-1 text-[11px] italic ${onDark ? 'text-white/75' : 'text-text-secondary-light dark:text-text-secondary-dark'}`}>
                <Forward size={11} />
                Forwarded from {m.forwardedFrom.senderName}
                {m.forwardedFrom.conversationName ? ` in #${m.forwardedFrom.conversationName}` : ''}
              </p>
            )}

            {/* The body of a meeting message duplicates the card's own title, so
                it is not drawn when the card is. It still exists on the row —
                notifications, sidebar previews and search all need a sentence,
                and it is the fallback if the card ever fails to load. */}
            {m.body && !meetMeta && (
              /* `mentionNames` comes from the server and covers everyone this
                 message mentions; `names` is the fallback built from senders
                 in the loaded window. The server's map wins — the fallback is
                 what used to render "@someone" for anyone who had not spoken. */
              <RichText
                text={m.body}
                names={{ ...names, ...m.mentionNames }}
                meId={user?.id}
                onDark={onDark}
              />
            )}
            {m.editedAt && (
              <span className="ml-1.5 text-[10px] opacity-70" title={`Edited ${timeOf(m.editedAt)}`}>
                (edited)
              </span>
            )}

            {meetMeta && <MeetCard meta={meetMeta} onDark={onDark} />}

            {/* Only the first. A message with three links unfurled into three
                cards is a wall, and the links themselves are still in the text. */}
            {m.linkPreviews.length > 0 && m.linkPreviews[0] && (
              <LinkPreviewCard preview={m.linkPreviews[0]} onDark={onDark} />
            )}

            {m.type === 'poll' && (
              <PollCard conversationId={m.conversationId} messageId={m.id} onDark={onDark} />
            )}

            {m.attachments.length > 0 && (
              <MessageAttachments attachments={m.attachments} onDark={onDark} />
            )}

            {/* Ticks live inside the sender's own bubble — nobody needs delivery
                state for a message they did not send. */}
            {mine && (
              <span className="ml-2 inline-flex translate-y-0.5 items-center">
                <StatusIcon status={m.delivery} />
              </span>
            )}
          </div>
        )}

        {/* Offered only on other people's messages with real text: translating
            your own words tells you nothing. */}
        {!mine && m.body && !meetMeta && m.body.trim().length > 8 && (
          <TranslateControl
            conversationId={m.conversationId}
            messageId={m.id}
            onDark={false}
          />
        )}

        {pending && <PendingNote createdAt={m.createdAt} mine={right} />}

        {/* UX-1: a failure is never silent, and the retry sits on the message
            itself rather than in a toast that scrolls out of reach. */}
        {failed && m.nonce && (
          <div className={`mt-1 flex items-center gap-3 text-[11px] font-medium ${right ? 'justify-end' : ''}`}>
            <button
              onClick={() => onRetry(m.nonce!)}
              className="flex items-center gap-1 text-red-600 hover:underline dark:text-red-400"
            >
              <RotateCcw size={11} /> Not sent — retry
            </button>
            <button
              onClick={() => void discard(m.nonce!)}
              className="text-text-secondary-light hover:underline dark:text-text-secondary-dark"
            >
              Discard
            </button>
          </div>
        )}

        {(m.reactions.length > 0 || (m.replyCount > 0 && !threadable && !compact)) && (
          <div className={`mt-1.5 flex flex-wrap items-center gap-1.5 ${right ? 'justify-end' : ''}`}>
            {m.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => void react(m.id, r.emoji)}
                aria-label={`${r.emoji} ${r.count}${r.mine ? ', including you' : ''}`}
                aria-pressed={r.mine}
                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors duration-150 ${
                  r.mine
                    ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                    : 'border-border-light bg-white text-text-secondary-light hover:bg-surface-light dark:border-border-dark dark:bg-elevated-dark dark:text-text-secondary-dark'
                }`}
              >
                <span>{r.emoji}</span>
                <span className="font-medium tabular-nums">{r.count}</span>
              </button>
            ))}
            {m.replyCount > 0 && !threadable && !compact && (
              <button
                onClick={() => openThread(m.id)}
                aria-label={`${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}${
                  newReplies > 0 ? `, ${newReplies} new` : ''}`}
                className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors duration-150 ${
                  newReplies > 0
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/25'
                }`}
              >
                <MessageSquare size={11} /> {m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'}
                {newReplies > 0 && (
                  <span className="ml-0.5 rounded-full bg-white/25 px-1.5 text-[10px] font-semibold tabular-nums">
                    {newReplies} new
                  </span>
                )}
              </button>
            )}
          </div>
        )}

        {/* Who replied, how many, how long ago — one tap opens them here (R-02, R-03). */}
        {threadable && m.replyCount > 0 && !m.deletedAt && (
          <ThreadSummary
            message={m}
            newReplies={newReplies}
            open={threadOpen}
            meId={user?.id}
            replying={replying}
            onToggle={() => setThreadOpen(!threadOpen)}
          />
        )}
      </div>

      {/* UX-7: hover actions. Hidden until hover on pointer devices; the `…`
          button opens the same set as a menu, so nothing is unreachable
          without a mouse, and everything here is keyboard-focusable. */}
      {!editing && !pending && !failed && (
        <div
          className={`${sheetOn ? '[@media(pointer:coarse)]:hidden ' : ''}absolute -top-3 z-10 flex items-center gap-0.5 rounded-xl border border-border-light bg-white p-0.5 opacity-0 pointer-events-none transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 dark:border-border-dark dark:bg-elevated-dark ${
            /* Anchored to the side the bubble is actually on. `left-12` for an
               own message put the toolbar at the far left of a full-width row,
               half a screen away from the message it acted on — easy to miss,
               and easy to hit for the wrong message. */
            compact ? 'right-1' : mine ? 'right-14' : 'left-14'
          } ${picking || menuOpen ? 'pointer-events-auto opacity-100' : ''}`}
        >
          {/* One tap for the common few, the picker for everything else. Most
              reactions are a thumbs-up; making that a two-step interaction is
              the difference between people reacting and not. */}
          {QUICK_REACTIONS.slice(0, 3).map((e) => (
            <button
              key={e}
              onClick={() => void react(m.id, e)}
              aria-label={`React with ${e}`}
              className={`${menuOpen ? 'grid' : 'hidden sm:grid'} h-7 w-7 place-items-center rounded-lg text-base leading-none hover:bg-surface-light dark:hover:bg-surface-dark`}
            >
              {e}
            </button>
          ))}

          <div className="relative">
            <IconButton label="Add reaction" size="sm" onClick={() => setPicking((v) => !v)}>
              <SmilePlus size={15} />
            </IconButton>
            {picking && (
              <EmojiPicker
                align="down"
                onPick={(e) => { setPicking(false); void react(m.id, e); }}
                onClose={() => setPicking(false)}
              />
            )}
          </div>

          {inlineReplies || compact ? (
            /* One Reply (R-06): what it does depends on where you are. */
            <IconButton label="Reply" size="sm" onClick={reply}>
              <Reply size={15} />
            </IconButton>
          ) : (
            <>
              <IconButton label="Quote reply" size="sm" onClick={() => setReplyTarget(m)}>
                <Quote size={15} />
              </IconButton>
              <IconButton label="Reply in thread" size="sm" onClick={() => openThread(m.id)}>
                <Reply size={15} />
              </IconButton>
            </>
          )}

          <IconButton
            label={m.saved ? 'Remove from saved items' : 'Save message'}
            size="sm"
            active={m.saved}
            onClick={() => void save(m.id, !m.saved)}
          >
            <Bookmark size={15} className={m.saved ? 'fill-current' : ''} />
          </IconButton>

          {can('MESSAGE_FORWARD') && (
            <IconButton label="Forward message" size="sm" onClick={() => setForwarding(true)}>
              <Forward size={15} />
            </IconButton>
          )}

          {can('MESSAGE_PIN') && (
            <IconButton
              label={m.pinnedAt ? 'Unpin message' : 'Pin message'}
              size="sm"
              active={Boolean(m.pinnedAt)}
              onClick={() => attempt(() => pin(m.id, !m.pinnedAt), m.pinnedAt ? 'Could not unpin that message' : 'Could not pin that message')}
            >
              {m.pinnedAt ? <PinOff size={15} /> : <Pin size={15} />}
            </IconButton>
          )}

          {canEdit && (
            <IconButton
              label="Edit message"
              size="sm"
              onClick={() => { setDraft(m.body ?? ''); setEditing(true); }}
            >
              <Pencil size={15} />
            </IconButton>
          )}

          {canDelete && (
            <div className="relative">
              <IconButton
                label="Delete message"
                size="sm"
                // Your own message goes at once, with Undo (G-12); someone
                // else's is recorded, so it still asks first.
                onClick={() => { if (mine) void remove(m.id); else setConfirmDelete(true); }}
              >
                <Trash2 size={15} />
              </IconButton>
              {confirmDelete && (
                /* Confirmed inline, not with `window.confirm`. A native dialog
                   blocks the whole tab — including the socket's own callbacks —
                   and cannot be styled or dismissed by Escape consistently. */
                <div
                  role="dialog"
                  aria-label="Confirm deletion"
                  className="absolute right-0 top-full z-50 mt-1 w-56 rounded-xl border border-border-light bg-white p-3 dark:border-border-dark/50 dark:bg-elevated-dark"
                >
                  <p className="mb-2 text-xs text-text-primary-light dark:text-text-primary-dark">
                    {mine ? 'Delete this message?' : "Delete someone else's message? This is recorded."}
                  </p>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setConfirmDelete(false)}
                      className="rounded-lg px-2 py-1 text-xs text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-surface-dark"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => { setConfirmDelete(false); void remove(m.id); }}
                      className="rounded-lg bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="relative">
            <IconButton label="More actions" size="sm" onClick={() => setMenuOpen((v) => !v)}>
              <MoreHorizontal size={15} />
            </IconButton>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-xl border border-border-light bg-white py-1 dark:border-border-dark/50 dark:bg-elevated-dark"
                onMouseLeave={() => setMenuOpen(false)}
              >
                {m.body && (
                  <button
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); copy(m.body ?? '', 'Text copied'); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-primary-light hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-surface-dark"
                  >
                    <Copy size={13} /> Copy text
                  </button>
                )}
                {inlineReplies && !compact && !isDm && !m.threadRootId && (
                  <button
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); setReplyTarget(m); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-primary-light hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-surface-dark"
                  >
                    <Quote size={13} /> Quote in channel
                  </button>
                )}
                {inlineReplies && !compact && isDm && !m.threadRootId && (
                  <button
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); openThread(m.id); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-primary-light hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-surface-dark"
                  >
                    <MessageSquare size={13} /> Reply in thread
                  </button>
                )}
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    // A permalink is a route in this app, never an absolute URL
                    // built from whatever origin the tab happens to be on.
                    copy(`${window.location.origin}/app/chat/${m.conversationId}/${m.id}`, 'Link copied');
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-primary-light hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-surface-dark"
                >
                  <Link2 size={13} /> Copy link to message
                </button>
                {!mine && !pending && !failed && (
                  <button
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); attempt(() => markUnread(m.conversationId, m.seq), 'Could not mark that unread'); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-primary-light hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-surface-dark"
                  >
                    <Mail size={13} /> Mark unread from here
                  </button>
                )}
                {mine && m.seq > 0 && (
                  <button
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); setInfoOpen(true); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-primary-light hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-surface-dark"
                  >
                    <Info size={13} /> Message info
                  </button>
                )}
                {!mine && (
                  <button
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); setReporting(true); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
                  >
                    <Flag size={13} /> Report message
                  </button>
                )}
                {m.editedCount > 0 && (
                  <p className="px-3 py-1.5 text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
                    Edited {m.editedCount} {m.editedCount === 1 ? 'time' : 'times'}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {sheetOpen && (
        <Suspense fallback={null}>
        <MessageActionSheet
          message={m}
          mine={right}
          canReact={!pending && !failed}
          onReact={(e) => void react(m.id, e)}
          onClose={closeSheet}
          actions={[
            { key: 'reply', label: 'Reply', icon: Reply, onSelect: reply },
            ...(can('MESSAGE_FORWARD') ? [{ key: 'forward', label: 'Forward', icon: Forward, onSelect: () => setForwarding(true) }] : []),
            ...(m.body ? [{ key: 'copy', label: 'Copy text', icon: Copy, onSelect: () => copy(m.body ?? '', 'Text copied') }] : []),
            { key: 'save', label: m.saved ? 'Remove from saved' : 'Save', icon: Bookmark, onSelect: () => void save(m.id, !m.saved) },
            ...(inlineReplies && !compact && !isDm && !m.threadRootId
              ? [{ key: 'quote', label: 'Quote in channel', icon: Quote, onSelect: () => setReplyTarget(m) }] : []),
            ...(can('MESSAGE_PIN') ? [{
              key: 'pin', label: m.pinnedAt ? 'Unpin' : 'Pin', icon: m.pinnedAt ? PinOff : Pin,
              onSelect: () => attempt(() => pin(m.id, !m.pinnedAt), m.pinnedAt ? 'Could not unpin that message' : 'Could not pin that message'),
            }] : []),
            ...(canEdit ? [{ key: 'edit', label: 'Edit', icon: Pencil, onSelect: () => { setDraft(m.body ?? ''); setEditing(true); } }] : []),
            { key: 'link', label: 'Copy link', icon: Link2, onSelect: () => copy(`${window.location.origin}/app/chat/${m.conversationId}/${m.id}`, 'Link copied') },
            ...(!mine && !pending && !failed ? [{
              key: 'unread', label: 'Mark unread from here', icon: Mail,
              onSelect: () => attempt(() => markUnread(m.conversationId, m.seq), 'Could not mark that unread'),
            }] : []),
            ...(mine && m.seq > 0 ? [{ key: 'info', label: 'Message info', icon: Info, onSelect: () => setInfoOpen(true) }] : []),
            ...(canDelete ? [{
              key: 'delete', label: 'Delete', icon: Trash2, tone: 'danger' as const,
              onSelect: () => {
                if (mine) { void remove(m.id); return; }
                void confirmOther({
                  title: "Delete someone else's message?", body: 'This is recorded.',
                  confirmLabel: 'Delete', tone: 'danger',
                }).then((ok) => { if (ok) void remove(m.id); });
              },
            }] : []),
            ...(!mine ? [{ key: 'report', label: 'Report', icon: Flag, tone: 'danger' as const, onSelect: () => setReporting(true) }] : []),
          ]}
        />
        </Suspense>
      )}
      {confirmDialog}

      {forwarding && <ForwardDialog message={m} onClose={() => setForwarding(false)} />}
      {infoOpen && <MessageInfoDialog conversationId={m.conversationId} messageId={m.id} onClose={() => setInfoOpen(false)} />}
      {reporting && (
        <ReportDialog
          user={{ id: m.senderId, name: m.senderName }}
          message={{ id: m.id, conversationId: m.conversationId }}
          alreadyBlocked={senderBlocked}
          onClose={() => setReporting(false)}
        />
      )}
    </li>
    {/* The replies, in place, as a sibling row: hovering a reply must not
        light up the root's toolbar (R-03). Indented to the bubble column. */}
    {threadable && threadOpen && (
      <li data-inline-thread-for={m.id} className="pb-1 pl-[3.375rem] pr-2 sm:pl-[3.875rem] sm:pr-4">
        <Suspense fallback={<div className="mt-1.5 h-16 animate-pulse rounded-2xl bg-white/70 dark:bg-elevated-dark/40" aria-busy="true" aria-label="Loading replies" />}>
          <InlineThread root={m} canReply={canReply} names={names} focusRequest={focusReply} replying={replying} />
        </Suspense>
      </li>
    )}
    </>
  );
};

export const MessageRow = React.memo(MessageRowInner);
