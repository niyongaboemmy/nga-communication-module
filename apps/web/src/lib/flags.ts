import { useSyncExternalStore } from 'react';
import { apiGet } from './api';

/**
 * Runtime UI flags (chat experience plan, 0.6).
 *
 * The server decides per role (`GET /api/system/client-config`); the answer is
 * cached so the next load starts with the right UI instead of flashing the old
 * one. A device can force a flag for testing:
 *
 *   localStorage['tupo.flags'] = 'chat.inlineReplies=off,chat.actionSheet=on'
 *
 * Until the first answer arrives every flag reads as on, matching the server's
 * default — the cached answer, when there is one, wins over that.
 */

export type ClientFlag = 'chat.inlineReplies' | 'chat.threadPage' | 'chat.actionSheet';
const ALL: ClientFlag[] = ['chat.inlineReplies', 'chat.threadPage', 'chat.actionSheet'];
const CACHE_KEY = 'tupo.flags.server';

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function overrides(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const part of (read('tupo.flags') ?? '').split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (k) out.set(k, v !== 'off' && v !== '0' && v !== 'false');
  }
  return out;
}

let server: Set<string> = (() => {
  try {
    const cached = read(CACHE_KEY);
    return new Set(cached ? (JSON.parse(cached) as string[]) : ALL);
  } catch { return new Set(ALL); }
})();
const listeners = new Set<() => void>();
let version = 0;

export function isFlagOn(flag: ClientFlag): boolean {
  const forced = overrides().get(flag);
  return forced ?? server.has(flag);
}

let loading: Promise<void> | null = null;
/** Fetch the server's answer once per page load. Safe to call repeatedly. */
export function loadFlags(): Promise<void> {
  loading ??= apiGet<{ flags: string[] }>('/api/system/client-config')
    .then((r) => {
      server = new Set(r.data?.flags ?? ALL);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify([...server])); } catch { /* storage refused */ }
      version += 1;
      listeners.forEach((l) => l());
    })
    .catch(() => { loading = null; });
  return loading;
}

export function useFlag(flag: ClientFlag): boolean {
  useSyncExternalStore(
    (cb) => { listeners.add(cb); void loadFlags(); return () => { listeners.delete(cb); }; },
    () => version,
  );
  return isFlagOn(flag);
}
