import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Windowing for the message log (U-6).
 *
 * Not a virtualiser in the usual sense. The classic approach — absolutely
 * positioned rows over a measured spacer — needs a height for every row before
 * it renders, and a chat message has no such thing: it wraps to an unknown
 * number of lines, may carry an image whose aspect ratio is only known after
 * layout, and grows when someone adds a reaction. Every product that has tried
 * it in a chat log has ended up fighting scroll jumps.
 *
 * What this does instead is far simpler and enough: it renders a **contiguous
 * window** of the list plus generous overscan, and pads the gap above and below
 * with two plain spacer elements whose height is *measured from what has
 * actually been rendered* rather than guessed. Rows keep their natural height,
 * nothing is positioned absolutely, and the browser's own scroll anchoring
 * keeps working.
 *
 * Below the threshold it does nothing at all. A hundred messages render fine,
 * and paying windowing complexity for them would be a bad trade.
 */

export interface VirtualWindow {
  /** Index of the first rendered item. */
  start: number;
  /** Index after the last rendered item. */
  end: number;
  /** Pixels to reserve above and below the rendered slice. */
  padTop: number;
  padBottom: number;
  /** True when the list is short enough to render whole. */
  disabled: boolean;
}

/** Below this the whole list renders. */
const THRESHOLD = 200;
/** Rendered either side of the viewport, so scrolling never shows a gap. */
const OVERSCAN = 40;

export function useVirtualWindow(
  scrollRef: React.RefObject<HTMLElement | null>,
  count: number,
  /** Reset the window when the conversation changes. */
  resetKey: string | null,
): VirtualWindow {
  const disabled = count <= THRESHOLD;

  // Anchored to the *end* of the list: a chat log is read from the bottom, and
  // that is where a freshly opened conversation starts.
  const [range, setRange] = useState({ start: 0, end: count });
  const averageHeight = useRef(72);

  useEffect(() => {
    setRange({ start: Math.max(0, count - THRESHOLD), end: count });
  }, [resetKey, count]);

  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el || disabled) return;

    /*
     * Measure rather than assume.
     *
     * The average row height is taken from what is currently on screen, so it
     * adapts to the actual content — a channel of one-line replies and one full
     * of image grids get very different numbers, and a single hard-coded
     * constant would be wrong for both.
     */
    const rendered = el.querySelectorAll('[data-message-row]');
    if (rendered.length > 4) {
      const first = rendered[0]!.getBoundingClientRect().top;
      const last = rendered[rendered.length - 1]!.getBoundingClientRect().bottom;
      const measured = (last - first) / rendered.length;
      if (measured > 8 && measured < 800) averageHeight.current = measured;
    }

    const per = averageHeight.current;
    const visibleCount = Math.ceil(el.clientHeight / per);
    // Where the viewport sits, expressed in items.
    const firstVisible = Math.floor(el.scrollTop / per);

    const start = Math.max(0, firstVisible - OVERSCAN);
    const end = Math.min(count, firstVisible + visibleCount + OVERSCAN);

    setRange((prev) => {
      // Only move when the window has drifted meaningfully. Re-rendering the
      // whole log because the user scrolled four pixels is worse than the
      // problem windowing is here to solve.
      if (Math.abs(prev.start - start) < OVERSCAN / 2
          && Math.abs(prev.end - end) < OVERSCAN / 2) return prev;
      return { start, end };
    });
  }, [scrollRef, count, disabled]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || disabled) return;

    let frame = 0;
    const onScroll = () => {
      // Coalesced to one recompute per frame: a scroll handler that runs
      // measurement on every event is itself the jank.
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; recompute(); });
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    recompute();
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollRef, recompute, disabled]);

  if (disabled) {
    return { start: 0, end: count, padTop: 0, padBottom: 0, disabled: true };
  }

  const start = Math.max(0, Math.min(range.start, Math.max(0, count - 1)));
  const end = Math.max(start + 1, Math.min(range.end, count));

  return {
    start,
    end,
    padTop: start * averageHeight.current,
    padBottom: (count - end) * averageHeight.current,
    disabled: false,
  };
}
