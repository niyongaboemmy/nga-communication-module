import React, { useEffect, useState } from 'react';
import { NgaInstallPrompt } from './ngaInstall';

/**
 * The install prompt, only where it makes sense (F-09). Not for a guest
 * joining a meeting (they have no account and came for one call), not on the
 * sign-in hand-off or the suspended screen, and not in the middle of a call.
 *
 * Rendered outside the router, so it follows the address itself: history
 * changes are announced by patching pushState/replaceState once.
 */
const HIDDEN = [/^\/meet\//, /^\/sso\//, /^\/suspended/, /^\/app\/meet\/(?!new$|history$)[^/]+$/];

let patched = false;
function onLocationChange(cb: () => void): () => void {
  if (!patched) {
    patched = true;
    for (const k of ['pushState', 'replaceState'] as const) {
      const orig = history[k].bind(history);
      history[k] = ((...args: Parameters<History['pushState']>) => {
        const r = orig(...args);
        window.dispatchEvent(new Event('tupo:locationchange'));
        return r;
      }) as History['pushState'];
    }
  }
  window.addEventListener('popstate', cb);
  window.addEventListener('tupo:locationchange', cb);
  return () => { window.removeEventListener('popstate', cb); window.removeEventListener('tupo:locationchange', cb); };
}

export const InstallPromptGate: React.FC = () => {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => onLocationChange(() => setPath(window.location.pathname)), []);
  if (HIDDEN.some((re) => re.test(path))) return null;
  return <NgaInstallPrompt appName="Tupo" accent="#005EF9" startPath="/app" />;
};
