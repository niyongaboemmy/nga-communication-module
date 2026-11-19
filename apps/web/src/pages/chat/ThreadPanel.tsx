import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, Send, CornerDownRight, Paperclip, FileText, ArrowLeft, Bell, BellOff } from 'lucide-react';
import { MAX_MESSAGE_LENGTH } from '@tupo/shared';
import { IconButton, Skeleton } from '../../components/ui';
import { useNotify } from '../../context/NotificationContext';
import { useUploads } from './useUploads';
import { formatBytes, dayLabel } from './data';
import { useAuth } from '../../context/AuthContext';
import { usePermissions } from '../../hooks/usePermissions';
import { useChat } from './ChatProvider';
import { useComposerBox } from './useComposerBox';
import { drafts, threadKey } from './drafts';
import { MessageRow } from './MessageRow';
import { toWire, type MentionTarget } from './mentionText';
import * as chatApi from './api';
import type { Conversation, Message } from './types';

/**
 * A thread, in its own pane — full screen on a phone (R-05), beside the
 * conversation on a wide screen.
 *
 * The root is repeated at the top rather than linked to: a thread whose
 * subject is off-screen is a list of answers to a question you cannot see.
 * Every reply is a full message row (compact variant), so everything you can
 * do to a message in the room you can do here (R-04): react, reply with
 * "@Name", edit, delete, copy, save, report, retry a failed send.
 *
 * Opening lands at the first reply you have not seen (R-12). The header says
 * whether you follow the thread and lets you change it (R-11).
 */

export const ThreadPanel: React.FC<{ conversation: Conversation }> = ({ conversation }) => {
  const { can } = usePermissions();
  const { user } = useAuth();
  const {
    threadRootId, threadMessages, threadLoading, openThread, sendThreadReply, markThreadRead, threadUnread,
    notifyTyping, stopTyping, typingByConversation,
  } = useChat();
  const replying = (typingByConversation[conversation.id] ?? [])
    .filter((u) => u.threadRootId && u.threadRootId === threadRootId && u.userId !== user?.id)
    .map((u) => u.name.split(' ')[0]);
  const { notify } = useNotify();

  /*
   * Half-written replies, per thread (B-08), in the draft store: closing the
   * panel, switching threads, and now a reload or a crash all keep them (G-09).
   */
  const submitRef = useRef<() => void>(() => {});
  const box = useComposerBox({
    draftKey: threadKey(threadRootId ?? 'none'),
    maxHeightPx: 128,
    onSubmit: () => submitRef.current(),
    onTyping: () => notifyTyping('typing', threadRootId),
    onTypingStop: stopTyping,
  });
  const { value } = box;
  const inputRef = box.ref;
  const picked = useRef<MentionTarget[]>([]);
  const [alsoSend, setAlsoSend] = useState(false);
  const tray = useUploads();
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLLIElement>(null);

  /*
   * R-12: how many replies were new when the thread was opened, captured
   * before reading it moves the marker — the divider goes above them.
   */
  const [unreadAtOpen, setUnreadAtOpen] = useState(0);
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (threadRootId && openedFor.current !== threadRootId) {
      openedFor.current = threadRootId;
      setUnreadAtOpen(threadUnread[threadRootId] ?? 0);
    }
  }, [threadRootId, threadUnread]);

  // R-11: whether I follow this thread, and the switch.
  const [follow, setFollow] = useState<chatApi.ThreadFollow | null>(null);
  useEffect(() => {
    setFollow(null);
    if (!threadRootId) return;
    let live = true;
    chatApi.getThreadFollow(conversation.id, threadRootId)
      .then((f) => { if (live) setFollow(f); })
      .catch(() => { /* the switch simply stays hidden */ });
    return () => { live = false; };
  }, [conversation.id, threadRootId]);
  const toggleFollow = async () => {
    if (!threadRootId || !follow) return;
    const next = follow.following ? 'muted' : 'following';
    const before = follow;
    setFollow({ ...follow, choice: next, following: next === 'following' });
    try {
      setFollow(await chatApi.setThreadFollow(conversation.id, threadRootId, next));
      notify({
        title: next === 'following' ? 'Following this thread' : 'Thread muted',
        body: next === 'following' ? 'New replies will reach you.' : 'You will not be notified of new replies.',
        tone: 'success', confirmation: true,
      });
    } catch (err) {
      setFollow(before);
      notify({ title: 'Could not change that', body: err instanceof Error ? err.message : undefined, tone: 'error' });
    }
  };

  const root = threadMessages.find((m) => m.id === threadRootId);
  const replies = threadMessages.filter((m) => m.id !== threadRootId);
  // The first of the replies that were new at opening (from someone else).
  const others = replies.filter((m) => m.senderId !== user?.id && m.seq !== Number.MAX_SAFE_INTEGER);
  const firstNewId = unreadAtOpen > 0 && others.length > 0
    ? others[Math.max(0, others.length - unreadAtOpen)]?.id ?? null
    : null;

  // Land at the divider when there is one, else at the newest reply.
  const landed = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (threadLoading || !threadRootId) return;
    if (landed.current !== threadRootId) {
      landed.current = threadRootId;
      if (firstNewId && dividerRef.current) { dividerRef.current.scrollIntoView({ block: 'center' }); return; }
    }
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [threadMessages.length, threadLoading, threadRootId, firstNewId]);

  /*
   * The thread is read once its newest reply is on screen with the tab
   * visible — the same honest proxy the main view uses. Re-checked when the
   * tab comes back, so a reply that arrived while away is not cleared unseen.
   */
  useEffect(() => {
    if (!threadRootId || threadLoading || threadMessages.length === 0) return;
    const newest = threadMessages.reduce(
      (max, m) => (m.seq !== Number.MAX_SAFE_INTEGER && m.seq > max ? m.seq : max), 0);
    const mark = () => { if (!document.hidden && newest > 0) markThreadRead(threadRootId, newest); };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [threadRootId, threadLoading, threadMessages, markThreadRead]);

  useEffect(() => {
    if (!threadRootId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // A viewer or menu above the thread owns this Escape.
      if (document.querySelector('[role="dialog"][aria-modal="true"], [data-lightbox]')) return;
      // Escape in a half-written reply steps out of the box; it does not throw
      // the reply away with the panel. Handled first (capture) and stopped, or
      // the chat layout's "Escape closes the side panel" ran as well.
      if (document.activeElement === inputRef.current && inputRef.current?.value.trim()) {
        e.stopPropagation();
        inputRef.current.blur();
        return;
      }
      e.stopPropagation();
      openThread(null);
    };
    document.addEventListener('keydown', onKey, true);
    // Opened in order to reply: the caret goes to the box (and the toolbar
    // that opened it lets go of focus, C-05). Not on touch: it would throw
    // up the keyboard over the replies.
    if (!window.matchMedia('(pointer: coarse)').matches) inputRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey, true);
  }, [threadRootId, openThread]);

  /** Reply to a reply: this thread, starting "@Name " (one level deep). */
  const replyTo = useCallback((m: Message) => {
    if (!threadRootId) return;
    const key = threadKey(threadRootId);
    if (m.senderId !== user?.id) {
      picked.current = [{ id: m.senderId, name: m.senderName }, ...picked.current.filter((t) => t.id !== m.senderId)];
      const current = drafts.get(key);
      if (!current.startsWith(`@${m.senderName}`)) drafts.set(key, `@${m.senderName} ${current}`);
    }
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  }, [threadRootId, user?.id, inputRef]);

  if (!threadRootId) return null;

  const names: Record<string, string> = {};
  for (const m of threadMessages) names[m.senderId] = m.senderName;
  if (user) names[user.id] = user.name;

  /*
   * Take the text out of the box at send time, not when the server answers
   * (G-03). The send itself is optimistic and durable (G-07): a failure shows
   * on the reply, with Retry, instead of here.
   */
  const submit = async () => {
    const text = value.trim();
    if ((!text && tray.readyIds.length === 0) || tray.busy) return;
    if (text.length > MAX_MESSAGE_LENGTH) {
      notify({ title: `Messages can be up to ${MAX_MESSAGE_LENGTH.toLocaleString()} characters`, tone: 'warning' });
      return;
    }
    const attachments = tray.readyIds;
    const wasAlsoSend = alsoSend;
    box.takeForSend();
    setAlsoSend(false);
    tray.clear();
    const body = toWire(text, picked.current);
    picked.current = [];
    try {
      await sendThreadReply(body, wasAlsoSend, attachments);
    } catch (err) {
      box.restore(text);
      notify({ title: 'Your reply was not sent', body: err instanceof Error ? err.message : undefined, tone: 'error' });
    }
  };

  submitRef.current = () => { void submit(); };

  // The same rule as the server's assertCanPost: an announcement channel's
  // threads are for announcers too.
  const canReply = can('MESSAGE_SEND') && !conversation.isArchived
    && (conversation.type !== 'announcement' || can('CHANNEL_ANNOUNCE')
        || conversation.myRole === 'owner' || conversation.myRole === 'admin');

  return (
    <aside
      aria-label="Thread"
      className="flex h-full min-h-0 w-full flex-col border-l border-border-light bg-white dark:border-border-dark/30 dark:bg-chrome-dark"
    >
      <header className="pt-safe flex h-14 shrink-0 items-center gap-1 border-b border-border-light px-2 sm:px-3 dark:border-border-dark/30">
        {/* A phone's thread is a page: Back, where a page's Back is. */}
        <IconButton label="Back" className="md:hidden" onClick={() => openThread(null)}>
          <ArrowLeft size={18} />
        </IconButton>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
            Thread
          </h2>
          <p className="truncate text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
            {conversation.type === 'dm' ? conversation.name : `#${conversation.name}`}
            {root ? ` · ${root.senderName.split(' ')[0]}'s message` : ''}
          </p>
        </div>
        {follow && (
          <button
            onClick={() => void toggleFollow()}
            aria-pressed={follow.following}
            title={follow.following ? 'You get new replies. Click to mute this thread.' : 'Get notified of new replies'}
            className={`flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors duration-150 ${
              follow.following
                ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300'
                : 'text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-surface-dark'
            }`}
          >
            {follow.following ? <Bell size={14} /> : <BellOff size={14} />}
            {follow.following ? 'Following' : 'Follow'}
          </button>
        )}
        <IconButton label="Close thread" className="hidden md:grid" onClick={() => openThread(null)}>
          <X size={18} />
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2">
        {threadLoading ? (
          <div className="space-y-3 px-3" aria-busy="true" aria-label="Loading the thread">
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-10 w-4/5 rounded-xl" />
            <Skeleton className="h-10 w-3/5 rounded-xl" />
          </div>
        ) : (
          <ul role="log" aria-label="Thread messages" aria-relevant="additions" className="px-1 sm:px-2">
            {root && (
              <>
                <MessageRow message={root} newGroup names={names} variant="compact" onReply={replyTo} />
                <li className="mx-2 mb-1 mt-2 flex items-center gap-2 border-t border-border-light pt-2 dark:border-border-dark/40">
                  <span className="text-[11px] font-semibold text-text-secondary-light dark:text-text-secondary-dark">
                    {replies.length === 0
                      ? 'No replies yet'
                      : `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
                  </span>
                  <span className="text-[11px] text-text-secondary-light/70 dark:text-text-secondary-dark/60">
                    · {dayLabel(root.createdAt)}
                  </span>
                </li>
              </>
            )}
            {replies.map((m) => (
              <React.Fragment key={m.nonce ?? m.id}>
                {m.id === firstNewId && (
                  <li ref={dividerRef} className="flex items-center gap-2 px-2 py-1.5" aria-label="New replies">
                    <span className="h-px flex-1 bg-blue-400/60" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">
                      {unreadAtOpen} new
                    </span>
                    <span className="h-px flex-1 bg-blue-400/60" />
                  </li>
                )}
                <MessageRow message={m} newGroup names={names} variant="compact" onReply={replyTo} />
              </React.Fragment>
            ))}
          </ul>
        )}
        {replying.length > 0 && (
          <p role="status" className="px-4 pb-1 text-[11px] italic text-text-secondary-light dark:text-text-secondary-dark">
            {replying.length === 1 ? `${replying[0]} is replying…` : `${replying.slice(0, 2).join(' and ')} are replying…`}
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      {canReply && (
        <div className="pb-safe shrink-0 border-t border-border-light p-2 dark:border-border-dark/30"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.length) tray.add(e.dataTransfer.files); }}>
          {tray.errors.map((message, i) => (
            <p key={i} role="alert" className="mb-1 flex items-center justify-between gap-2 rounded-lg bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:bg-red-900/30 dark:text-red-300">
              {message}
              <button onClick={() => tray.dismissError(i)} aria-label="Dismiss"><X size={12} /></button>
            </p>
          ))}
          {tray.uploads.length > 0 && (
            <ul className="mb-1.5 flex flex-wrap gap-1.5" aria-label="Attachments">
              {tray.uploads.map((u) => (
                <li key={u.localId} className="flex items-center gap-1.5 rounded-lg border border-border-light bg-surface-light py-1 pl-1 pr-1.5 dark:border-border-dark/50 dark:bg-elevated-dark/60">
                  {u.previewUrl && u.kind === 'image'
                    ? <img src={u.previewUrl} alt="" className="h-7 w-7 rounded object-cover" />
                    : <span className="grid h-7 w-7 place-items-center rounded bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-300"><FileText size={13} /></span>}
                  <span className="max-w-[7rem]">
                    <span className="block truncate text-[11px] font-medium text-text-primary-light dark:text-text-primary-dark">{u.name}</span>
                    <span className="block text-[10px] text-text-secondary-light dark:text-text-secondary-dark">
                      {u.state === 'failed' ? 'Failed' : u.state === 'ready' ? formatBytes(u.size) : `${Math.round(u.progress * 100)}%`}
                    </span>
                  </span>
                  <IconButton label={`Remove ${u.name}`} size="sm" onClick={() => tray.remove(u.localId)}><X size={12} /></IconButton>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-1.5 rounded-xl border border-border-light bg-surface-light px-2 py-1.5 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 dark:border-border-dark/50 dark:bg-elevated-dark/60">
            <IconButton label="Attach files" size="sm" onClick={() => fileRef.current?.click()} className="mb-0.5">
              <Paperclip size={15} />
            </IconButton>
            <input ref={fileRef} type="file" multiple hidden
              onChange={(e) => { if (e.target.files) tray.add(e.target.files); e.target.value = ''; }} />
            <label className="sr-only" htmlFor="thread-composer">Reply in thread</label>
            <textarea
              id="thread-composer"
              {...box.textareaProps}
              rows={1}
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (files.length) { e.preventDefault(); tray.add(files); }
              }}
              onKeyDown={(e) => { box.handleSubmitKey(e); }}
              placeholder="Reply…"
              className="max-h-32 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm text-text-primary-light outline-none placeholder:text-text-secondary-light/80 dark:text-text-primary-dark"
            />
            <button
              onClick={() => void submit()}
              disabled={(!value.trim() && tray.readyIds.length === 0) || tray.busy || value.length > MAX_MESSAGE_LENGTH}
              aria-label="Send reply"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-blue-600 text-white transition-colors duration-150 hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send size={15} />
            </button>
          </div>

          {/* FR-MSG-6. Sometimes the conclusion of a thread belongs in the room,
              and making people copy-paste it is how threads get abandoned. */}
          {conversation.type !== 'dm' && (
            <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 px-1 text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
              <input
                type="checkbox"
                checked={alsoSend}
                onChange={(e) => setAlsoSend(e.target.checked)}
                className="accent-blue-600"
              />
              <CornerDownRight size={11} />
              Also send to {conversation.type === 'group' ? 'the group' : `#${conversation.name}`}
            </label>
          )}
        </div>
      )}
    </aside>
  );
};
