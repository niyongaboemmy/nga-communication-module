/**
 * The offline outbox (FR-MSG-24).
 *
 * A message composed with no connection is written here first and only then
 * shown as `pending`. On reconnect the queue is flushed **in order**, oldest
 * first, and each send carries the nonce it was created with — so a message
 * that in fact reached the server before the connection dropped resolves to
 * itself rather than posting twice.
 *
 * IndexedDB rather than localStorage. Not for the storage limit: for the
 * atomicity. localStorage is synchronous and unversioned, so two tabs flushing
 * the same queue race on read-modify-write and one of them loses a message.
 * IndexedDB gives a real transaction, and `delete` after a confirmed send is
 * the only thing that removes an entry.
 *
 * The whole module degrades to a no-op if IndexedDB is unavailable (private
 * mode on some browsers, or a storage quota refusal). Sending still works —
 * it just is not durable across a reload, which is the correct failure: a chat
 * that refuses to send because it cannot persist a backup would be worse.
 */

const DB_NAME = 'tupo-chat';
const DB_VERSION = 1;
const STORE = 'outbox';

export interface OutboxEntry {
  nonce: string;
  /**
   * Whose message this is. The store is per browser, not per account: without
   * an owner, a message queued by one person could be sent as whoever signs
   * in next on the same device (CHAT-M12).
   */
  ownerId?: string;
  conversationId: string;
  body: string;
  replyToId: string | null;
  threadRootId: string | null;
  attachments: string[];
  /** Kept so a poll, a call card or a /me survives the queue as what it was (CHAT-M12). */
  type?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  /** Bumped on each failed flush, so a poisonous entry cannot loop forever. */
  attempts: number;
}

let owner: string | null = null;
/** Entries queued before tenancy were tagged with the bare user id: tenant 1's. */
let legacyOwner: string | null = null;
/**
 * Set by ChatProvider when a session starts; entries are tagged `<tid>:<userId>`
 * and filtered by it, so a queue never replays into another school's account.
 */
export function setOutboxOwner(userId: string | null, tid = 1): void {
  owner = userId ? `${tid}:${userId}` : null;
  legacyOwner = userId && tid === 1 ? userId : null;
}

/** After this many failed attempts an entry is surfaced as failed, not retried. */
export const MAX_ATTEMPTS = 5;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'nonce' });
          // Flush order is creation order, globally — not per conversation.
          // Someone who types in three channels while offline expects all three
          // to go, and the relative order within each to hold.
          store.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(
  mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return open().then((db) => {
    if (!db) return null;
    return new Promise<T | null>((resolve) => {
      try {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        t.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  });
}

export async function enqueue(
  entry: Omit<OutboxEntry, 'createdAt' | 'attempts'>,
): Promise<void> {
  await tx('readwrite', (s) => s.put({ ...entry, ownerId: owner ?? undefined, createdAt: Date.now(), attempts: 0 }));
}

export async function dequeue(nonce: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(nonce));
}

/** Everything this person has waiting, oldest first. Never anyone else's. */
export async function pending(): Promise<OutboxEntry[]> {
  const all = await tx<OutboxEntry[]>('readonly', (s) => s.getAll() as IDBRequest<OutboxEntry[]>);
  return (all ?? [])
    .filter((e) => owner !== null && (e.ownerId === owner || (legacyOwner !== null && e.ownerId === legacyOwner)))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Empty the queue — on sign-out, so nothing is left for the next person. */
export async function clearAll(): Promise<void> {
  await tx('readwrite', (s) => s.clear());
}

export async function recordAttempt(nonce: string): Promise<number> {
  const existing = await tx<OutboxEntry>('readonly', (s) => s.get(nonce) as IDBRequest<OutboxEntry>);
  if (!existing) return MAX_ATTEMPTS;
  const attempts = existing.attempts + 1;
  await tx('readwrite', (s) => s.put({ ...existing, attempts }));
  return attempts;
}

/**
 * Flush the queue, oldest first, stopping at the first failure.
 *
 * Stopping matters. Continuing past a failure would deliver later messages
 * before earlier ones, and a conversation whose replies arrive before their
 * questions is worse than one that is briefly behind.
 */
export async function flush(
  send: (entry: OutboxEntry) => Promise<boolean>,
  onGiveUp?: (entry: OutboxEntry) => void,
): Promise<{ sent: number; remaining: number }> {
  const queue = await pending();
  let sent = 0;

  for (const entry of queue) {
    let ok = false;
    try { ok = await send(entry); } catch { ok = false; }

    if (ok) {
      await dequeue(entry.nonce);
      sent += 1;
      continue;
    }

    const attempts = await recordAttempt(entry.nonce);
    if (attempts >= MAX_ATTEMPTS) {
      // Give up on this one and let the UI show it as failed with a retry —
      // an entry that can never send must not block everything behind it
      // forever.
      await dequeue(entry.nonce);
      onGiveUp?.(entry);
      continue;
    }
    break;
  }

  return { sent, remaining: (await pending()).length };
}

export async function clear(): Promise<void> {
  await tx('readwrite', (s) => s.clear());
}
