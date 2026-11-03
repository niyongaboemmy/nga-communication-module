import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useChat } from '../pages/chat/ChatProvider';
import { onSocket } from '../lib/socket';
import { apiGet } from '../lib/api';
import { useNotificationCenter } from '../context/NotificationCenterContext';

/**
 * Unread counts for every module, in one place.
 *
 * Before this the rail and the tab bar accepted a `badge` that nothing ever
 * passed, the tab title fetched its own number, and the floating chat
 * launcher summed its own — three surfaces, three different answers. Every
 * badge in the shell now reads from here:
 *
 *   chat — unread in conversations the person has not muted, plus new
 *          replies in threads they follow (thread replies never move a
 *          conversation's own count, so they are added here instead);
 *   mail — unread inbox conversations;
 *   feed, meet — unread notifications for that module (new posts from pages
 *          you follow, announcements, meetings starting), since neither has
 *          an unread model of its own.
 *
 * The same total drives the browser tab title and, where supported, the
 * installed app's icon badge.
 */

/** Fired by the mail screens whenever they change read state or move mail. */
export const MAIL_CHANGED_EVENT = 'tupo:mail-changed';

export function useModuleBadges(): Record<string, number> {
  const { user } = useAuth();
  const { totalUnread, threadsUnreadTotal } = useChat();
  // Feed and Meet have no unread model of their own: their badge is what the
  // bell holds for them — new posts from pages you follow, meetings starting.
  const { unreadByModule } = useNotificationCenter();
  const [mailUnread, setMailUnread] = useState(0);

  const refreshMail = useCallback(() => {
    apiGet<{ counts: { inbox: number } }>('/api/mail/counts')
      .then((r) => setMailUnread(r.data?.counts.inbox ?? 0))
      .catch(() => { /* no MAIL_READ, or offline — keep the last number */ });
  }, []);

  useEffect(() => {
    if (!user) { setMailUnread(0); return; }
    refreshMail();

    const offNotify = onSocket('notification:new', (n) => {
      if (typeof n?.kind === 'string' && n.kind.startsWith('mail.')) refreshMail();
    });
    // Read or moved on another device of the same person.
    const offCounts = onSocket('mail:counts', () => refreshMail());
    window.addEventListener(MAIL_CHANGED_EVENT, refreshMail);
    const onVisible = () => { if (!document.hidden) refreshMail(); };
    document.addEventListener('visibilitychange', onVisible);
    // A slow backstop for anything the socket missed while disconnected.
    const timer = window.setInterval(refreshMail, 120_000);

    return () => {
      offNotify();
      offCounts();
      window.removeEventListener(MAIL_CHANGED_EVENT, refreshMail);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [user, refreshMail]);

  const chat = totalUnread + threadsUnreadTotal;
  const feed = unreadByModule.feed;
  const meet = unreadByModule.meet;
  const total = chat + mailUnread + feed + meet;

  useEffect(() => { setTitleBadge(total); }, [total]);
  useEffect(() => { setAppBadge(total); }, [total]);
  useEffect(() => () => { setTitleBadge(0); setAppBadge(0); }, []);

  return useMemo(() => ({ '/app/chat': chat, '/app/mail': mailUnread, '/app/feed': feed, '/app/meet': meet }),
    [chat, mailUnread, feed, meet]);
}

/**
 * The count in the tab title. Restored rather than assumed: a prefix written
 * before a reload would otherwise stack into "(3) (1) Tupo".
 */
function setTitleBadge(count: number): void {
  const base = document.title.replace(/^\(\d+\+?\)\s*/, '');
  document.title = count > 0 ? `(${count > 99 ? '99+' : count}) ${base}` : base;
}

/** The installed PWA's icon badge (Badging API); a no-op where unsupported. */
function setAppBadge(count: number): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) void nav.setAppBadge?.(count).catch(() => {});
    else void nav.clearAppBadge?.().catch(() => {});
  } catch { /* unsupported */ }
}
