import React, { useEffect, useState } from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';

/**
 * UX-5 — connection state is always visible.
 *
 * Phase 0 has no socket yet, so this reflects the browser's own online state.
 * When `@tupo/realtime` lands in Phase 1 the socket's `connect`/`disconnect`
 * events feed the same two states through the `status` prop; nothing else about
 * the banner changes.
 *
 * It is rendered inside the shell rather than over it so it never covers the
 * composer or the message the user is reading.
 */
export type ConnectionStatus = 'online' | 'reconnecting' | 'offline';

export function useConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(
    typeof navigator === 'undefined' || navigator.onLine ? 'online' : 'offline',
  );

  useEffect(() => {
    const goOnline = () => setStatus('online');
    const goOffline = () => setStatus('offline');
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return status;
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
          : 'bg-slate-800 text-slate-100 dark:bg-gray-700 dark:text-slate-100'
      }`}
    >
      {reconnecting ? <RefreshCw size={13} className="animate-spin" /> : <CloudOff size={13} />}
      {reconnecting
        ? 'Reconnecting…'
        : 'You are offline — messages will send when you reconnect.'}
    </div>
  );
};
