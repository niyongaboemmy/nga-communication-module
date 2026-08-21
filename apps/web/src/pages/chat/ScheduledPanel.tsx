import React, { useEffect, useState } from 'react';
import { X, Clock, Trash2, Hash } from 'lucide-react';
import { IconButton, Skeleton, EmptyState } from '../../components/ui';
import { useNotify } from '../../context/NotificationContext';
import { useChat } from './ChatProvider';
import * as chatApi from './api';

/**
 * Messages waiting to be sent (FR-MSG-18).
 *
 * The queue is visible and cancellable, which is the half of "schedule send"
 * that is usually missing. Something that will post in your name at 08:00
 * tomorrow and cannot be found or stopped is not a feature, it is a liability —
 * particularly in a school, where the thing being scheduled is often an
 * announcement to four hundred parents.
 */

const whenLabel = (iso: string): string => {
  const at = new Date(iso);
  const diffMinutes = Math.round((at.getTime() - Date.now()) / 60_000);
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  if (diffMinutes < 60) return `in ${Math.max(diffMinutes, 1)} min · ${time}`;

  const today = new Date();
  const sameDay = at.toDateString() === today.toDateString();
  if (sameDay) return `today at ${time}`;

  const tomorrow = new Date(today.getTime() + 86_400_000);
  if (at.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;

  return `${at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} at ${time}`;
};

export const ScheduledPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { notify } = useNotify();
  const { setActiveId } = useChat();
  const [items, setItems] = useState<chatApi.ScheduledMessage[] | null>(null);

  const load = () => {
    chatApi.listScheduled()
      .then(setItems)
      .catch(() => setItems([]));
  };

  useEffect(load, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cancel = async (item: chatApi.ScheduledMessage) => {
    // Removed locally first — the worker sweeps every 30 seconds, and a list
    // that still shows a cancelled message until the next fetch invites a
    // second, panicked click.
    setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? null);
    try {
      await chatApi.cancelScheduled(item.id);
      notify({ title: 'Scheduled message cancelled', tone: 'success', confirmation: true });
    } catch {
      notify({ title: 'It may already have been sent', tone: 'warning' });
      load();
    }
  };

  return (
    <aside
      aria-label="Scheduled messages"
      className="flex h-full min-h-0 w-full flex-col border-l border-border-light bg-white dark:border-border-dark/30 dark:bg-chrome-dark"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-light px-3 dark:border-border-dark/30">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
          <Clock size={15} /> Scheduled
        </h2>
        <IconButton label="Close scheduled messages" onClick={onClose}><X size={18} /></IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {items === null ? (
          <div className="space-y-2 p-1" aria-busy="true">
            {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Clock size={22} />}
            title="Nothing waiting to send"
            hint="Use /schedule in the composer, or the clock beside the send button."
          />
        ) : (
          <ul className="space-y-1.5">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded-xl border border-border-light bg-surface-light p-2.5 dark:border-border-dark/40 dark:bg-elevated-dark/40"
              >
                <div className="mb-1 flex items-center gap-1.5">
                  <Hash size={11} className="shrink-0 opacity-60" />
                  <button
                    onClick={() => { setActiveId(item.conversationId); onClose(); }}
                    className="min-w-0 flex-1 truncate text-left text-[11px] font-medium text-text-secondary-light hover:underline dark:text-text-secondary-dark"
                  >
                    {item.conversationName}
                  </button>
                  <IconButton
                    label={`Cancel scheduled message to ${item.conversationName}`}
                    size="sm"
                    onClick={() => void cancel(item)}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </div>
                <p className="line-clamp-3 whitespace-pre-wrap text-xs text-text-primary-light dark:text-text-primary-dark">
                  {item.body}
                </p>
                <p className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400">
                  <Clock size={10} /> Sends {whenLabel(item.sendAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
};
