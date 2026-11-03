import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Star, Archive, Trash2, MailOpen, Mail as MailIcon, RefreshCw, Search, Paperclip,
  Clock, AlertTriangle, CheckCheck, Loader2, RotateCcw, Inbox, ShieldCheck, MoreVertical,
} from 'lucide-react';
import { useNotify } from '../../context/NotificationContext';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { Avatar, IconButton, EmptyState, Skeleton } from '../../components/ui';
import * as api from './api';
import type { MailFolder, MailThreadSummary, MailLabel } from '@tupo/shared';
import { LoadError } from '../../components/LoadError';
import { cacheGet, cacheSet } from '../../lib/localStore';
import { isTypingTarget } from '../../lib/shortcuts';

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

/** An optimistic change to a row: new field values, or it leaves this view. */
type ThreadChange = 'leave' | Partial<Pick<MailThreadSummary, 'unread' | 'starred'>>;

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

  const [failed, setFailed] = useState(false);
  const { notify, confirm: confirmed } = useNotify();
  const [confirm, dialog] = useConfirmDialog();
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  /**
   * `soft`: live news (C-11) — the first page is fetched again and merged in
   * place, with no spinner, keeping the selection, the scroll position and
   * any pages already loaded. A new folder, label or search starts afresh.
   */
  /** The device copy of this folder's first page (P-02); searches are never cached. */
  const cacheKey = query ? null : `mail:list:${folder}:${labelId ?? ''}`;
  const gotNetwork = useRef(false);
  const shownFromCache = useRef(false);
  const load = useCallback(async (reset: boolean, soft = false) => {
    if (!soft) { reset ? setLoading(true) : setLoadingMore(true); }
    try {
      const page = await api.listThreads({ folder, label: labelId ?? undefined, q: query || undefined, cursor: reset ? undefined : cursor ?? undefined });
      if (reset) {
        gotNetwork.current = true;
        if (cacheKey) void cacheSet(cacheKey, page.threads);
      }
      setThreads((prev) => {
        if (!reset) return [...prev, ...page.threads];
        if (!soft) return page.threads;
        const fresh = new Set(page.threads.map((t) => t.threadId));
        const oldestFresh = page.threads[page.threads.length - 1]?.lastMessageAt ?? '';
        // Keep what was loaded beyond the first page; drop what left it.
        return [...page.threads, ...prev.filter((t) => !fresh.has(t.threadId) && t.lastMessageAt < oldestFresh)];
      });
      if (!soft || reset) setCursor((c) => (soft ? c ?? page.nextCursor : page.nextCursor));
      if (soft) setSelected((sel) => new Set([...sel].filter((id) => page.threads.some((t) => t.threadId === id) || threadsRef.current.some((t) => t.threadId === id))));
      setFailed(false);
    } catch {
      // A failed first page is an error, not an empty folder (F-06). A failed
      // "load more" keeps what is already on screen, and so does a failed
      // refresh of a folder shown from the device (offline: the banner says so).
      if (reset && !shownFromCache.current) setFailed(true);
    } finally {
      setLoading(false); setLoadingMore(false);
    }
  }, [folder, labelId, query, cursor, cacheKey]);

  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  useEffect(() => {
    setSelected(new Set());
    // Local first (P-03): the folder as last seen, at once; the fetch replaces it.
    gotNetwork.current = false;
    shownFromCache.current = false;
    let stale = false;
    if (cacheKey) {
      void cacheGet<MailThreadSummary[]>(cacheKey).then((cached) => {
        if (stale || gotNetwork.current || !cached?.length) return;
        shownFromCache.current = true;
        setThreads(cached);
        setLoading(false);
      });
    }
    load(true);
    return () => { stale = true; };
    /* eslint-disable-next-line */
  }, [folder, labelId, query]);
  const firstKey = useRef(true);
  useEffect(() => {
    if (firstKey.current) { firstKey.current = false; return; }
    void load(true, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  /*
   * Optimistic (P-04): the list changes the moment the button is pressed — a
   * row leaves the folder, the star fills, the bold goes — and the server is
   * told afterwards. A refusal says so and the quiet refresh that follows
   * every action puts the list back as the server has it.
   */
  const applyLocal = (ids: string[], change?: ThreadChange) => {
    if (!change) return;
    const set = new Set(ids);
    setThreads((prev) => (change === 'leave'
      ? prev.filter((t) => !set.has(t.threadId))
      : prev.map((t) => (set.has(t.threadId) ? { ...t, ...change } : t))));
  };
  const act = async (fn: () => Promise<unknown>, done?: string, change?: { ids: string[]; change?: ThreadChange }) => {
    if (change) applyLocal(change.ids, change.change);
    try { await fn(); if (done) confirmed(done); }
    catch (e) { notify({ title: 'That did not work', body: e instanceof Error ? e.message : undefined, tone: 'error' }); }
    void load(true, true); onChanged();
  };
  const bulk = async (fn: (id: string) => Promise<unknown>, done?: string, change?: ThreadChange) => {
    const ids = [...selected];
    applyLocal(ids, change);
    setSelected(new Set());
    const results = await Promise.allSettled(ids.map((id) => fn(id)));
    const failedCount = results.filter((r) => r.status === 'rejected').length;
    if (failedCount) notify({ title: `${failedCount} of ${results.length} could not be changed`, tone: 'error' });
    else if (done) confirmed(done);
    void load(true, true); onChanged();
  };
  /** A move takes the row out of this view — except Starred and label views, which span folders. */
  const leaves: ThreadChange | undefined = folder === 'starred' || labelId ? undefined : 'leave';

  /*
   * What can be done with a conversation depends on where it is (C-08 /
   * C-12): Trash offers Restore and Delete forever, Spam offers Not spam,
   * Archive offers Move to Inbox. The same list drives the row buttons, the
   * phone row menu and the bulk bar.
   */
  type RowAction = {
    key: string; label: string; icon: React.ReactNode; run: (id: string) => Promise<unknown>; done: string;
    /** What the row looks like straight away (P-04). */
    change?: ThreadChange;
  };
  const actionsFor = (t: MailThreadSummary | null): RowAction[] => {
    const read = t ? t.unread : true;
    const list: RowAction[] = [];
    if (folder === 'trash') {
      list.push({ key: 'restore', label: 'Restore', icon: <RotateCcw size={15} />, run: api.restoreThread, done: 'Restored', change: leaves });
      list.push({ key: 'purge', label: 'Delete forever', icon: <Trash2 size={15} />, run: api.purgeThread, done: 'Deleted forever', change: 'leave' });
      return list;
    }
    if (folder === 'spam') {
      list.push({ key: 'notspam', label: 'Not spam', icon: <ShieldCheck size={15} />, run: api.restoreThread, done: 'Moved to the Inbox', change: leaves });
      list.push({ key: 'trash', label: 'Delete', icon: <Trash2 size={15} />, run: (id) => api.moveThread(id, 'trash'), done: 'Moved to Trash', change: leaves });
      return list;
    }
    if (folder === 'archive') list.push({ key: 'inbox', label: 'Move to Inbox', icon: <Inbox size={15} />, run: (id) => api.moveThread(id, 'inbox'), done: 'Moved to the Inbox', change: leaves });
    else if (!senderView) list.push({ key: 'archive', label: 'Archive', icon: <Archive size={15} />, run: (id) => api.moveThread(id, 'archive'), done: 'Archived', change: leaves });
    if (folder !== 'drafts' && folder !== 'scheduled') {
      list.push({ key: 'trash', label: 'Delete', icon: <Trash2 size={15} />, run: (id) => api.moveThread(id, 'trash'), done: 'Moved to Trash', change: leaves });
    }
    if (!senderView) {
      list.push(read
        ? { key: 'read', label: 'Mark read', icon: <MailOpen size={15} />, run: (id) => api.markThread(id, true), done: 'Marked read', change: { unread: false } }
        : { key: 'unread', label: 'Mark unread', icon: <MailIcon size={15} />, run: (id) => api.markThread(id, false), done: 'Marked unread', change: { unread: true } });
    }
    return list;
  };
  const bulkActions: RowAction[] = [
    ...actionsFor(null),
    ...(!senderView && folder !== 'trash' && folder !== 'spam'
      ? [{ key: 'unread', label: 'Mark unread', icon: <MailIcon size={15} />, run: (id: string) => api.markThread(id, false), done: 'Marked unread', change: { unread: true } as ThreadChange },
         { key: 'star', label: 'Star', icon: <Star size={15} />, run: (id: string) => api.starThread(id, true), done: 'Starred', change: { starred: true } as ThreadChange }]
      : []),
  ].filter((a, i, all) => all.findIndex((b) => b.key === a.key) === i);

  const emptyTrash = async () => {
    const ok = await confirm({
      title: 'Empty Trash?', body: <p>Every conversation in Trash is deleted for good. This cannot be undone.</p>,
      confirmLabel: 'Empty Trash', tone: 'danger',
    });
    if (ok) await act(() => api.emptyTrash(), 'Trash emptied');
  };

  /*
   * Keyboard (U-10), Gmail's keys: j / k next and previous conversation,
   * e archive, # delete, s star, u mark unread, / search. Never while typing.
   */
  const searchRef = useRef<HTMLInputElement>(null);
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keysRef.current = (e: KeyboardEvent) => {
    if (isTypingTarget(e)) return;
    const i = threads.findIndex((t) => t.threadId === selectedThreadId);
    const current = i >= 0 ? threads[i]! : null;
    const run = (key: string) => {
      const a = current && actionsFor(current).find((x) => x.key === key);
      if (a && current) void act(() => a.run(current.threadId), a.done, { ids: [current.threadId], change: a.change });
      return Boolean(a);
    };
    switch (e.key) {
      case 'j': { const n = threads[Math.min(threads.length - 1, i + 1)]; if (n) onOpen(n); break; }
      case 'k': { const n = threads[Math.max(0, i - 1)]; if (n) onOpen(n); break; }
      case 'e': if (!run('archive')) return; break;
      case '#': if (!run('trash')) return; break;
      case 'u': if (!run('unread')) return; break;
      case 's':
        if (!current) return;
        void act(() => api.starThread(current.threadId, !current.starred), undefined, { ids: [current.threadId], change: { starred: !current.starred } });
        break;
      case '/': searchRef.current?.focus(); break;
      default: return;
    }
    e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keysRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
              {bulkActions.map((a) => (
                <IconButton key={a.key} label={a.label} size="sm" onClick={() => void bulk(a.run, a.done, a.change)}>{a.icon}</IconButton>
              ))}
              <button onClick={() => setSelected(new Set())} className="ml-1 text-xs text-blue-600 hover:underline dark:text-blue-400">Clear</button>
            </div>
          </>
        ) : (
          <>
            <h2 className="shrink-0 text-sm font-semibold">{title}</h2>
            {folder === 'trash' && threads.length > 0 && (
              <button onClick={() => void emptyTrash()} className="shrink-0 text-xs font-medium text-red-600 hover:underline dark:text-red-400">Empty Trash</button>
            )}
            <div className="relative ml-auto min-w-0">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary-light" />
              <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search mail"
                className="w-36 max-w-full rounded-full border border-border-light bg-transparent py-1.5 pl-8 pr-3 text-xs outline-none transition-[width] duration-150 focus:w-48 focus:border-blue-400 sm:w-44 sm:focus:w-56 dark:border-border-dark/60" />
            </div>
            <IconButton label="Refresh" size="sm" onClick={() => load(true)}><RefreshCw size={15} /></IconButton>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          // Rows shaped like the real ones (P-07), so nothing jumps when they arrive.
          <div aria-busy="true" aria-label="Loading messages">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="flex items-start gap-3 border-b border-border-light/60 px-3 py-3 dark:border-border-dark/30">
                <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                  <div className="flex justify-between gap-3"><Skeleton className="h-3 w-1/3" /><Skeleton className="h-3 w-10" /></div>
                  <Skeleton className="h-3 w-2/3" />
                  <Skeleton className="h-3 w-5/6" />
                </div>
              </div>
            ))}
          </div>
        ) : failed ? (
          <LoadError compact what="this folder" onRetry={() => load(true)} />
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
                      onClick={(e) => { e.stopPropagation(); act(() => api.starThread(t.threadId, !t.starred), undefined, { ids: [t.threadId], change: { starred: !t.starred } }); }}
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
                      {actionsFor(t).map((a) => (
                        <IconButton key={a.key} label={a.label} size="sm" onClick={() => void act(() => a.run(t.threadId), a.done, { ids: [t.threadId], change: a.change })}>{a.icon}</IconButton>
                      ))}
                    </div>
                    {/* Phones have no hover (C-12): the folder's main action is one
                        tap, the rest sit behind ⋯. */}
                    {actionsFor(t)[0] && (
                      <span className="shrink-0 sm:hidden" onClick={(e) => e.stopPropagation()}>
                        <IconButton label={actionsFor(t)[0]!.label} size="sm"
                          onClick={() => void act(() => actionsFor(t)[0]!.run(t.threadId), actionsFor(t)[0]!.done, { ids: [t.threadId], change: actionsFor(t)[0]!.change })}>
                          {actionsFor(t)[0]!.icon}
                        </IconButton>
                      </span>
                    )}
                    <div className="relative shrink-0 sm:hidden" onClick={(e) => e.stopPropagation()}>
                      <IconButton label={`Actions for ${t.subject}`} size="sm" aria-haspopup="menu" aria-expanded={rowMenu === t.threadId}
                        onClick={() => setRowMenu((m) => (m === t.threadId ? null : t.threadId))}>
                        <MoreVertical size={15} />
                      </IconButton>
                      {rowMenu === t.threadId && (
                        <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-xl border border-border-light bg-white py-1 shadow-xl dark:border-border-dark/50 dark:bg-elevated-dark">
                          {actionsFor(t).slice(1).map((a) => (
                            <button key={a.key} role="menuitem" onClick={() => { setRowMenu(null); void act(() => a.run(t.threadId), a.done, { ids: [t.threadId], change: a.change }); }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-light dark:hover:bg-surface-dark">
                              {a.icon} {a.label}
                            </button>
                          ))}
                        </div>
                      )}
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
      {dialog}
    </div>
  );
};
