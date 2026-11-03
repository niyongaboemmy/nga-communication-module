import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AtSign, Bell, BellOff, Check, CheckCheck, Flag, Heart, Mail, Megaphone, MessageSquare,
  MessagesSquare, Newspaper, ShieldAlert, Video, X,
} from 'lucide-react';
import type { AppNotification } from '@tupo/shared';
import { IconButton, Spinner } from '../ui';
import { useNotificationCenter, type NotificationFilter } from '../../context/NotificationCenterContext';

/**
 * The bell and its panel (F-01).
 *
 * One place for everything that wanted the person's attention, from every
 * module: grouped by day, filterable by module, newest first, each one a link
 * to exactly where it happened. Reading something anywhere — here, or by
 * opening the conversation it was about — clears it here too.
 */

const FILTERS: Array<{ id: NotificationFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'chat', label: 'Chat' },
  { id: 'mail', label: 'Mail' },
  { id: 'feed', label: 'Feed' },
  { id: 'meet', label: 'Meet' },
];

const ICONS: Record<string, { icon: typeof Bell; tone: string }> = {
  'chat.dm': { icon: MessageSquare, tone: 'bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300' },
  'chat.mention': { icon: AtSign, tone: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' },
  'chat.message': { icon: MessagesSquare, tone: 'bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300' },
  'chat.thread': { icon: MessagesSquare, tone: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300' },
  'chat.reaction': { icon: Heart, tone: 'bg-pink-100 text-pink-600 dark:bg-pink-500/15 dark:text-pink-300' },
  'chat.invited': { icon: MessagesSquare, tone: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' },
  'mail.received': { icon: Mail, tone: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300' },
  'mail.snoozed': { icon: Mail, tone: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' },
  'mail.campaign': { icon: Mail, tone: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300' },
  'feed.announcement': { icon: Megaphone, tone: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300' },
  'feed.published': { icon: Newspaper, tone: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300' },
  'feed.moderation': { icon: ShieldAlert, tone: 'bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-300' },
  'meet.live': { icon: Video, tone: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' },
  'meet.invited': { icon: Video, tone: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' },
  'moderation.report': { icon: Flag, tone: 'bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300' },
};
const iconFor = (kind: string) =>
  ICONS[kind] ?? (kind.startsWith('feed.')
    ? { icon: Newspaper, tone: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300' }
    : { icon: Bell, tone: 'bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300' });

function dayGroup(iso: string): string {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.floor((today.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'This week';
  return 'Earlier';
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d}d` : new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const Row: React.FC<{ n: AppNotification; onOpen: (n: AppNotification) => void; onRead: (id: string) => void }> = ({ n, onOpen, onRead }) => {
  const { icon: Icon, tone } = iconFor(n.kind);
  const unread = !n.readAt;
  return (
    <li className="group relative">
      <button
        onClick={() => onOpen(n)}
        className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-surface-light dark:hover:bg-surface-dark ${
          unread ? 'bg-blue-50/60 dark:bg-blue-500/5' : ''
        }`}
      >
        <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${tone}`}>
          <Icon size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm ${unread ? 'font-semibold text-text-primary-light dark:text-text-primary-dark' : 'text-text-primary-light/90 dark:text-text-primary-dark/90'}`}>
            {n.title}
          </span>
          {n.body && (
            <span className="line-clamp-2 block text-xs text-text-secondary-light dark:text-text-secondary-dark">{n.body}</span>
          )}
          <span className="mt-0.5 block text-[11px] text-text-secondary-light/80 dark:text-text-secondary-dark/80">{ago(n.createdAt)}</span>
        </span>
        {unread && <span aria-label="Unread" className="mt-2 h-2 w-2 shrink-0 rounded-full bg-blue-600" />}
      </button>
      {unread && (
        <button
          onClick={() => onRead(n.id)}
          aria-label="Mark as read"
          title="Mark as read"
          className="absolute right-6 top-2 hidden rounded-full bg-white p-1 text-text-secondary-light shadow-sm hover:text-blue-600 group-hover:block focus:block dark:bg-elevated-dark dark:text-text-secondary-dark"
        >
          <Check size={13} />
        </button>
      )}
    </li>
  );
};

export const NotificationBell: React.FC = () => {
  const center = useNotificationCenter();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  // Fresh when opened: cheap, and it covers anything missed while offline.
  useEffect(() => { if (open) void center.refresh(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Tell the bridge: while the panel is open, arrivals show here, not as toasts.
  useEffect(() => { center.setPanelOpen(open); return () => center.setPanelOpen(false); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node) && !bellRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('mousedown', onDown); };
  }, [open]);

  // Infinite list: the next page loads as the end comes into view.
  useEffect(() => {
    if (!open || !sentinel.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && center.hasMore) void center.loadMore();
    }, { root: sentinel.current.closest('[data-notification-scroller]'), rootMargin: '120px' });
    io.observe(sentinel.current);
    return () => io.disconnect();
  }, [open, center.hasMore, center.loadMore]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const out: Array<{ label: string; items: AppNotification[] }> = [];
    for (const n of center.items) {
      const label = dayGroup(n.createdAt);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(n); else out.push({ label, items: [n] });
    }
    return out;
  }, [center.items]);

  const openOne = (n: AppNotification) => {
    if (!n.readAt) void center.markRead(n.id);
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  const badge = center.unread > 99 ? '99+' : String(center.unread);

  return (
    <div ref={bellRef} className="relative">
      <IconButton
        label={center.unread ? `Notifications, ${center.unread} unread` : 'Notifications'}
        className="relative"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Bell size={18} />
        {center.unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white dark:ring-chrome-dark">
            {badge}
          </span>
        )}
      </IconButton>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          className="animate-fade-in fixed inset-x-2 top-14 z-80 flex max-h-[calc(100dvh-4.5rem)] flex-col overflow-hidden rounded-2xl border border-border-light bg-white shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[26rem] sm:max-h-[min(36rem,calc(100dvh-5rem))] dark:border-border-dark/50 dark:bg-elevated-dark"
        >
          <header className="flex shrink-0 items-center justify-between gap-2 px-4 pb-2 pt-3">
            <h2 className="text-base font-bold text-text-primary-light dark:text-text-primary-dark">Notifications</h2>
            <div className="flex items-center gap-1">
              <div role="group" aria-label="Which" className="mr-1 inline-flex rounded-full bg-surface-light p-0.5 text-xs dark:bg-card-dark/60">
                {([false, true] as const).map((u) => (
                  <button
                    key={String(u)}
                    aria-pressed={center.unreadOnly === u}
                    onClick={() => center.setUnreadOnly(u)}
                    className={`rounded-full px-2.5 py-0.5 font-medium ${center.unreadOnly === u
                      ? 'bg-white text-text-primary-light shadow-sm dark:bg-elevated-dark dark:text-text-primary-dark'
                      : 'text-text-secondary-light dark:text-text-secondary-dark'}`}
                  >
                    {u ? 'Unread' : 'All'}
                  </button>
                ))}
              </div>
              {center.unread > 0 && (
                <button
                  onClick={() => void center.markAllRead()}
                  className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-500/10"
                >
                  <CheckCheck size={13} /> <span className="hidden sm:inline">Mark all read</span><span className="sm:hidden">Read all</span>
                </button>
              )}
              <IconButton label="Close notifications" size="sm" onClick={() => setOpen(false)}><X size={15} /></IconButton>
            </div>
          </header>

          <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto px-4 pb-2" role="tablist" aria-label="Show">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                role="tab"
                aria-selected={center.filter === f.id}
                onClick={() => center.setFilter(f.id)}
                className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  center.filter === f.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-surface-light text-text-secondary-light hover:bg-slate-200 dark:bg-card-dark/60 dark:text-text-secondary-dark dark:hover:bg-card-dark'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div data-notification-scroller className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {center.items.length === 0 ? (
              center.loading ? (
                <div className="grid place-items-center py-12"><Spinner /></div>
              ) : (
                <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                  <span className="grid h-12 w-12 place-items-center rounded-full bg-surface-light dark:bg-card-dark/60">
                    <BellOff size={20} className="text-text-secondary-light dark:text-text-secondary-dark" />
                  </span>
                  <p className="text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
                    {center.unreadOnly ? 'You’re all caught up' : 'Nothing here yet'}
                  </p>
                  <p className="text-xs text-text-secondary-light dark:text-text-secondary-dark">
                    Mentions, messages, mail, posts and meetings that need you will show up here.
                  </p>
                </div>
              )
            ) : (
              <>
                {groups.map((g) => (
                  <section key={g.label} aria-label={g.label}>
                    <h3 className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
                      {g.label}
                    </h3>
                    <ul className="space-y-0.5">
                      {g.items.map((n) => <Row key={n.id} n={n} onOpen={openOne} onRead={(id) => void center.markRead(id)} />)}
                    </ul>
                  </section>
                ))}
                <div ref={sentinel} className="h-1" />
                {center.loading && <div className="grid place-items-center py-3"><Spinner className="h-4 w-4" /></div>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
