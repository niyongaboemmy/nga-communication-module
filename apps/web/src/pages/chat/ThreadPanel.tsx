import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, Send, CornerDownRight } from 'lucide-react';
import { Avatar, IconButton, Skeleton } from '../../components/ui';
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
          {m.body && <RichText text={m.body} names={names} meId={user?.id} />}
          {m.editedAt && <span className="ml-1 text-[10px] opacity-70">(edited)</span>}
        </div>
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

export const ThreadPanel: React.FC<{ conversation: Conversation }> = ({ conversation }) => {
  const { can } = usePermissions();
  const { user } = useAuth();
  const {
    threadRootId, threadMessages, threadLoading, openThread, sendThreadReply,
  } = useChat();

  const [value, setValue] = useState('');
  const [alsoSend, setAlsoSend] = useState(false);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [threadMessages.length]);

  useEffect(() => {
    if (!threadRootId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') openThread(null); };
    document.addEventListener('keydown', onKey);
    // A thread opened by clicking "3 replies" is opened in order to reply.
    if (!window.matchMedia('(pointer: coarse)').matches) inputRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [threadRootId, openThread]);

  if (!threadRootId) return null;

  const names: Record<string, string> = {};
  for (const m of threadMessages) names[m.senderId] = m.senderName;
  if (user) names[user.id] = user.name;

  const root = threadMessages.find((m) => m.id === threadRootId);
  const replies = threadMessages.filter((m) => m.id !== threadRootId);

  const submit = async () => {
    const text = value.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await sendThreadReply(text, alsoSend);
      setValue('');
      setAlsoSend(false);
    } finally {
      setSending(false);
    }
  };

  const canReply = can('MESSAGE_SEND') && !conversation.isArchived;

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
        <div className="pb-safe shrink-0 border-t border-border-light p-2 dark:border-border-dark/30">
          <div className="flex items-end gap-1.5 rounded-xl border border-border-light bg-surface-light px-2 py-1.5 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 dark:border-border-dark/50 dark:bg-elevated-dark/60">
            <label className="sr-only" htmlFor="thread-composer">Reply in thread</label>
            <textarea
              id="thread-composer"
              ref={inputRef}
              rows={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
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
              disabled={!value.trim() || sending}
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
