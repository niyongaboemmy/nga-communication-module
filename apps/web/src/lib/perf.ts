/**
 * Typing-performance probe (chat experience plan, 0.4).
 *
 * Off unless the page was opened with `?perf=1` (or localStorage
 * `tupo.perf=1`). When on, it records:
 *   - how many times a message row rendered (`rowRenders`), so a suite can
 *     assert that a keystroke renders none of them;
 *   - keystroke cost: from the input event to the end of the React commit it
 *     caused (all re-rendering and DOM work, without the idle wait for the
 *     next frame, which would hide the difference being measured).
 *
 * The suites read `window.__tupoPerf`. Nothing here runs for real users.
 */

interface PerfState { rowRenders: number; keyLatencies: number[] }

export const PERF_ON = typeof window !== 'undefined' && (() => {
  try {
    return new URLSearchParams(window.location.search).get('perf') === '1'
      || localStorage.getItem('tupo.perf') === '1';
  } catch { return false; }
})();

const state: PerfState = { rowRenders: 0, keyLatencies: [] };
if (PERF_ON) (window as unknown as { __tupoPerf: PerfState }).__tupoPerf = state;

export function noteRowRender(): void {
  if (PERF_ON) state.rowRenders += 1;
}

let keyStart: number | null = null;

/** Call at the top of an input handler. */
export function noteKeystroke(): void {
  if (PERF_ON) keyStart = performance.now();
}

/**
 * Call from the text box's layout effect. React runs layout effects after the
 * whole tree has rendered and committed, so the gap is the full cost of the
 * keystroke: every component it re-rendered, plus the DOM work.
 */
export function noteCommit(): void {
  if (!PERF_ON || keyStart === null) return;
  state.keyLatencies.push(performance.now() - keyStart);
  keyStart = null;
}
