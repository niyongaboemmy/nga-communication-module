import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Ask before leaving a screen with unsaved work (F-12).
 *
 * The app runs on a BrowserRouter, which has no navigation blocker, so this
 * covers the two ways out: closing or reloading the tab (the browser's own
 * prompt) and following an in-app link (caught before the router sees it,
 * then followed if the person agrees).
 */
export function useLeaveGuard(dirty: boolean, ask: () => Promise<boolean>): void {
  const navigate = useNavigate();
  const live = useRef({ dirty, ask });
  live.current = { dirty, ask };

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!live.current.dirty || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // a new tab leaves this one alone
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      void live.current.ask().then((leave) => {
        if (leave) navigate(`${url.pathname}${url.search}${url.hash}`);
      });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [navigate]);
}
