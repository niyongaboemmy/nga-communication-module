import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { useNotify } from './NotificationContext';
import { getSocket } from '../lib/socket';
import { apiGet } from '../lib/api';
import type { AppNotification } from '@tupo/shared';

/**
 * Turns chat notification rows into the things a person actually perceives:
 * a toast, a sound, a system notification, and the count on the tab title.
 *
 * It lives above the router rather than inside the chat module, because the
 * whole point of a notification is that it reaches you while you are somewhere
 * else. A bridge mounted inside `/app/chat` would fire only for people already
 * reading their messages.
 *
 * ── What is suppressed, and what is not ─────────────────────────────────────
 * The server decides **whether a notification exists** — the audience rules in
 * `packages/chat/src/notifications.ts`. This decides **whether it interrupts**.
 * Quiet hours, a muted tab and the sound preference all suppress the
 * interruption and never the record: the row is written either way, and it is
 * waiting in the notification centre in the morning.
 */

interface ChatPrefs {
  desktopNotifications: boolean;
  sound: boolean;
  quietFromMinute: number | null;
  quietToMinute: number | null;
}

/** Mirrors `inQuietHours` on the server, in the viewer's own local time. */
function inQuietHours(prefs: ChatPrefs, now = new Date()): boolean {
  const { quietFromMinute: from, quietToMinute: to } = prefs;
  if (from === null || to === null || from === to) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  // Wraps midnight, because 22:00 → 07:00 is what quiet hours nearly always is.
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

const CHAT_KINDS = new Set(['chat.dm', 'chat.mention', 'chat.message', 'chat.thread', 'chat.reaction']);

/**
 * The unread count in the tab title.
 *
 * Restored rather than assumed: another tab, or this one before a reload, may
 * already have changed it, and stacking prefixes produces "(3) (1) Tupo".
 */
function setTitleBadge(count: number): void {
  const base = document.title.replace(/^\(\d+\+?\)\s*/, '');
  document.title = count > 0 ? `(${count > 99 ? '99+' : count}) ${base}` : base;
}

export const ChatNotificationBridge: React.FC = () => {
  const { user } = useAuth();
  const { notify } = useNotify();
  const navigate = useNavigate();

  const [prefs, setPrefs] = useState<ChatPrefs>({
    desktopNotifications: true, sound: true, quietFromMinute: null, quietToMinute: null,
  });

  // Read inside a socket handler registered once; a ref keeps it current
  // instead of frozen at the value when the effect ran.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    if (!user) return;
    apiGet<{ prefs: ChatPrefs }>('/api/chat/prefs')
      .then((r) => setPrefs(r.data!.prefs))
      .catch(() => { /* defaults are sane; a failed read must not silence chat */ });
  }, [user]);

  /* ── Title badge ─────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!user) { setTitleBadge(0); return; }

    const refreshBadge = () => {
      apiGet<{ unread: number; mentions: number }>('/api/chat/unread')
        .then((r) => setTitleBadge(r.data!.unread))
        .catch(() => {});
    };
    refreshBadge();

    const socket = getSocket();
    // Recomputed on any counter change rather than incremented locally: a badge
    // that only ever counts up is a badge that eventually lies.
    socket?.on('conversation:unread', refreshBadge);
    return () => {
      socket?.off('conversation:unread', refreshBadge);
      setTitleBadge(0);
    };
  }, [user]);

  /* ── Interruptions ───────────────────────────────────────────────────── */

  useEffect(() => {
    if (!user) return;
    const socket = getSocket();
    if (!socket) return;

    const onNotification = (n: AppNotification) => {
      if (!CHAT_KINDS.has(n.kind)) return;

      const quiet = inQuietHours(prefsRef.current);
      const isMention = n.kind === 'chat.mention' || n.kind === 'chat.dm';

      // A toast is the least intrusive channel and the only one that survives
      // quiet hours — it is visible only to someone already looking at the tab.
      notify({
        title: n.title,
        body: n.body ?? undefined,
        tone: 'info',
        badge: isMention ? '@' : '💬',
        // Repeats from the same conversation replace rather than stack, so a
        // busy channel cannot bury the screen in toasts.
        key: `${n.kind}:${n.subjectId ?? n.id}`,
        sound: quiet || !prefsRef.current.sound
          ? null
          : (isMention ? 'mention' : 'message'),
        system: !quiet && prefsRef.current.desktopNotifications,
        action: n.link
          ? { label: 'Open', onClick: () => navigateRef.current(n.link!) }
          : undefined,
      });
    };

    socket.on('notification:new', onNotification);
    return () => { socket.off('notification:new', onNotification); };
  }, [user, notify]);

  return null;
};
