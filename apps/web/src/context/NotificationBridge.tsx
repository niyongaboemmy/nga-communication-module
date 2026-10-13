import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { useNotify } from './NotificationContext';
import { useNotificationCenter } from './NotificationCenterContext';
import { getSocket } from '../lib/socket';
import { isDoNotDisturb } from '../lib/myStatus';
import { apiGet } from '../lib/api';
import type { SoundName } from '../lib/sounds';
import type { AppNotification } from '@tupo/shared';

/**
 * One bridge for every kind of notification (F-02): chat, mail, feed, meet,
 * moderation. It turns a stored notification into what a person perceives — a
 * toast, a sound, a system notification — by one rule table instead of a
 * bridge per module.
 *
 * It lives above the router: a notification is for when you are somewhere
 * else, so a bridge inside one module would only ever fire for people already
 * looking at it.
 *
 * ── What is suppressed, and what is not ─────────────────────────────────────
 * The server decides whether a notification exists. This decides whether it
 * interrupts. It does not when:
 *   - the notification panel is open (it is right there in the list);
 *   - the person is already looking at the thing (that conversation or mail
 *     thread is open in a visible tab);
 *   - the person picked "Do not disturb" (F-10): nothing pops up or chimes;
 *   - quiet hours, or the sound / desktop preferences, say so.
 * The record is never suppressed: it waits behind the bell either way.
 */

interface Prefs {
  desktopNotifications: boolean;
  sound: boolean;
  quietFromMinute: number | null;
  quietToMinute: number | null;
}

/** Mirrors `inQuietHours` on the server, in the viewer's own local time. */
function inQuietHours(prefs: Prefs, now = new Date()): boolean {
  const { quietFromMinute: from, quietToMinute: to } = prefs;
  if (from === null || to === null || from === to) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** How each kind interrupts. Anything unlisted gets a quiet toast. */
interface Rule { badge: string; sound: SoundName | null; system: boolean }
const RULES: Record<string, Rule> = {
  'chat.dm': { badge: '💬', sound: 'mention', system: true },
  'chat.mention': { badge: '@', sound: 'mention', system: true },
  'chat.message': { badge: '💬', sound: 'message', system: true },
  'chat.thread': { badge: '🧵', sound: 'message', system: true },
  'chat.reaction': { badge: '❤️', sound: null, system: false },
  'chat.invited': { badge: '👋', sound: 'message', system: true },
  'mail.received': { badge: '✉️', sound: 'message', system: true },
  'mail.campaign': { badge: '✉️', sound: null, system: false },
  'feed.announcement': { badge: '📣', sound: 'message', system: true },
  'feed.published': { badge: '📰', sound: null, system: false },
  'feed.comment': { badge: '💬', sound: null, system: false },
  'feed.reply': { badge: '💬', sound: null, system: false },
  'feed.reaction': { badge: '❤️', sound: null, system: false },
  'feed.mention': { badge: '@', sound: 'mention', system: true },
  'feed.moderation': { badge: '🛡️', sound: 'message', system: true },
  'meet.live': { badge: '🎥', sound: 'join', system: true },
  'meet.invited': { badge: '📅', sound: 'message', system: true },
  'moderation.report': { badge: '🛡️', sound: null, system: false },
};
const QUIET: Rule = { badge: '🔔', sound: null, system: false };

/** Is this notification about what is on screen right now? */
function alreadyLooking(n: AppNotification, path: string, search: URLSearchParams): boolean {
  if (document.hidden) return false;
  if (n.kind.startsWith('chat.') && n.subjectType === 'conversation') {
    return path.startsWith('/app/chat') && search.get('c') === n.subjectId;
  }
  if (n.kind === 'mail.received' && n.link) return path === n.link;
  return false;
}

export const NotificationBridge: React.FC = () => {
  const { user } = useAuth();
  const { notify } = useNotify();
  const center = useNotificationCenter();
  const navigate = useNavigate();
  const location = useLocation();

  const [prefs, setPrefs] = useState<Prefs>({ desktopNotifications: true, sound: true, quietFromMinute: null, quietToMinute: null });

  // Read inside a socket handler registered once; refs keep them current.
  const live = useRef({ prefs, navigate, location, panelOpen: center.panelOpen });
  live.current = { prefs, navigate, location, panelOpen: center.panelOpen };

  useEffect(() => {
    if (!user) return;
    apiGet<{ prefs: Prefs }>('/api/chat/prefs')
      .then((r) => setPrefs(r.data!.prefs))
      .catch(() => { /* defaults are sane; a failed read must not silence everything */ });
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const socket = getSocket();
    if (!socket) return;

    const onNotification = (n: AppNotification) => {
      const { prefs: p, location: loc, panelOpen } = live.current;
      if (panelOpen || isDoNotDisturb()) return;
      if (alreadyLooking(n, loc.pathname, new URLSearchParams(loc.search))) return;

      const rule = RULES[n.kind] ?? QUIET;
      const quiet = inQuietHours(p);
      notify({
        title: n.title,
        body: n.body ?? undefined,
        tone: 'info',
        badge: rule.badge,
        // Repeats about the same thing replace rather than stack, so a busy
        // channel cannot bury the screen in toasts.
        key: `${n.kind}:${n.subjectId ?? n.id}`,
        sound: quiet || !p.sound ? null : rule.sound,
        system: !quiet && p.desktopNotifications && rule.system,
        action: n.link ? { label: 'Open', onClick: () => live.current.navigate(n.link!) } : undefined,
      });
    };

    socket.on('notification:new', onNotification);
    return () => { socket.off('notification:new', onNotification); };
  }, [user, notify]);

  return null;
};
