import React, { useEffect, useState } from 'react';
import { X, Hash, Megaphone, Search, Users, Check } from 'lucide-react';
import { IconButton, Skeleton, EmptyState, Spinner } from '../../components/ui';
import { useNotify } from '../../context/NotificationContext';
import { usePermissions } from '../../hooks/usePermissions';
import { useChat } from './ChatProvider';
import * as chatApi from './api';
import { shortStamp } from './data';

/**
 * The channel directory (FR-CHN-6).
 *
 * Only public, unarchived channels appear. A private channel is **absent**,
 * not listed and greyed out: in a school the name is frequently the sensitive
 * part — a channel named after a pupil under review does not need its contents
 * read to do damage — so a directory that says "you cannot join #safeguarding-
 * <name>" has already leaked the thing worth protecting.
 */

export const BrowseChannels: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { can } = usePermissions();
  const { notify } = useNotify();
  const { setActiveId, refresh } = useChat();

  const [query, setQuery] = useState('');
  const [channels, setChannels] = useState<chatApi.DiscoverableChannel[] | null>(null);
  const [joining, setJoining] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      chatApi.browseChannels(query.trim() || undefined)
        .then((rows) => { if (!cancelled) setChannels(rows); })
        .catch(() => { if (!cancelled) setChannels([]); });
    }, query ? 250 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const join = async (channel: chatApi.DiscoverableChannel) => {
    setJoining(channel.id);
    try {
      const conversation = await chatApi.joinChannel(channel.id);
      await refresh();
      setActiveId(conversation.id);
      onClose();
    } catch (err) {
      notify({
        title: 'Could not join that channel',
        body: err instanceof Error ? err.message : undefined,
        tone: 'error',
      });
    } finally {
      setJoining(null);
    }
  };

  return (
    <aside
      aria-label="Browse channels"
      className="flex h-full min-h-0 w-full flex-col border-l border-border-light bg-white dark:border-border-dark/30 dark:bg-chrome-dark"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-light px-3 dark:border-border-dark/30">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
          <Hash size={15} /> Browse channels
        </h2>
        <IconButton label="Close channel directory" onClick={onClose}><X size={18} /></IconButton>
      </header>

      <div className="shrink-0 border-b border-border-light p-3 dark:border-border-dark/30">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary-light dark:text-text-secondary-dark" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search channels"
            aria-label="Search channels"
            className="w-full rounded-lg border border-border-light bg-surface-light py-2 pl-9 pr-3 text-sm text-text-primary-light outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark/50 dark:bg-elevated-dark/60 dark:text-text-primary-dark"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {channels === null ? (
          <div className="space-y-2 p-1" aria-busy="true">
            {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
          </div>
        ) : channels.length === 0 ? (
          <EmptyState
            icon={<Hash size={22} />}
            title={query ? `No channel matches “${query}”` : 'No public channels yet'}
            hint={query ? 'Private channels are not listed.' : 'Create one with the + button.'}
          />
        ) : (
          <ul className="space-y-1">
            {channels.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-2.5 rounded-xl border border-border-light bg-surface-light p-2.5 dark:border-border-dark/40 dark:bg-elevated-dark/40"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500 dark:bg-card-dark/60 dark:text-slate-300">
                  {c.type === 'announcement' ? <Megaphone size={15} /> : <Hash size={15} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
                    {c.name}
                  </span>
                  <span className="flex items-center gap-2 text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
                    <span className="flex items-center gap-0.5">
                      <Users size={9} /> {c.memberCount}
                    </span>
                    {c.lastMessageAt && <span>· active {shortStamp(c.lastMessageAt)}</span>}
                    {c.topic && <span className="truncate">· {c.topic}</span>}
                  </span>
                </span>

                {c.isMember ? (
                  <button
                    onClick={() => { setActiveId(c.id); onClose(); }}
                    className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/25"
                  >
                    <Check size={12} /> Open
                  </button>
                ) : can('CHANNEL_JOIN') ? (
                  <button
                    onClick={() => void join(c)}
                    disabled={joining === c.id}
                    className="shrink-0 rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {joining === c.id ? <Spinner className="h-3 w-3" /> : 'Join'}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
};
