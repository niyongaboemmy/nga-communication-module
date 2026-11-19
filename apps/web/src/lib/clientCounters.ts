import { SESSION_KEY, setRequestTimeoutListener } from './api';

/**
 * Client counters (chat experience plan, 0.7).
 *
 * How often a reliability fix actually fires in the field: a stale draft echo
 * dropped, a send ack that timed out and fell back to REST, an edit rolled
 * back. Counted in memory, sent in one small batch every 30 s and when the
 * page is hidden — never one request per event.
 */

export type ClientCounter =
  | 'chat.draft.conflict_dropped'
  | 'chat.draft.remote_offered'
  | 'chat.send.ack_timeout'
  | 'chat.send.rest_fallback'
  | 'chat.outbox.flush_joined'
  | 'chat.edit.rollback'
  | 'chat.delete.rollback'
  | 'chat.request.timeout';

const pending = new Map<ClientCounter, number>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Also readable by the e2e suites, to prove a path ran. */
const totals: Record<string, number> = {};
if (typeof window !== 'undefined') (window as unknown as { __tupoCounters: typeof totals }).__tupoCounters = totals;

export function count(name: ClientCounter, by = 1): void {
  pending.set(name, (pending.get(name) ?? 0) + by);
  totals[name] = (totals[name] ?? 0) + by;
  timer ??= setTimeout(flush, 30_000);
}

function flush(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (pending.size === 0) return;
  let token: string | null = null;
  try { token = localStorage.getItem(SESSION_KEY); } catch { /* storage refused */ }
  if (!token) { pending.clear(); return; }
  const counters = Object.fromEntries(pending);
  pending.clear();
  void fetch('/api/system/client-counters', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ counters }),
  }).catch(() => {});
}

setRequestTimeoutListener(() => count('chat.request.timeout'));

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
}
