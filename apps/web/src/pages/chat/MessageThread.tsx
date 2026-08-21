import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Hash, Megaphone, Users, ArrowLeft, Phone, Video, Info, Pin, Search,
  SmilePlus, Reply, MoreHorizontal, Clock, Check, CheckCheck, AlertCircle,
  RotateCcw, ChevronDown, FileText, MessageSquare, Lock, Pencil, Trash2,
  X, Bookmark, Forward, PinOff, Link2, Quote,
} from 'lucide-react';
import { Avatar, IconButton, Skeleton, EmptyState, Spinner } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../context/AuthContext';
import { dayLabel, startsNewGroup, timeOf, formatBytes, firstUnreadId, typingLabel } from './data';
import { useChat } from './ChatProvider';
import { toPresence } from './types';
import type { Conversation, Message } from './types';
import { RichText } from './RichText';
import { EmojiPicker } from './EmojiPicker';
import { ForwardDialog } from './ForwardDialog';
import { PinnedBar } from './PinnedBar';
import { QUICK_REACTIONS, EDIT_WINDOW_MS } from '@tupo/shared';

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
}> = ({ conversation: c, onBack, onToggleContext, contextOpen }) => {
  const { can } = usePermissions();
  const { typing } = useChat();
  const Icon = c.type === 'dm' ? null : KIND_ICON[c.type];

  // The typing line replaces the subtitle rather than pushing it aside: two
  // lines of status in a 56px header is one line too many, and "typing" is
  // always the more urgent of the two.
  const typingText = typingLabel(typing.map((t) => t.name.split(' ')[0]!));

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
        {c.type === 'dm' ? (
          <Avatar name={c.name} src={c.avatarUrl ?? undefined} size={34} presence={toPresence(c.peer?.presence)} />
        ) : (
          <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500 dark:bg-card-dark/60 dark:text-slate-300">
            {c.iconEmoji ? <span className="text-base leading-none">{c.iconEmoji}</span> : Icon && <Icon size={17} />}
          </span>
        )}
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="block truncate text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
              {c.name}
            </span>
            {c.isPrivate && c.type !== 'dm' && <Lock size={12} className="shrink-0 opacity-60" />}
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
              ? (toPresence(c.peer?.presence) === 'online' ? 'Online' : (c.peer?.role ?? 'Offline'))
              : `${c.memberCount} members${c.topic ? ` · ${c.topic}` : ''}`)}
          </span>
        </span>
      </button>

      <div className="flex items-center gap-0.5">
        {can('MESSAGE_PIN') && (
          <IconButton label="Pinned messages" className="hidden sm:grid"><Pin size={17} /></IconButton>
        )}
        <IconButton label="Search in conversation" className="hidden sm:grid"><Search size={17} /></IconButton>
        {can('MEET_START') && (
          <>
            <IconButton label="Start an audio call" className="hidden sm:grid"><Phone size={17} /></IconButton>
            <IconButton label="Start a video meeting"><Video size={17} /></IconButton>
          </>
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

const StatusIcon: React.FC<{ status: Message['delivery'] }> = ({ status }) => {
  switch (status) {
    case 'pending': return <Clock size={12} aria-label="Sending" className="opacity-70" />;
    case 'sent': return <Check size={13} aria-label="Sent" className="opacity-70" />;
    case 'delivered': return <CheckCheck size={13} aria-label="Delivered" className="opacity-70" />;
    case 'read': return <CheckCheck size={13} aria-label="Read" className="text-sky-200" />;
    case 'failed': return <AlertCircle size={13} aria-label="Failed to send" className="text-red-300" />;
    default: return null;
  }
};

const MessageRow: React.FC<{
  message: Message;
  newGroup: boolean;
  names: Record<string, string>;
  onRetry: (nonce: string) => void;
}> = ({ message: m, newGroup, names, onRetry }) => {
  const { can } = usePermissions();
  const { user } = useAuth();
  const {
    react, edit, remove, pin, save, openThread, setReplyTarget, jumpTo, highlightedId,
  } = useChat();
  const [picking, setPicking] = useState(false);
  const [forwarding, setForwarding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);

  const mine = m.senderId === user?.id;

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

  const failed = m.delivery === 'failed';
  const pending = m.delivery === 'pending';
  // Editing is the author's, within the window, and never on a message that has
  // not landed yet — there is nothing on the server to edit.
  const withinEditWindow = Date.now() - new Date(m.createdAt).getTime() < EDIT_WINDOW_MS;
  const canEdit = mine && !pending && !failed && withinEditWindow && can('MESSAGE_EDIT_OWN');
  const canDelete = (mine && can('MESSAGE_DELETE_OWN')) || can('MESSAGE_DELETE_ANY');

  const submitEdit = async () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === (m.body ?? '')) return;
    try { await edit(m.id, next); } catch { /* the row simply does not change */ }
  };

  return (
    <li
      id={`msg-${m.id}`}
      className={`group relative flex gap-2.5 px-2 sm:px-4 ${newGroup ? 'mt-3' : 'mt-0.5'} ${
        mine ? 'flex-row-reverse' : ''
      } ${m.mentionsMe ? 'bg-amber-50/60 dark:bg-amber-500/5' : ''} ${
        highlightedId === m.id ? 'animate-fade-in rounded-xl bg-blue-100/70 dark:bg-blue-500/15' : ''
      }`}
    >
      {/* The gutter keeps its width when the avatar is hidden, so a grouped run
          stays aligned instead of stepping left. */}
      <span className="w-9 shrink-0">
        {newGroup && <Avatar name={m.senderName} src={m.senderAvatarUrl ?? undefined} size={36} />}
      </span>

      <div className={`min-w-0 max-w-[min(46rem,85%)] ${mine ? 'items-end' : 'items-start'} flex flex-col`}>
        {newGroup && (
          <div className={`mb-1 flex items-baseline gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
            <span className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
              {mine ? 'You' : m.senderName}
            </span>
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

        {editing ? (
          /* Edit in place rather than in a modal. The surrounding conversation
             is the context you are editing against, and a dialog hides it. */
          <div className="w-full min-w-[16rem]">
            <textarea
              ref={editRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitEdit(); }
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
              <span className="text-text-secondary-light/70 dark:text-text-secondary-dark/60">
                Escape to cancel · Enter to save
              </span>
            </div>
          </div>
        ) : (
          <div
            className={`message-body px-3.5 py-2 text-sm ${
              mine
                ? 'bubble-out bg-blue-600 text-white'
                : 'bubble-in border border-border-light bg-white text-text-primary-light dark:border-border-dark/40 dark:bg-elevated-dark dark:text-text-primary-dark'
            } ${failed ? 'ring-1 ring-red-400' : ''} ${pending ? 'opacity-75' : ''}`}
          >
            {/* Quote-reply context, rendered above the message it answers. */}
            {m.replyTo && (
              /* Tappable, and it *jumps* rather than following an anchor: the
                 original may not be loaded, in which case the surrounding page
                 has to be fetched first (FR-MSG-7). */
              <button
                onClick={() => void jumpTo(m.replyTo!.id)}
                className={`mb-1.5 block w-full truncate border-l-2 pl-2 text-left text-xs transition-opacity hover:opacity-80 ${
                  mine ? 'border-white/50 text-white/80' : 'border-blue-400 text-text-secondary-light dark:text-text-secondary-dark'
                }`}
              >
                <span className="font-medium">{m.replyTo.senderName}</span>
                <span className="ml-1 opacity-80">
                  {m.replyTo.deleted ? 'message deleted' : (m.replyTo.body ?? 'attachment')}
                </span>
              </button>
            )}

            {/* FR-MSG-10: attribution travels with a forward, so it can never be
                passed off as the forwarder's own words. */}
            {m.forwardedFrom && (
              <p className={`mb-1 flex items-center gap-1 text-[11px] italic ${mine ? 'text-white/75' : 'text-text-secondary-light dark:text-text-secondary-dark'}`}>
                <Forward size={11} />
                Forwarded from {m.forwardedFrom.senderName}
                {m.forwardedFrom.conversationName ? ` in #${m.forwardedFrom.conversationName}` : ''}
              </p>
            )}

            {m.body && <RichText text={m.body} names={names} meId={user?.id} onDark={mine} />}
            {m.editedAt && (
              <span className="ml-1.5 text-[10px] opacity-70" title={`Edited ${timeOf(m.editedAt)}`}>
                (edited)
              </span>
            )}

            {m.attachments.map((a) => (
              <a
                key={a.fileId}
                href={`/api/files/${a.fileId}/content`}
                className={`mt-2 flex items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors duration-150 ${
                  mine ? 'bg-white/15 hover:bg-white/25' : 'bg-surface-light hover:bg-slate-100 dark:bg-card-dark/50 dark:hover:bg-card-dark'
                }`}
              >
                <FileText size={18} className="shrink-0 opacity-80" />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{a.name}</span>
                  <span className="block text-[11px] opacity-70">{formatBytes(a.size)}</span>
                </span>
              </a>
            ))}

            {/* Ticks live inside the sender's own bubble — nobody needs delivery
                state for a message they did not send. */}
            {mine && (
              <span className="ml-2 inline-flex translate-y-0.5 items-center">
                <StatusIcon status={m.delivery} />
              </span>
            )}
          </div>
        )}

        {/* UX-1: a failure is never silent, and the retry sits on the message
            itself rather than in a toast that scrolls out of reach. */}
        {failed && m.nonce && (
          <button
            onClick={() => onRetry(m.nonce!)}
            className="mt-1 flex items-center gap-1 text-[11px] font-medium text-red-600 hover:underline dark:text-red-400"
          >
            <RotateCcw size={11} /> Not sent — tap to retry
          </button>
        )}

        {(m.reactions.length > 0 || m.replyCount > 0) && (
          <div className={`mt-1.5 flex flex-wrap items-center gap-1.5 ${mine ? 'justify-end' : ''}`}>
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
            {m.replyCount > 0 && (
              <button
                onClick={() => openThread(m.id)}
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/25"
              >
                <MessageSquare size={11} /> {m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* UX-7: hover actions. Hidden until hover on pointer devices; the `…`
          button opens the same set as a menu, so nothing is unreachable
          without a mouse, and everything here is keyboard-focusable. */}
      {!editing && !pending && (
        <div
          className={`absolute -top-3 z-10 flex items-center gap-0.5 rounded-xl border border-border-light bg-white p-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100 dark:border-border-dark dark:bg-elevated-dark ${
            /* Anchored to the side the bubble is actually on. `left-12` for an
               own message put the toolbar at the far left of a full-width row,
               half a screen away from the message it acted on — easy to miss,
               and easy to hit for the wrong message. */
            mine ? 'right-14' : 'left-14'
          } ${picking || menuOpen ? 'opacity-100' : ''}`}
        >
          {/* One tap for the common few, the picker for everything else. Most
              reactions are a thumbs-up; making that a two-step interaction is
              the difference between people reacting and not. */}
          {QUICK_REACTIONS.slice(0, 3).map((e) => (
            <button
              key={e}
              onClick={() => void react(m.id, e)}
              aria-label={`React with ${e}`}
              className="hidden h-7 w-7 place-items-center rounded-lg text-base leading-none hover:bg-surface-light sm:grid dark:hover:bg-surface-dark"
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

          <IconButton label="Quote reply" size="sm" onClick={() => setReplyTarget(m)}>
            <Quote size={15} />
          </IconButton>

          <IconButton label="Reply in thread" size="sm" onClick={() => openThread(m.id)}>
            <Reply size={15} />
          </IconButton>

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
              onClick={() => void pin(m.id, !m.pinnedAt)}
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
              <IconButton label="Delete message" size="sm" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={15} />
              </IconButton>
              {confirmDelete && (
                /* Confirmed inline, not with `window.confirm`. A native dialog
                   blocks the whole tab — including the socket's own callbacks —
                   and cannot be styled or dismissed by Escape consistently. */
                <div
                  role="dialog"
                  aria-label="Confirm deletion"
                  className="absolute right-0 top-full z-50 mt-1 w-56 rounded-xl border border-border-light bg-white p-3 shadow-xl dark:border-border-dark/50 dark:bg-elevated-dark"
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
                className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-xl border border-border-light bg-white py-1 shadow-xl dark:border-border-dark/50 dark:bg-elevated-dark"
                onMouseLeave={() => setMenuOpen(false)}
              >
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    // A permalink is a route in this app, never an absolute URL
                    // built from whatever origin the tab happens to be on.
                    const url = `${window.location.origin}/app/chat/${m.conversationId}/${m.id}`;
                    void navigator.clipboard?.writeText(url).catch(() => {});
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-primary-light hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-surface-dark"
                >
                  <Link2 size={13} /> Copy link to message
                </button>
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

      {forwarding && <ForwardDialog message={m} onClose={() => setForwarding(false)} />}
    </li>
  );
};

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
  children: React.ReactNode; // the composer
}> = ({ conversation, onBack, onToggleContext, contextOpen, children }) => {
  const { user } = useAuth();
  const {
    messages, messagesLoading: loading, hasMore, loadingMore, loadOlder,
    markReadTo, retry,
  } = useChat();

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  /** Names for resolving `<@id>` mentions without a lookup per message. */
  const names = useMemo(() => {
    const out: Record<string, string> = {};
    for (const m of messages) out[m.senderId] = m.senderName;
    if (user) out[user.id] = user.name;
    return out;
  }, [messages, user]);

  const dividerId = useMemo(
    () => firstUnreadId(messages, conversation.lastReadSeq, user?.id ?? ''),
    [messages, conversation.lastReadSeq, user?.id],
  );

  // UX-2: only follow the tail when the reader is already at it.
  useLayoutEffect(() => {
    if (atBottom) bottomRef.current?.scrollIntoView({ block: 'end' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, conversation.id]);

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
  }, [hasMore, loading, loadingMore, loadOlderHoldingPosition]);

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
    const newest = messages.reduce(
      (max, m) => (m.seq !== Number.MAX_SAFE_INTEGER && m.seq > max ? m.seq : max), 0);
    if (newest > 0) markReadTo(newest);
  }, [atBottom, loading, messages, markReadTo]);

  const jumpToLatest = () =>
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });

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
      />

      <PinnedBar conversation={conversation} />

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain py-4">
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
              {messages.map((m, i) => {
                const day = dayLabel(m.createdAt);
                const showDay = day !== lastDay;
                lastDay = day;
                return (
                  <React.Fragment key={m.id}>
                    {showDay && (
                      <li className="sticky top-0 z-10 flex justify-center py-2">
                        <span className="rounded-full border border-border-light bg-white/90 px-3 py-0.5 text-[11px] font-semibold text-text-secondary-light backdrop-blur dark:border-border-dark/50 dark:bg-elevated-dark/90 dark:text-text-secondary-dark">
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
                      onRetry={retry}
                    />
                  </React.Fragment>
                );
              })}
            </ul>
          )}
          <div ref={bottomRef} />
        </div>

        {/* UX-3 */}
        {!atBottom && !loading && messages.length > 0 && (
          <button
            onClick={jumpToLatest}
            className="animate-fade-in absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-white transition-colors duration-150 hover:bg-slate-800 dark:bg-blue-600 dark:hover:bg-blue-500"
          >
            <ChevronDown size={14} />
            Jump to latest
            {conversation.unread > 0 && (
              <span className="ml-0.5 rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] tabular-nums">
                {conversation.unread}
              </span>
            )}
          </button>
        )}
      </div>

      {children}
    </section>
  );
};
