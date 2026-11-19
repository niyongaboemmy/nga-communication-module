import { useSyncExternalStore } from 'react';
import { cacheGet, debouncedWriter } from '../../lib/localStore';
import { TAB_ID } from '../../lib/api';
import { count } from '../../lib/clientCounters';
import * as chatApi from './api';

/**
 * Drafts (chat experience plan, Phase 2: G-02, G-09, G-15, G-16; and the
 * Phase 1 conflict rules, G-01).
 *
 * An external store, not React state in the chat provider. Typing used to
 * set provider state, which re-rendered every chat component — every message
 * row included — on every keystroke (95 row renders per key, measured). Here
 * a keystroke notifies only the components subscribed to *that* draft: the
 * box being typed in, and its row in the sidebar.
 *
 * Three copies, in order of authority:
 *  1. memory — what the box shows;
 *  2. IndexedDB (`chat:drafts`, per account) — written 300 ms after typing
 *     stops, so a reload, a crash or an offline restart keeps the text (G-09);
 *  3. the server — a background copy for the person's other devices, sent
 *     2.5 s after typing stops, on blur, on switching conversation, and with
 *     `keepalive` when the page is hidden (G-15). Thread drafts are local only.
 *
 * Keys: a conversation id, or `thread:<rootId>` for a thread reply box.
 */

export interface DraftEntry {
  text: string;
  /** When this text was captured (ms). The newest copy wins everywhere. */
  savedAt: number;
  /** The server holds this exact text. Unsynced entries are re-sent after a reload. */
  synced?: boolean;
}

const SERVER_DEBOUNCE_MS = 2500;
const LOCAL_KEY = 'chat:drafts';
/** Drafts untouched for this long are dropped from the device copy. */
const LOCAL_TTL_MS = 30 * 24 * 3600_000;

const entries = new Map<string, DraftEntry>();
const offers = new Map<string, string>();
const keyListeners = new Map<string, Set<() => void>>();
const editedAt = new Map<string, number>();
const lastSent = new Map<string, { text: string; at: number }>();
const serverTimers = new Map<string, ReturnType<typeof setTimeout>>();
const aborts = new Map<string, AbortController>();
let version = 0;

export const threadKey = (rootId: string) => `thread:${rootId}`;
const isServerKey = (key: string) => !key.startsWith('thread:');

function emit(key: string) {
  version += 1;
  keyListeners.get(key)?.forEach((l) => l());
}

const writeLocal = debouncedWriter<Record<string, DraftEntry>>(() => LOCAL_KEY, 300);
function persist() {
  const now = Date.now();
  const out: Record<string, DraftEntry> = {};
  for (const [k, e] of entries) if (e.text || now - e.savedAt < LOCAL_TTL_MS) out[k] = e;
  writeLocal(out);
}

function sendToServer(key: string, keepalive = false) {
  const t = serverTimers.get(key);
  if (t) { clearTimeout(t); serverTimers.delete(key); }
  const e = entries.get(key);
  if (!e || e.synced || !isServerKey(key)) return;
  aborts.get(key)?.abort();
  const ctl = new AbortController();
  aborts.set(key, ctl);
  const sentAt = e.savedAt;
  void chatApi.saveDraft(key, e.text || null, sentAt, keepalive ? { keepalive: true } : { signal: ctl.signal })
    .then(() => {
      const cur = entries.get(key);
      if (cur && cur.savedAt === sentAt) { cur.synced = true; persist(); }
    })
    .catch(() => { /* stays unsynced; the next change, blur or reload sends it */ })
    .finally(() => { if (aborts.get(key) === ctl) aborts.delete(key); });
}

function scheduleServer(key: string) {
  if (!isServerKey(key)) return;
  const t = serverTimers.get(key);
  if (t) clearTimeout(t);
  serverTimers.set(key, setTimeout(() => sendToServer(key), SERVER_DEBOUNCE_MS));
}

/** Is someone typing in this box right now? */
function editingHere(key: string): boolean {
  if (Date.now() - (editedAt.get(key) ?? 0) < 5_000) return true;
  if (typeof document === 'undefined') return false;
  return (document.activeElement as HTMLElement | null)?.dataset?.draftKey === key;
}

export const drafts = {
  get(key: string): string {
    return entries.get(key)?.text ?? '';
  },

  /** A change made in this tab. */
  set(key: string, text: string): void {
    const prev = entries.get(key);
    if (prev && prev.text === text) return;
    const savedAt = Math.max(Date.now(), (prev?.savedAt ?? 0) + 1);
    editedAt.set(key, savedAt);
    entries.set(key, { text, savedAt });
    emit(key);
    persist();
    scheduleServer(key);
  },

  /** Send a pending change now (blur, switching away). */
  saveNow(key: string): void {
    if (serverTimers.has(key)) sendToServer(key);
  },

  /**
   * Sending ends the draft (G-01): no pending save, no save in flight, and a
   * late echo of the sent text is never put back. The cleared box is then
   * saved as cleared, stamped after the text it replaces.
   */
  end(key: string, sentText: string): void {
    const t = serverTimers.get(key);
    if (t) { clearTimeout(t); serverTimers.delete(key); }
    aborts.get(key)?.abort();
    aborts.delete(key);
    lastSent.set(key, { text: sentText, at: Date.now() });
    if (offers.delete(key)) emit(key);
    drafts.set(key, '');
  },

  /**
   * The server's list carries each draft without a time: it only fills a box
   * this device knows nothing about.
   */
  seedFromServer(key: string, text: string | null | undefined): void {
    if (!text || entries.has(key)) return;
    entries.set(key, { text, savedAt: 0, synced: true });
    emit(key);
  },

  /**
   * A draft saved somewhere (G-01). Applied only when it is genuinely news:
   *  - this tab's own save coming back is ignored outright;
   *  - anything older than what this tab holds is dropped;
   *  - a late echo of a message just sent is not put back in the box;
   *  - while the box is being typed in, it is offered, never applied.
   */
  applyRemote(p: { conversationId: string; draft: string | null; at: string; origin?: string | null }): void {
    if (p.origin && p.origin === TAB_ID) return;
    const key = p.conversationId;
    const text = p.draft ?? '';
    const remoteAt = Date.parse(p.at) || Date.now();
    const sent = lastSent.get(key);
    if (sent && sent.text.trim() === text.trim() && Date.now() - sent.at < 30_000) {
      count('chat.draft.conflict_dropped');
      return;
    }
    const local = entries.get(key);
    if (local && local.savedAt >= remoteAt) { count('chat.draft.conflict_dropped'); return; }
    if (local && local.text === text) return;
    if (local && local.text.trim() && editingHere(key)) {
      count('chat.draft.remote_offered');
      offers.set(key, text);
      emit(key);
      return;
    }
    entries.set(key, { text, savedAt: remoteAt, synced: true });
    emit(key);
    persist();
  },

  offer(key: string): string | null {
    return offers.has(key) ? offers.get(key)! : null;
  },

  resolveOffer(key: string, take: boolean): void {
    const text = offers.get(key);
    offers.delete(key);
    emit(key);
    if (take && text !== undefined) drafts.set(key, text);
  },

  /** Load the device copy (after sign-in), and re-send anything never synced. */
  async hydrate(): Promise<void> {
    const cached = await cacheGet<Record<string, DraftEntry>>(LOCAL_KEY);
    if (!cached) return;
    for (const [key, e] of Object.entries(cached)) {
      const cur = entries.get(key);
      if (cur && cur.savedAt >= e.savedAt) continue;
      entries.set(key, e);
      emit(key);
      if (!e.synced) scheduleServer(key);
    }
  },

  /** Signed out: nothing of this person's stays in memory. */
  reset(): void {
    for (const t of serverTimers.values()) clearTimeout(t);
    serverTimers.clear();
    for (const a of aborts.values()) a.abort();
    aborts.clear();
    const keys = [...entries.keys(), ...offers.keys()];
    entries.clear();
    offers.clear();
    editedAt.clear();
    lastSent.clear();
    keys.forEach(emit);
  },

  subscribe(key: string, listener: () => void): () => void {
    let set = keyListeners.get(key);
    if (!set) { set = new Set(); keyListeners.set(key, set); }
    set.add(listener);
    return () => { set!.delete(listener); if (set!.size === 0) keyListeners.delete(key); };
  },

  /** For tests and the perf probe. */
  version: () => version,
};

// The page is going away: whatever is waiting goes now, and survives the unload.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const key of [...serverTimers.keys()]) sendToServer(key, true);
  });
}

/** The text of one draft; re-renders only when that draft changes. */
export function useDraft(key: string | null): string {
  return useSyncExternalStore(
    (cb) => (key ? drafts.subscribe(key, cb) : () => {}),
    () => (key ? drafts.get(key) : ''),
  );
}

/** A draft from another device waiting to be accepted, if any. */
export function useDraftOffer(key: string | null): string | null {
  return useSyncExternalStore(
    (cb) => (key ? drafts.subscribe(key, cb) : () => {}),
    () => (key ? drafts.offer(key) : null),
  );
}
