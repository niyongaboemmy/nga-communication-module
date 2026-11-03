import React, { useEffect, useState } from 'react';
import { Check, CheckCheck, Clock, X } from 'lucide-react';
import { Avatar, IconButton, Skeleton } from '../../components/ui';
import * as chatApi from './api';
import type { MessageInfoEntry } from './api';

const when = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
  : '');

const STATE: Record<MessageInfoEntry['state'], { label: string; icon: React.ReactNode }> = {
  read: { label: 'Read', icon: <CheckCheck size={14} className="text-blue-500" /> },
  delivered: { label: 'Delivered', icon: <CheckCheck size={14} className="text-text-secondary-light" /> },
  sent: { label: 'Not delivered yet', icon: <Check size={14} className="text-text-secondary-light" /> },
};

/**
 * "Message info" (U-04), as in WhatsApp: who has read your message, who has
 * it on a device, and who has not yet, with times.
 */
export const MessageInfoDialog: React.FC<{ conversationId: string; messageId: string; onClose: () => void }> = ({ conversationId, messageId, onClose }) => {
  const [members, setMembers] = useState<MessageInfoEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    chatApi.messageInfo(conversationId, messageId).then(setMembers).catch((e) => setError(e instanceof Error ? e.message : 'Could not load.'));
  }, [conversationId, messageId]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const counts = members && { read: members.filter((m) => m.state === 'read').length, total: members.length };
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="message-info-title" onClick={onClose}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[80vh] w-full max-w-sm flex-col rounded-2xl bg-white shadow-xl dark:bg-elevated-dark">
        <div className="flex items-center gap-2 border-b border-border-light px-4 py-3 dark:border-border-dark/50">
          <h2 id="message-info-title" className="flex-1 text-sm font-semibold">Message info</h2>
          {counts && <span className="text-xs text-text-secondary-light dark:text-text-secondary-dark">Read by {counts.read} of {counts.total}</span>}
          <IconButton label="Close" size="sm" onClick={onClose}><X size={16} /></IconButton>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {error ? <li className="p-3 text-sm text-text-secondary-light">{error}</li>
            : !members ? Array.from({ length: 3 }, (_, i) => <li key={i} className="p-2"><Skeleton className="h-8 w-full" /></li>)
              : members.length === 0 ? <li className="p-3 text-sm text-text-secondary-light">Nobody else is in this conversation.</li>
                : members.map((m) => (
                  <li key={m.userId} data-info-member={m.userId} className="flex items-center gap-3 rounded-lg px-2 py-2">
                    <Avatar name={m.name} src={m.avatarUrl ?? undefined} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{m.name}</p>
                      <p className="flex items-center gap-1 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                        {STATE[m.state].icon} {STATE[m.state].label}{m.at ? ` · ${when(m.at)}` : ''}
                      </p>
                    </div>
                    {m.state === 'sent' && <Clock size={14} className="text-text-secondary-light" aria-hidden="true" />}
                  </li>
                ))}
        </ul>
      </div>
    </div>
  );
};
