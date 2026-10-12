import React, { useEffect, useState } from 'react';
import { Pin, X, ChevronDown } from 'lucide-react';
import { IconButton, Avatar } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { useChat } from './ChatProvider';
import * as chatApi from './api';
import { timeOf } from './data';
import type { Conversation, Message } from './types';

/**
 * Pinned messages (FR-MSG-11).
 *
 * Collapsed to a single line by default, showing the most recent pin. A pinned
 * message is a standing reference — the exam timetable, the lab safety rules —
 * and the point is that it is *always* visible, not that it takes up a third of
 * the screen. Expanding shows the rest.
 *
 * The bar disappears entirely when nothing is pinned rather than sitting there
 * empty: a permanent strip of chrome that is usually blank is worse than no
 * strip at all on a phone.
 */

export const PinnedBar: React.FC<{ conversation: Conversation }> = ({ conversation }) => {
  const { can } = usePermissions();
  const { jumpTo, pin, messages } = useChat();
  const [pinned, setPinned] = useState<Message[]>([]);
  const [expanded, setExpanded] = useState(false);

  /*
   * Refetched when the *set* of pinned messages in the loaded window changes,
   * not on every message. Pinning emits `message:updated`, which lands in
   * `messages`, so this key changes exactly when a pin is added or removed by
   * anyone — no polling, and no refetch on every arriving line.
   */
  const pinSignature = messages.filter((m) => m.pinnedAt).map((m) => m.id).join(',');

  useEffect(() => {
    let cancelled = false;
    chatApi.listPinned(conversation.id)
      .then((rows) => { if (!cancelled) setPinned(rows); })
      .catch(() => { if (!cancelled) setPinned([]); });
    return () => { cancelled = true; };
  }, [conversation.id, pinSignature]);

  if (pinned.length === 0) return null;

  const shown = expanded ? pinned : pinned.slice(0, 1);

  return (
    <div className="shrink-0 border-b border-amber-200/70 bg-amber-50/80 dark:border-amber-500/20 dark:bg-amber-500/10">
      <ul>
        {shown.map((m) => (
          <li key={m.id} className="flex items-center gap-2 px-3 py-1.5">
            <Pin size={12} className="shrink-0 text-amber-600 dark:text-amber-400" />
            <button
              onClick={() => void jumpTo(m.id)}
              className="min-w-0 flex-1 truncate text-left text-xs text-text-primary-light hover:underline dark:text-text-primary-dark"
            >
              <Avatar name={m.senderName ?? '?'} src={m.senderAvatarUrl ?? undefined} size={16} className="mr-1.5 inline-flex align-middle" />
              <span className="font-medium">{m.senderName}</span>
              <span className="mx-1 opacity-50">·</span>
              <span className="opacity-80">{m.body ?? 'Attachment'}</span>
              <span className="ml-1.5 text-[10px] opacity-60">{timeOf(m.createdAt)}</span>
            </button>

            {can('MESSAGE_PIN') && (
              <IconButton label={`Unpin message from ${m.senderName}`} size="sm" onClick={() => void pin(m.id, false)}>
                <X size={13} />
              </IconButton>
            )}
          </li>
        ))}
      </ul>

      {pinned.length > 1 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex w-full items-center justify-center gap-1 pb-1 text-[11px] font-medium text-amber-700 hover:underline dark:text-amber-400"
        >
          <ChevronDown size={11} className={`transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`} />
          {expanded ? 'Show less' : `${pinned.length - 1} more pinned`}
        </button>
      )}
    </div>
  );
};
