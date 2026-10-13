import React, { useEffect, useState } from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';
import { getSocketState, onSocketState, type SocketState } from '../../lib/socket';

/**
 * UX-5 — connection state is always visible.
 *
 * Offline comes from the browser; reconnecting comes from the live socket
 * (lib/socket.ts), which reports it only after a short grace period.
 *
 * It is rendered inside the shell rather than over it so it never covers the
 * composer or the message the user is reading.
 */
export type ConnectionStatus = 'online' | 'reconnecting' | 'offline';

export function useConnectionStatus(): ConnectionStatus {
  const [online, setOnline] = useState(typeof navigator === 'undefined' || navigator.onLine);
  const [socketState, setSocketState] = useState<SocketState>(getSocketState());

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    const off = onSocketState(setSocketState);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      off();
    };
  }, []);

  // The browser knows it is offline: say so. Online but the live connection is
  // down (gateway restart, flaky Wi-Fi that still claims to be up): reconnecting.
  if (!online) return 'offline';
  return socketState === 'reconnecting' ? 'reconnecting' : 'online';
}

export const ConnectionBanner: React.FC<{ status: ConnectionStatus }> = ({ status }) => {
  if (status === 'online') return null;

  const reconnecting = status === 'reconnecting';
  return (
    <div
      role="status"
      aria-live="polite"
      className={`animate-fade-in flex shrink-0 items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium ${
        reconnecting
          ? 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
          : 'bg-slate-800 text-slate-100 dark:bg-card-dark dark:text-slate-100'
      }`}
    >
      {reconnecting ? <RefreshCw size={13} className="animate-spin" /> : <CloudOff size={13} />}
      {reconnecting
        ? 'Reconnecting…'
        : 'You are offline — messages will send when you reconnect.'}
    </div>
  );
};
