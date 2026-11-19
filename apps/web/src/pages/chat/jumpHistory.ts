import { useSyncExternalStore } from 'react';

/**
 * Where to come back to after following a quote (R-10).
 *
 * Tapping a quote jumps to the original; "Back to reply" returns to the reply
 * it was tapped from. A stack, so a chain of quotes unwinds one step at a
 * time. It lapses after a while of not being used, and is cleared when the
 * conversation changes — a way back that points somewhere stale is worse
 * than none.
 */

const LAPSE_MS = 15_000;
const stack: string[] = [];
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function emit() { listeners.forEach((l) => l()); }
function arm() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { stack.length = 0; emit(); }, LAPSE_MS);
}

export const jumpHistory = {
  push(fromMessageId: string) { stack.push(fromMessageId); arm(); emit(); },
  pop(): string | undefined { const id = stack.pop(); if (stack.length) arm(); emit(); return id; },
  clear() { if (stack.length) { stack.length = 0; emit(); } },
};

export function useJumpDepth(): number {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => stack.length,
  );
}
