/**
 * The on-device copy of what this person has already seen (P-02).
 *
 * WhatsApp and Slack open instantly because the last state is on the device:
 * the screen renders from it at once, and the network quietly brings it up to
 * date. This is that copy for Tupo — the conversation list, the newest
 * messages of recently opened conversations, the first mailbox pages, the
 * first feed page, notifications.
 *
 * Rules that keep it safe:
 *
 * - **One database per account** (`tupo-cache-<userId>`). Nothing one person
 *   saw can render for whoever signs in next on a shared device, and sign-out
 *   deletes the database outright.
 * - **Display only.** Nothing here is ever sent to the server or trusted for a
 *   decision. Every screen that reads it also fetches, and the fetch wins.
 * - **Bounded.** Each key holds one capped value, and families of keys
 *   (`chat:msgs:*`) keep only the most recently written entries.
 * - **Never in the way.** IndexedDB missing, blocked or full turns every call
 *   into a quiet no-op: the app then behaves exactly as it did without a cache.
 */

const DB_PREFIX = 'tupo-cache-';
const DB_VERSION = 1;
const STORE = 'kv';

/** How many keys a family may hold, by prefix. Least recently written goes first. */
const FAMILY_CAP: Record<string, number> = {
  'chat:msgs:': 40,
  'mail:list:': 12,
  'feed:': 8,
};

interface Row<T = unknown> { key: string; value: T; at: number; v: number }

/** Bumped when a cached shape changes incompatibly; older rows are ignored. */
const SHAPE_VERSION = 1;

let userId: string | null = null;
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(id: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    try {
      const req = indexedDB.open(DB_PREFIX + id, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('at', 'at');
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab deleting this database (sign-out) must not be blocked by us.
        db.onversionchange = () => { db.close(); if (userId === id) dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Called when a session starts or ends. Reads and writes go to this account's database only. */
export function setCacheOwner(id: string | null): void {
  if (id === userId) return;
  userId = id;
  dbPromise = id ? openDb(id) : null;
}

function db(): Promise<IDBDatabase | null> {
  return dbPromise ?? Promise.resolve(null);
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** The cached value, or null. Never throws. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const owner = userId;
  const d = await db();
  if (!d || owner !== userId) return null;
  try {
    const row = await request(d.transaction(STORE, 'readonly').objectStore(STORE).get(key)) as Row<T> | undefined;
    return row && row.v === SHAPE_VERSION ? row.value : null;
  } catch {
    return null;
  }
}

/** Store a value. Fire-and-forget: failure only means the next open is not instant. */
export async function cacheSet<T>(key: string, value: T): Promise<void> {
  const owner = userId;
  const d = await db();
  if (!d || owner !== userId) return;
  try {
    const tx = d.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put({ key, value, at: Date.now(), v: SHAPE_VERSION } satisfies Row<T>);
    const family = Object.keys(FAMILY_CAP).find((p) => key.startsWith(p));
    if (family) {
      // Trim the family to its cap, oldest first. Keys are few (tens), so a
      // full key scan is cheaper than maintaining a second index.
      const rows = await request(store.getAll(IDBKeyRange.bound(family, `${family}￿`))) as Row[];
      const excess = rows.length - FAMILY_CAP[family]!;
      if (excess > 0) {
        rows.sort((a, b) => a.at - b.at).slice(0, excess).forEach((r) => store.delete(r.key));
      }
    }
    await new Promise<void>((resolve) => { tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); tx.onabort = () => resolve(); });
  } catch {
    /* quota or a closed database: the cache is best effort */
  }
}

export async function cacheDelete(key: string): Promise<void> {
  const d = await db();
  if (!d) return;
  try { d.transaction(STORE, 'readwrite').objectStore(STORE).delete(key); } catch { /* best effort */ }
}

/**
 * Sign-out: delete this account's database. Also removes the databases of any
 * other account found on this device, in case a previous sign-out was cut short.
 */
export async function cacheClearAll(): Promise<void> {
  const d = await db();
  d?.close();
  dbPromise = null;
  const current = userId;
  userId = null;
  if (typeof indexedDB === 'undefined') return;
  const names = new Set<string>();
  if (current) names.add(DB_PREFIX + current);
  try {
    const all = await (indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }).databases?.();
    for (const x of all ?? []) if (x.name?.startsWith(DB_PREFIX)) names.add(x.name);
  } catch { /* databases() is missing on older Safari */ }
  await Promise.all([...names].map((name) => new Promise<void>((resolve) => {
    try {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    } catch { resolve(); }
  })));
}

/**
 * A writer that waits for a quiet moment: live updates can change a list many
 * times a second, and serialising it on each change would cost more than the
 * cache saves.
 */
export function debouncedWriter<T>(key: () => string | null, delayMs = 600): (value: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: { key: string; value: T } | null = null;
  const flush = () => {
    timer = null;
    if (latest) { void cacheSet(latest.key, latest.value); latest = null; }
  };
  if (typeof window !== 'undefined') window.addEventListener('pagehide', flush);
  return (value: T) => {
    const k = key();
    if (!k) return;
    if (latest && latest.key !== k) flush();
    latest = { key: k, value };
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  };
}
