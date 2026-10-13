import React, { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';

/**
 * "A new version of Tupo is ready" (F-09). The service worker takes over as
 * soon as a release lands and reloads tabs sitting on a safe landing page; a
 * tab where someone might be mid-task (a chat, a call, a draft) is never
 * reloaded under them — it gets this notice instead and reloads when they say.
 */
export const UpdateNotice: React.FC = () => {
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    // The very first install also fires controllerchange; only a hand-over
    // from an existing worker means a new release.
    let hadController = Boolean(navigator.serviceWorker.controller);
    const onChange = () => {
      if (hadController) setReady(true);
      hadController = true;
    };
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onChange);
  }, []);

  if (!ready || dismissed) return null;
  return (
    <div role="status" className="animate-fade-in flex shrink-0 items-center justify-center gap-3 bg-blue-600 px-4 py-1.5 text-xs font-medium text-white">
      <span>A new version of Tupo is ready.</span>
      <button onClick={() => window.location.reload()} className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-0.5 hover:bg-white/25">
        <RefreshCw size={12} /> Reload
      </button>
      <button onClick={() => setDismissed(true)} aria-label="Later" className="rounded-full p-0.5 hover:bg-white/15"><X size={13} /></button>
    </div>
  );
};
