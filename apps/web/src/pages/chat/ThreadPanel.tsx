import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, Send, CornerDownRight, Paperclip, FileText } from 'lucide-react';
import { Avatar, IconButton, Skeleton } from '../../components/ui';
import { useNotify } from '../../context/NotificationContext';
import { MessageAttachments } from './Attachments';
import { useUploads } from './useUploads';
import { formatBytes } from './data';
import { useAuth } from '../../context/AuthContext';
import { usePermissions } from '../../hooks/usePermissions';
import { useChat } from './ChatProvider';
import { RichText } from './RichText';
import { timeOf, dayLabel } from './data';
import type { Conversation, Message } from './types';

/**
 * A thread, in its own pane.
 *
 * Threads are the one feature that decides whether a busy class channel stays
 * readable, and they only work if the side conversation is genuinely to one
 * side. Rendering replies inline — indented under the parent — is the version
 * that fails: forty replies still push everything else off the screen, which is
 * exactly what the reader was promised would not happen.
 *
 * The root message is repeated at the top rather than linked to. A thread whose
 * subject is off-screen is a list of answers to a question you cannot see.
 */

const ThreadMessage: React.FC<{
  message: Message;
  isRoot: boolean;
  names: Record<string, string>;
}> = ({ message: m, isRoot, names }) => {
  const { user } = useAuth();
  const mine = m.senderId === user?.id;

  if (m.deletedAt) {
    return (
      <li className="px-3 py-1.5 text-xs italic text-text-secondary-light dark:text-text-secondary-dark">
        This message was deleted
      </li>
    );
  }

  return (
    <li className={`flex gap-2.5 px-3 ${isRoot ? 'pb-3' : 'py-1.5'}`}>
      <Avatar name={m.senderName} src={m.senderAvatarUrl ?? undefined} size={30} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-xs font-semibold text-text-primary-light dark:text-text-primary-dark">
            {mine ? 'You' : m.senderName}
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-text-secondary-light dark:text-text-secondary-dark">
            {timeOf(m.createdAt)}
          </span>
        </div>
        <div className="mt-0.5 text-sm leading-relaxed text-text-primary-light dark:text-text-primary-dark">
          {m.body && <RichText text={m.body} names={{ ...names, ...m.mentionNames }} meId={user?.id} />}
          {m.editedAt && <span className="ml-1 text-[10px] opacity-70">(edited)</span>}
        </div>
        {/* The root's photo is usually what the thread is about (B-08). */}
        {m.attachments.length > 0 && <MessageAttachments attachments={m.attachments} onDark={false} />}
        {m.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {m.reactions.map((r) => (
              <span
                key={r.emoji}
                className="rounded-full border border-border-light px-1.5 py-0.5 text-[11px] dark:border-border-dark"
              >
                {r.emoji} {r.count}
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
};

/**
 * Half-written replies, per thread, for as long as the tab is open (B-08):
 * closing the panel, or switching to another thread and back, keeps them.
 */
const threadDrafts = new Map<string, string>();

export const ThreadPanel: React.FC<{ conversation: Conversation }> = ({ conversation }) => {
  const { can } = usePermissions();
  const { user } = useAuth();
  const {
    threadRootId, threadMessages, threadLoading, openThread, sendThreadReply, markThreadRead,
  } = useChat();

  const { notify } = useNotify();
  const [value, setValueState] = useState(() => (threadRootId ? threadDrafts.get(threadRootId) ?? '' : ''));
  const setValue = (next: string) => {
    setValueState(next);
    if (!threadRootId) return;
    if (next) threadDrafts.set(threadRootId, next); else threadDrafts.delete(threadRootId);
  };
  // Another thread opened in the same panel: show that thread's draft.
  useEffect(() => { setValueState(threadRootId ? threadDrafts.get(threadRootId) ?? '' : ''); }, [threadRootId]);
  const [alsoSend, setAlsoSend] = useState(false);
  const [sending, setSending] = useState(false);
  const tray = useUploads();
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [threadMessages.length]);

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
    // A thread opened by clicking "3 replies" is opened in order to reply.
    if (!window.matchMedia('(pointer: coarse)').matches) inputRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey, true);
  }, [threadRootId, openThread]);

  if (!threadRootId) return null;

  const names: Record<string, string> = {};
  for (const m of threadMessages) names[m.senderId] = m.senderName;
  if (user) names[user.id] = user.name;

  const root = threadMessages.find((m) => m.id === threadRootId);
  const replies = threadMessages.filter((m) => m.id !== threadRootId);

  const submit = async () => {
    const text = value.trim();
    if ((!text && tray.readyIds.length === 0) || sending || tray.busy) return;
    setSending(true);
    try {
      await sendThreadReply(text, alsoSend, tray.readyIds);
      setValue('');
      setAlsoSend(false);
      tray.clear();
    } catch (err) {
      // The reply stays in the box to try again (B-10: failures are said).
      notify({ title: 'Your reply was not sent', body: err instanceof Error ? err.message : undefined, tone: 'error' });
    } finally {
      setSending(false);
    }
  };

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
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-light px-3 dark:border-border-dark/30">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
            Thread
          </h2>
          <p className="truncate text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
            {conversation.type === 'dm' ? conversation.name : `#${conversation.name}`}
          </p>
        </div>
        <IconButton label="Close thread" onClick={() => openThread(null)}>
          <X size={18} />
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-3">
        {threadLoading ? (
          <div className="space-y-3 px-3" aria-busy="true">
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-10 w-4/5 rounded-xl" />
            <Skeleton className="h-10 w-3/5 rounded-xl" />
          </div>
        ) : (
          <ul role="log" aria-label="Thread messages" aria-relevant="additions">
            {root && (
              <>
                <ThreadMessage message={root} isRoot names={names} />
                <li className="mx-3 mb-2 flex items-center gap-2 border-t border-border-light pt-2 dark:border-border-dark/40">
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
              <ThreadMessage key={m.id} message={m} isRoot={false} names={names} />
            ))}
          </ul>
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
              ref={inputRef}
              rows={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (files.length) { e.preventDefault(); tray.add(files); }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !window.matchMedia('(pointer: coarse)').matches) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="Reply…"
              className="max-h-32 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm text-text-primary-light outline-none placeholder:text-text-secondary-light/80 dark:text-text-primary-dark"
            />
            <button
              onClick={() => void submit()}
              disabled={(!value.trim() && tray.readyIds.length === 0) || sending || tray.busy}
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
