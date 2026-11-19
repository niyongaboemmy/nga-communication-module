/**
 * Which inline threads this person left open (R-03), per device. A
 * convenience, so it lives in localStorage and every access is guarded: it
 * may be empty or refused (private window), and the UI must not care.
 */

const KEY = 'tupo.inlineThreads';
const MAX = 200;

function read(): string[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]; } catch { return []; }
}

export function isInlineOpen(rootId: string): boolean {
  return read().includes(rootId);
}

export function setInlineOpen(rootId: string, open: boolean): void {
  try {
    const rest = read().filter((id) => id !== rootId);
    const next = open ? [rootId, ...rest].slice(0, MAX) : rest;
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* storage refused: the choice simply is not remembered */ }
}
