import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Star, Archive, Trash2, MailOpen, Mail as MailIcon, RefreshCw, Search, Paperclip,
  Clock, AlertTriangle, CheckCheck, Loader2,
} from 'lucide-react';
import { Avatar, IconButton, Spinner, EmptyState } from '../../components/ui';
import * as api from './api';
import type { MailFolder, MailThreadSummary, MailLabel } from '@tupo/shared';

interface Props {
  folder: MailFolder;
  labelId: string | null;
  labels: MailLabel[];
  selectedThreadId: string | null;
  refreshKey: number;
  onOpen: (t: MailThreadSummary) => void;
  onChanged: () => void;
}

const stamp = (iso: string) => {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (diff < 6 * 864e5) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

const DeliveryBadge: React.FC<{ status?: string; scheduledAt?: string | null; isDraft?: boolean }> = ({ status, scheduledAt, isDraft }) => {
  if (isDraft) return <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">Draft</span>;
  if (scheduledAt) return <span className="inline-flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"><Clock size={10} />{new Date(scheduledAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>;
  if (status === 'failed') return <span className="inline-flex items-center gap-1 text-[10px] font-medium text-red-600"><AlertTriangle size={10} />Failed</span>;
  if (status === 'delivered') return <CheckCheck size={13} className="text-emerald-500" />;
  if (status === 'sent') return <CheckCheck size={13} className="text-text-secondary-light" />;
  if (status === 'queued') return <Loader2 size={11} className="animate-spin text-text-secondary-light" />;
  return null;
};

export const MailList: React.FC<Props> = ({
  folder, labelId, labels, selectedThreadId, refreshKey, onOpen, onChanged,
}) => {
  const [threads, setThreads] = useState<MailThreadSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const senderView = ['sent', 'drafts', 'scheduled'].includes(folder);

  const load = useCallback(async (reset: boolean) => {
    reset ? setLoading(true) : setLoadingMore(true);
    try {
      const page = await api.listThreads({ folder, label: labelId ?? undefined, q: query || undefined, cursor: reset ? undefined : cursor ?? undefined });
      setThreads((prev) => (reset ? page.threads : [...prev, ...page.threads]));
      setCursor(page.nextCursor);
    } finally {
      setLoading(false); setLoadingMore(false);
    }
  }, [folder, labelId, query, cursor]);

  useEffect(() => { setSelected(new Set()); load(true); /* eslint-disable-next-line */ }, [folder, labelId, query, refreshKey]);

  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const act = async (fn: () => Promise<unknown>) => { await fn().catch(() => {}); load(true); onChanged(); };
  const bulk = async (fn: (id: string) => Promise<unknown>) => {
    await Promise.all([...selected].map((id) => fn(id).catch(() => {})));
    setSelected(new Set()); load(true); onChanged();
  };

  const labelById = (id: string) => labels.find((l) => l.id === id);
  const title = labelId ? labelById(labelId)?.name ?? 'Label'
    : folder.charAt(0).toUpperCase() + folder.slice(1);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border-light px-3 py-2 dark:border-border-dark/50">
        {selected.size > 0 ? (
          <>
            <span className="text-sm font-medium">{selected.size} selected</span>
            <div className="ml-auto flex items-center gap-1">
              <IconButton label="Archive" size="sm" onClick={() => bulk((id) => api.moveThread(id, 'archive'))}><Archive size={16} /></IconButton>
              <IconButton label="Delete" size="sm" onClick={() => bulk((id) => api.moveThread(id, folder === 'trash' ? 'trash' : 'trash'))}><Trash2 size={16} /></IconButton>
              <IconButton label="Mark read" size="sm" onClick={() => bulk((id) => api.markThread(id, true))}><MailOpen size={16} /></IconButton>
            </div>
          </>
        ) : (
          <>
            <h2 className="shrink-0 text-sm font-semibold">{title}</h2>
            <div className="relative ml-auto min-w-0">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary-light" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search mail"
                className="w-36 max-w-full rounded-full border border-border-light bg-transparent py-1.5 pl-8 pr-3 text-xs outline-none transition-[width] duration-150 focus:w-48 focus:border-blue-400 sm:w-44 sm:focus:w-56 dark:border-border-dark/60" />
            </div>
            <IconButton label="Refresh" size="sm" onClick={() => load(true)}><RefreshCw size={15} /></IconButton>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="grid h-40 place-items-center"><Spinner /></div>
        ) : threads.length === 0 ? (
          <EmptyState icon={<MailIcon />} title="Nothing here" hint={query ? 'No messages match your search.' : `Your ${title.toLowerCase()} is empty.`} />
        ) : (
          <ul>
            {threads.map((t) => {
              const isSel = selectedThreadId === t.threadId;
              const names = t.participants.map((p) => p.name.split(' ')[0]).slice(0, 3).join(', ') || 'Me';
              return (
                <li key={t.threadId}>
                  <div
                    onClick={() => onOpen(t)}
                    className={`flex cursor-pointer items-center gap-2 border-b border-border-light/70 px-3 py-2.5 dark:border-border-dark/30 ${
                      isSel ? 'bg-blue-50 dark:bg-blue-900/20' : t.unread ? 'bg-white dark:bg-transparent' : 'bg-surface-light/40 dark:bg-transparent'
                    } hover:bg-surface-light dark:hover:bg-surface-dark`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(t.threadId)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        setSelected((s) => { const n = new Set(s); e.target.checked ? n.add(t.threadId) : n.delete(t.threadId); return n; });
                      }}
                      className="shrink-0 accent-blue-600"
                    />
                    <button
                      aria-label={t.starred ? 'Unstar' : 'Star'}
                      onClick={(e) => { e.stopPropagation(); act(() => api.starThread(t.threadId, !t.starred)); }}
                      className="shrink-0"
                    >
                      <Star size={15} className={t.starred ? 'fill-amber-400 text-amber-400' : 'text-text-secondary-light'} />
                    </button>
                    <Avatar name={t.participants[0]?.name ?? 'Me'} src={t.participants[0]?.avatarUrl ?? undefined} size={30} className="hidden sm:inline-flex" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={`truncate text-sm ${t.unread ? 'font-semibold' : ''}`}>{names}</span>
                        {t.messageCount > 1 && <span className="text-xs text-text-secondary-light">{t.messageCount}</span>}
                        <span className="ml-auto shrink-0 text-xs text-text-secondary-light dark:text-text-secondary-dark">{stamp(t.lastMessageAt)}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className={`truncate text-sm ${t.unread ? 'font-medium' : 'text-text-secondary-light dark:text-text-secondary-dark'}`}>{t.subject}</span>
                        {senderView && <DeliveryBadge status={t.delivery} scheduledAt={t.scheduledAt} isDraft={t.isDraft} />}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">{t.snippet}</span>
                        {t.hasAttachments && <Paperclip size={11} className="shrink-0 text-text-secondary-light" />}
                      </div>
                      {t.labels.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {t.labels.map((id) => {
                            const l = labelById(id);
                            return l ? <span key={id} className="rounded px-1.5 text-[10px]" style={{ background: `${l.color}22`, color: l.color }}>{l.name}</span> : null;
                          })}
                        </div>
                      )}
                    </div>
                    <div className="hidden shrink-0 items-center gap-0.5 sm:flex" onClick={(e) => e.stopPropagation()}>
                      {folder !== 'archive' && !senderView && <IconButton label="Archive" size="sm" onClick={() => act(() => api.moveThread(t.threadId, 'archive'))}><Archive size={15} /></IconButton>}
                      {folder === 'trash'
                        ? <IconButton label="Delete forever" size="sm" onClick={() => act(() => api.purgeThread(t.threadId))}><Trash2 size={15} /></IconButton>
                        : <IconButton label="Delete" size="sm" onClick={() => act(() => api.moveThread(t.threadId, 'trash'))}><Trash2 size={15} /></IconButton>}
                      {!senderView && <IconButton label={t.unread ? 'Mark read' : 'Mark unread'} size="sm" onClick={() => act(() => api.markThread(t.threadId, t.unread))}>
                        {t.unread ? <MailOpen size={15} /> : <MailIcon size={15} />}
                      </IconButton>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {cursor && !loading && (
          <button onClick={() => load(false)} disabled={loadingMore} className="w-full py-3 text-center text-xs text-blue-600 hover:underline">
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
};
