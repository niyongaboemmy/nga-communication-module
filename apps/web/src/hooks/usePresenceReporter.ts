import { useEffect, useRef, useState } from 'react';
import { PRESENCE_HEARTBEAT_SECONDS } from '@tupo/shared';
import type { PresenceStatus } from '@tupo/shared';
import { getSocket } from '../lib/socket';

/**
 * Tell the server whether this person is actually at their desk.
 *
 * `away` has been in the presence vocabulary — and had an amber dot waiting for
 * it in the design system — since chat shipped, but nothing ever produced it:
 * no client emitted `presence:set` at all, so everyone was either connected
 * (green) or gone (grey). A tab left open overnight showed its owner as
 * available all night, which is exactly the thing that teaches people to
 * distrust a green dot.
 *
 * Two signals, both cheap:
 *  - **Idleness.** No pointer, key or scroll for five minutes.
 *  - **A hidden tab.** Backgrounded for a minute — long enough that flicking
 *    to another tab to check something does not flag you as away.
 *
 * Nothing is emitted unless the status actually changes, so a busy person
 * sends one packet on going idle and one on coming back, not one per event.
 * A status the person chose for themselves is never overwritten by this.
 */

const IDLE_AFTER_MS = 5 * 60_000;
const HIDDEN_AFTER_MS = 60_000;

export function usePresenceReporter(): PresenceStatus {
  const [status, setStatus] = useState<PresenceStatus>('online');
  const sent = useRef<PresenceStatus>('online');
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hiddenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const report = (next: PresenceStatus) => {
      if (sent.current === next) return;
      sent.current = next;
      setStatus(next);
      // Fire and forget, in line with every other presence signal: it is never
      // persisted and is safe to drop.
      getSocket()?.emit('presence:set', { status: next }, () => {});
    };

    const goActive = () => {
      report('online');
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => report('away'), IDLE_AFTER_MS);
    };

    const onVisibility = () => {
      if (hiddenTimer.current) clearTimeout(hiddenTimer.current);
      if (document.hidden) {
        hiddenTimer.current = setTimeout(() => report('away'), HIDDEN_AFTER_MS);
      } else {
        goActive();
      }
    };

    /*
     * Keep the key alive between changes.
     *
     * `presence:heartbeat` rather than re-sending `presence:set`: the server
     * rewrites the key from the status it already holds for this socket, so
     * this still repairs presence after a Redis restart drops every key while
     * the sockets stay up — but without the fan-out. A `presence:set` is
     * broadcast to every DM counterpart and every open conversation, and doing
     * that every 45 seconds per signed-in person, to say nothing changed, is a
     * packet storm in place of a keepalive.
     */
    const beat = setInterval(() => {
      getSocket()?.emit('presence:heartbeat', () => {});
    }, PRESENCE_HEARTBEAT_SECONDS * 1000);

    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'wheel', 'focus'];
    for (const e of events) window.addEventListener(e, goActive, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    goActive();

    return () => {
      for (const e of events) window.removeEventListener(e, goActive);
      document.removeEventListener('visibilitychange', onVisibility);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (hiddenTimer.current) clearTimeout(hiddenTimer.current);
      clearInterval(beat);
    };
  }, []);

  return status;
}
