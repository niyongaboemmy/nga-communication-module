import { useEffect, useRef } from 'react';
import { getSocket, onSocketState } from '../lib/socket';

/**
 * Bring a screen up to date whenever it may have missed something (S-15):
 * the socket came back after a drop, the tab returns after more than 30 s in
 * the background (a phone that slept), or the network comes back. While the
 * socket cannot connect at all, every 15 s instead, so the screen still moves.
 *
 * Chat does the same inside its provider; this is the version for every other
 * screen (Mail, the notification centre).
 */
export function useResync(resync: () => void): void {
  const ref = useRef(resync);
  ref.current = resync;

  useEffect(() => {
    let wasDown = false;
    const offState = onSocketState((s) => {
      if (s === 'reconnecting') wasDown = true;
      else if (wasDown) { wasDown = false; ref.current(); }
    });
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 30_000) ref.current();
      hiddenAt = 0;
    };
    const onOnline = () => ref.current();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    const poll = window.setInterval(() => {
      const socket = getSocket();
      if (socket && !socket.connected && navigator.onLine && !document.hidden) ref.current();
    }, 15_000);
    return () => {
      offState();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.clearInterval(poll);
    };
  }, []);
}
