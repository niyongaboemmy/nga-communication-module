import { useRef, useState } from 'react';

/**
 * Phone gestures on a message (U-01): swipe right to reply, long-press for the
 * actions menu. Touch only — a mouse keeps the hover toolbar — and a mostly
 * vertical drag is left alone so the log still scrolls.
 */
export function useTouchGestures(opts: { onSwipe?: () => void; onLongPress?: () => void; disabled?: boolean }) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const mode = useRef<'idle' | 'swipe' | 'scroll'>('idle');
  const pressTimer = useRef<number | null>(null);
  const SWIPE_AT = 64, MAX = 88;

  const clearPress = () => { if (pressTimer.current) { window.clearTimeout(pressTimer.current); pressTimer.current = null; } };
  const end = () => {
    clearPress();
    if (mode.current === 'swipe' && dx >= SWIPE_AT) opts.onSwipe?.();
    start.current = null; mode.current = 'idle'; setDx(0);
  };

  const handlers = opts.disabled ? {} : {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
      mode.current = 'idle';
      clearPress();
      if (opts.onLongPress) {
        pressTimer.current = window.setTimeout(() => {
          pressTimer.current = null;
          if (mode.current !== 'idle') return;
          navigator.vibrate?.(12);
          opts.onLongPress?.();
          start.current = null;
        }, 450);
      }
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = start.current;
      if (!s || e.pointerId !== s.id) return;
      const ddx = e.clientX - s.x, ddy = e.clientY - s.y;
      if (mode.current === 'idle' && Math.hypot(ddx, ddy) > 10) {
        clearPress();
        mode.current = opts.onSwipe && ddx > 0 && Math.abs(ddx) > Math.abs(ddy) * 1.5 ? 'swipe' : 'scroll';
      }
      if (mode.current === 'swipe') {
        const next = Math.max(0, Math.min(MAX, ddx));
        if (next >= SWIPE_AT && dx < SWIPE_AT) navigator.vibrate?.(8);
        setDx(next);
      }
    },
    onPointerUp: end,
    onPointerCancel: end,
    // A long-press on a phone also raises the system menu; ours replaces it.
    onContextMenu: (e: React.MouseEvent) => { if (opts.onLongPress && (e.nativeEvent as PointerEvent).pointerType !== 'mouse') e.preventDefault(); },
  };

  return { dx, handlers, swipeReady: dx >= SWIPE_AT };
}
