import React, { useEffect, useState } from 'react';
import { Pin, X } from 'lucide-react';
import { Avatar, EmptyState, IconButton, Skeleton } from '../../components/ui';
import { LoadError } from '../../components/LoadError';
import { usePermissions } from '../../hooks/usePermissions';
import { useChat } from './ChatProvider';
import { RichText } from './RichText';
import * as chatApi from './api';
import { timeOf, dayLabel } from './data';
import type { Conversation, Message } from './types';

/**
 * Every pinned message in one list (B-10), opened from the header's pin
 * button. The bar above the log shows the latest pin; this is where the rest
 * are read, jumped to, or unpinned.
 */
export const PinnedPanel: React.FC<{ conversation: Conversation; onClose: () => void }> = ({ conversation, onClose }) => {
  const { can } = usePermissions();
  const { jumpTo, pin, messages } = useChat();
  const [pinned, setPinned] = useState<Message[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Re-read when a pin is added or removed by anyone (it arrives as an update).
  const signature = messages.filter((m) => m.pinnedAt).map((m) => m.id).join(',');

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    chatApi.listPinned(conversation.id)
      .then((rows) => { if (!cancelled) setPinned(rows); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [conversation.id, signature, attempt]);

  return (
    <aside aria-label="Pinned messages" data-side-panel
      className="flex h-full min-h-0 w-full flex-col border-l border-border-light bg-white dark:border-border-dark/30 dark:bg-chrome-dark">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-light px-3 dark:border-border-dark/30">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
          <Pin size={15} /> Pinned{pinned ? ` · ${pinned.length}` : ''}
        </h2>
        <IconButton label="Close pinned messages" onClick={onClose}><X size={18} /></IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {failed ? (
          <LoadError what="pinned messages" compact onRetry={() => setAttempt((n) => n + 1)} />
        ) : pinned === null ? (
          <div className="space-y-2 p-1" aria-busy="true">
            {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
          </div>
        ) : pinned.length === 0 ? (
          <EmptyState icon={<Pin size={22} />} title="Nothing pinned yet"
            hint="Pin a message from its menu to keep it here for everyone." />
        ) : (
          <ul className="space-y-1">
            {pinned.map((m) => (
              <li key={m.id} className="group rounded-xl border border-border-light p-2.5 dark:border-border-dark/40">
                <div className="flex items-center gap-2">
                  <Avatar name={m.senderName ?? '?'} src={m.senderAvatarUrl ?? undefined} size={22} />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-text-primary-light dark:text-text-primary-dark">{m.senderName}</span>
                  <span className="shrink-0 text-[10px] text-text-secondary-light dark:text-text-secondary-dark">{dayLabel(m.createdAt)} {timeOf(m.createdAt)}</span>
                </div>
                <div className="mt-1 line-clamp-4 text-sm text-text-primary-light dark:text-text-primary-dark">
                  {m.body ? <RichText text={m.body} names={m.mentionNames ?? {}} /> : <span className="italic opacity-70">Attachment</span>}
                </div>
                <div className="mt-1.5 flex gap-3 text-xs">
                  <button onClick={() => void jumpTo(m.id)} className="font-medium text-blue-600 hover:underline dark:text-blue-400">Show in chat</button>
                  {can('MESSAGE_PIN') && (
                    <button onClick={() => void pin(m.id, false)} className="text-text-secondary-light hover:underline dark:text-text-secondary-dark">Unpin</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
};
