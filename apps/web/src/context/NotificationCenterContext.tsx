import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AppNotification } from '@tupo/shared';
import { apiGet, apiPost } from '../lib/api';
import { onSocket } from '../lib/socket';
import { useAuth } from './AuthContext';

/**
 * The notification centre's state (F-01): what is behind the bell, how many
 * are unread, and the actions on them.
 *
 * Live both ways: a new notification lands at the top as it arrives, and a
 * read on any device — the panel, opening the conversation it was about, a
 * phone — reaches every open tab through `notification:read`, so no bell is
 * ever left showing something already seen.
 */

export type NotificationFilter = 'all' | 'chat' | 'mail' | 'feed' | 'meet';

interface Page { notifications: AppNotification[]; unread: number; nextBefore: string | null }

interface NotificationCenterValue {
  items: AppNotification[];
  unread: number;
  loading: boolean;
  hasMore: boolean;
  filter: NotificationFilter;
  unreadOnly: boolean;
  setFilter: (f: NotificationFilter) => void;
  setUnreadOnly: (v: boolean) => void;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const Ctx = createContext<NotificationCenterValue | null>(null);

const moduleOf = (kind: string): NotificationFilter | 'other' => {
  const m = kind.split('.')[0];
  return m === 'chat' || m === 'mail' || m === 'feed' || m === 'meet' ? m : 'other';
};

export const NotificationCenterProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  // The request a response belongs to: a filter change mid-flight must not
  // let the older answer overwrite the newer one.
  const generation = useRef(0);

  const query = useCallback((before: string | null) => {
    const q = new URLSearchParams({ limit: '30' });
    if (filter !== 'all') q.set('module', filter);
    if (unreadOnly) q.set('unread', 'true');
    if (before) q.set('before', before);
    return apiGet<Page>(`/api/notifications?${q}`).then((r) => r.data!);
  }, [filter, unreadOnly]);

  const refresh = useCallback(async () => {
    if (!user) return;
    const gen = ++generation.current;
    setLoading(true);
    try {
      const page = await query(null);
      if (gen !== generation.current) return;
      setItems(page.notifications);
      setUnread(page.unread);
      setNextBefore(page.notifications.length === 30 ? page.nextBefore : null);
    } catch {
      /* the bell keeps what it had */
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [user, query]);

  useEffect(() => { void refresh(); }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!nextBefore || loading) return;
    const gen = generation.current;
    setLoading(true);
    try {
      const page = await query(nextBefore);
      if (gen !== generation.current) return;
      setItems((cur) => {
        const seen = new Set(cur.map((n) => n.id));
        return [...cur, ...page.notifications.filter((n) => !seen.has(n.id))];
      });
      setNextBefore(page.notifications.length === 30 ? page.nextBefore : null);
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [nextBefore, loading, query]);

  // Live: new ones on top (when they belong in the current view), reads from
  // any device applied everywhere.
  useEffect(() => {
    if (!user) return;
    const offNew = onSocket('notification:new', (n) => {
      setUnread((u) => u + 1);
      if (filter !== 'all' && moduleOf(n.kind) !== filter) return;
      setItems((cur) => (cur.some((x) => x.id === n.id) ? cur : [n, ...cur]));
    });
    const offRead = onSocket('notification:read', ({ ids, unread: total }) => {
      setUnread(total);
      const now = new Date().toISOString();
      setItems((cur) => {
        const next = cur.map((n) => (!n.readAt && (ids === 'all' || ids.includes(n.id)) ? { ...n, readAt: now } : n));
        return unreadOnly ? next.filter((n) => !n.readAt) : next;
      });
    });
    return () => { offNew(); offRead(); };
  }, [user, filter, unreadOnly]);

  const markRead = useCallback(async (id: string) => {
    const now = new Date().toISOString();
    let wasUnread = false;
    setItems((cur) => cur.map((n) => {
      if (n.id !== id || n.readAt) return n;
      wasUnread = true;
      return { ...n, readAt: now };
    }));
    if (wasUnread) setUnread((u) => Math.max(0, u - 1));
    try {
      const r = await apiPost<{ unread: number }>(`/api/notifications/${id}/read`);
      if (typeof r.data?.unread === 'number') setUnread(r.data.unread);
    } catch { /* the next refresh corrects it */ }
  }, []);

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString();
    setItems((cur) => (unreadOnly ? [] : cur.map((n) => (n.readAt ? n : { ...n, readAt: now }))));
    setUnread(0);
    try { await apiPost('/api/notifications/read-all'); } catch { void refresh(); }
  }, [unreadOnly, refresh]);

  const value = useMemo<NotificationCenterValue>(() => ({
    items, unread, loading, hasMore: nextBefore !== null, filter, unreadOnly,
    setFilter, setUnreadOnly, loadMore, refresh, markRead, markAllRead,
  }), [items, unread, loading, nextBefore, filter, unreadOnly, loadMore, refresh, markRead, markAllRead]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export function useNotificationCenter(): NotificationCenterValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useNotificationCenter must be used inside NotificationCenterProvider');
  return v;
}
