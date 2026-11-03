import React, { useEffect, useState } from 'react';
import { MessagesSquare, X, Hash, MessageSquare, Users, Megaphone } from 'lucide-react';
import { IconButton, Skeleton, EmptyState } from '../../components/ui';
import { useChat } from './ChatProvider';
import { shortStamp } from './data';
import * as chatApi from './api';

/**
 * Threads — every thread the reader follows, across all conversations, with
 * what is new in each.
 *
 * Thread replies deliberately do not light up a conversation's badge (a side
 * conversation between two people must not make a 400-person channel look
 * busy). This is where they surface instead: one list, newest activity first,
 * each row opening straight into the thread.
 */

const KIND_ICON: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  dm: MessageSquare, channel: Hash, announcement: Megaphone, group: Users,
};

export const ThreadsInbox: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { setActiveId, openThread, threadUnread } = useChat();
  const [threads, setThreads] = useState<chatApi.FollowedThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = React.useCallback(() => {
    setLoading(true);
    setFailed(false);
    chatApi.listFollowedThreads()
      .then(setThreads)
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = (t: chatApi.FollowedThread) => {
    // Switching conversation clears any open thread, so the thread is opened
    // after the switch — both land in the same render.
    setActiveId(t.conversationId);
    openThread(t.rootId);
  };

  return (
    <aside
      aria-label="Threads"
      className="flex h-full min-h-0 w-full flex-col border-l border-border-light bg-white dark:border-border-dark/30 dark:bg-chrome-dark"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-light px-3 dark:border-border-dark/30">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
          <MessagesSquare size={15} /> Threads
        </h2>
        <IconButton label="Close threads" onClick={onClose}><X size={18} /></IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="space-y-2 p-1" aria-busy="true">
            {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
          </div>
        ) : failed ? (
          <EmptyState
            icon={<MessagesSquare size={22} />}
            title="Threads could not be loaded"
            hint="Check your connection and try again."
            action={<button onClick={load} className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">Try again</button>}
          />
        ) : threads.length === 0 ? (
          <EmptyState
            icon={<MessagesSquare size={22} />}
            title="No threads yet"
            hint="Threads you start, reply to or open will collect here."
          />
        ) : (
          <ul className="space-y-1.5">
            {threads.map((t) => {
              // Live counter first: it moves with the socket, the fetched one does not.
              const unread = threadUnread[t.rootId] ?? 0;
              const Icon = KIND_ICON[t.conversationType] ?? Hash;
              return (
                <li key={t.rootId}>
                  <button
                    onClick={() => open(t)}
                    className={`w-full rounded-xl border p-2.5 text-left transition-colors duration-150 ${
                      unread > 0
                        ? 'border-blue-200 bg-blue-50/70 hover:bg-blue-50 dark:border-blue-800/60 dark:bg-blue-900/20 dark:hover:bg-blue-900/30'
                        : 'border-border-light bg-surface-light hover:bg-white dark:border-border-dark/40 dark:bg-elevated-dark/40 dark:hover:bg-elevated-dark'
                    }`}
                  >
                    <span className="mb-1 flex items-center gap-1.5">
                      <Icon size={11} className="shrink-0 opacity-60" />
                      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-text-secondary-light dark:text-text-secondary-dark">
                        {t.conversationName ?? 'Conversation'}
                      </span>
                      {t.lastReplyAt && (
                        <span className="shrink-0 text-[10px] tabular-nums text-text-secondary-light dark:text-text-secondary-dark">
                          {shortStamp(t.lastReplyAt)}
                        </span>
                      )}
                    </span>
                    <span className={`line-clamp-2 block text-xs ${
                      unread > 0
                        ? 'font-semibold text-text-primary-light dark:text-text-primary-dark'
                        : 'text-text-secondary-light dark:text-text-secondary-dark'
                    }`}>
                      {t.rootSenderName ? `${t.rootSenderName.split(' ')[0]}: ` : ''}{t.rootPreview}
                    </span>
                    <span className="mt-1.5 flex items-center gap-2 text-[11px]">
                      <span className="text-text-secondary-light dark:text-text-secondary-dark">
                        {t.replyCount} {t.replyCount === 1 ? 'reply' : 'replies'}
                      </span>
                      {unread > 0 && (
                        <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
                          {unread} new
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
};
