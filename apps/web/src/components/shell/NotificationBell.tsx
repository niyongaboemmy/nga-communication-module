import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, Loader2 } from 'lucide-react';
import type { AppNotification } from '@tupo/shared';
import { IconButton } from '../ui';
import { apiGet, apiPost } from '../../lib/api';
import { onSocket } from '../../lib/socket';
import { relativeTime } from '../../pages/feed/lib';

/**
 * The header bell: unread count, and a dropdown of recent notifications.
 *
 * New ones arrive over the socket (`notification:new`). Live delivery needs the
 * realtime gateway's Redis link, so the count is also re-read when the tab
 * regains focus and once a minute -- a missed live event only ever costs
 * freshness, never a wrong count.
 */
const REFRESH_MS = 60_000;

export const NotificationBell: React.FC = () => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    apiGet<{ notifications: AppNotification[]; unread: number }>('/api/notifications?limit=20')
      .then((r) => { setItems(r.data!.notifications); setUnread(r.data!.unread); setError(false); })
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    load();
    const t = window.setInterval(load, REFRESH_MS);
    const onFocus = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onFocus);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', onFocus); };
  }, [load]);

  useEffect(() => onSocket('notification:new', (n: AppNotification) => {
    setItems((prev) => (prev?.some((x) => x.id === n.id) ? prev : [n, ...(prev ?? [])].slice(0, 20)));
    if (!n.readAt) setUnread((u) => u + 1);
  }), []);

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const openItem = (n: AppNotification) => {
    if (!n.readAt) {
      setItems((prev) => prev?.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) ?? prev);
      setUnread((u) => Math.max(0, u - 1));
      void apiPost(`/api/notifications/${n.id}/read`).catch(() => load());
    }
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  const markAll = () => {
    setItems((prev) => prev?.map((x) => (x.readAt ? x : { ...x, readAt: new Date().toISOString() })) ?? prev);
    setUnread(0);
    void apiPost('/api/notifications/read-all').catch(() => load());
  };

  return (
    <div ref={ref} className="relative">
      <IconButton
        label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        className="relative"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => { setOpen((v) => !v); if (!open) load(); }}
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white dark:ring-chrome-dark">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </IconButton>

      {open && (
        <div
          role="menu"
          aria-label="Notifications"
          className="animate-pop absolute right-0 z-60 mt-2 flex max-h-[min(32rem,80vh)] w-[22rem] max-w-[calc(100vw-1.5rem)] origin-top-right flex-col overflow-hidden rounded-2xl border border-border-light bg-white shadow-xl dark:border-border-dark/50 dark:bg-elevated-dark"
        >
          <div className="flex items-center justify-between border-b border-border-light px-4 py-3 dark:border-border-dark/40">
            <h2 className="text-base font-semibold text-text-primary-light dark:text-text-primary-dark">Notifications</h2>
            {unread > 0 && (
              <button onClick={markAll} className="flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400">
                <CheckCheck size={14} /> Mark all as read
              </button>
            )}
          </div>

          <ul className="flex-1 overflow-y-auto p-1.5">
            {items === null && !error && <li className="grid place-items-center py-8"><Loader2 className="animate-spin text-text-secondary-light" /></li>}
            {error && items === null && (
              <li className="px-3 py-8 text-center text-sm text-text-secondary-light dark:text-text-secondary-dark">
                Couldn't load notifications. <button onClick={load} className="font-medium text-blue-600 hover:underline dark:text-blue-400">Try again</button>
              </li>
            )}
            {items?.length === 0 && (
              <li className="px-3 py-10 text-center text-sm text-text-secondary-light dark:text-text-secondary-dark">
                <Bell size={22} className="mx-auto mb-2 opacity-50" />
                You're all caught up.
              </li>
            )}
            {items?.map((n) => (
              <li key={n.id}>
                <button
                  role="menuitem"
                  onClick={() => openItem(n)}
                  className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-surface-light dark:hover:bg-card-dark/60 ${n.readAt ? '' : 'bg-blue-50/60 dark:bg-blue-500/10'}`}
                >
                  <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300">
                    <Bell size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm leading-snug ${n.readAt ? 'text-text-primary-light dark:text-text-primary-dark' : 'font-semibold text-text-primary-light dark:text-text-primary-dark'}`}>{n.title}</span>
                    {n.body && <span className="mt-0.5 line-clamp-2 block text-[13px] text-text-secondary-light dark:text-text-secondary-dark">{n.body}</span>}
                    <span className={`mt-1 block text-xs ${n.readAt ? 'text-text-secondary-light dark:text-text-secondary-dark' : 'font-semibold text-blue-600 dark:text-blue-400'}`}>{relativeTime(n.createdAt)}</span>
                  </span>
                  {!n.readAt && <span className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-blue-600" aria-label="Unread" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
