import { useEffect, useRef, useState } from 'react';

/**
 * Pull down at the top of a list to refresh it (U-20), the phone gesture
 * everyone knows. Touch only; it works on the shell's scrolling `main`, and
 * only when that is already at the very top, so ordinary scrolling is never
 * taken over. Returns how far the pull has gone (for the indicator) and
 * whether a refresh is running.
 */
export function usePullToRefresh(onRefresh: () => Promise<unknown> | void, enabled = true) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const cb = useRef(onRefresh);
  cb.current = onRefresh;
  const TRIGGER = 72;

  useEffect(() => {
    if (!enabled) return;
    const el = document.querySelector<HTMLElement>('[data-app-scroll]');
    if (!el) return;
    let startY: number | null = null;
    let distance = 0;
    const onStart = (e: TouchEvent) => {
      startY = el.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0]!.clientY : null;
      distance = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (startY === null) return;
      const dy = e.touches[0]!.clientY - startY;
      if (dy <= 0 || el.scrollTop > 0) { startY = null; setPull(0); return; }
      // Resistance: the indicator follows the finger, then slows.
      distance = Math.min(110, dy * 0.55);
      setPull(distance);
    };
    const onEnd = () => {
      if (startY === null) return;
      startY = null;
      if (distance >= TRIGGER) {
        navigator.vibrate?.(10);
        setRefreshing(true);
        setPull(TRIGGER * 0.6);
        void Promise.resolve(cb.current()).finally(() => { setRefreshing(false); setPull(0); });
      } else {
        setPull(0);
      }
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [enabled]);

  return { pull, refreshing, ready: pull >= TRIGGER };
}
