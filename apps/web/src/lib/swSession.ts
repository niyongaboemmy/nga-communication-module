/**
 * What the service worker needs from the page (N-03).
 *
 * "Mark as read" on a notification runs in the service worker, often with no
 * Tupo tab open, and a worker cannot read localStorage. The session token is
 * therefore also kept in a tiny IndexedDB store the worker can read, written
 * when a session starts and deleted with it.
 *
 * And the reverse: reading a conversation here closes its notifications, so a
 * phone does not keep showing messages already read on the laptop.
 */
const DB = 'tupo-sw';

function withStore(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(); return; }
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => resolve();
      req.onsuccess = () => {
        try {
          const tx = req.result.transaction('kv', mode);
          fn(tx.objectStore('kv'));
          tx.oncomplete = tx.onerror = tx.onabort = () => { req.result.close(); resolve(); };
        } catch { resolve(); }
      };
    } catch { resolve(); }
  });
}

export function setSwSessionToken(token: string | null): Promise<void> {
  return withStore('readwrite', (store) => { if (token) store.put(token, 'token'); else store.delete('token'); });
}

/** Close the notifications this device shows for a conversation (it has been read). */
export async function closeConversationNotifications(conversationId: string): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const open = await reg?.getNotifications();
    for (const n of open ?? []) {
      if ((n.data as { conversationId?: string } | null)?.conversationId === conversationId) n.close();
    }
  } catch { /* no service worker here: nothing to close */ }
}
