/* App service worker (see src/pwa/ngaInstall.tsx).
 *
 * Deliberately small: it exists so the app is installable with the browser's
 * one-click dialog (Chromium only offers it when a worker handles fetch), and
 * so a launch with no connection shows the app shell instead of the browser's
 * offline page. API calls and assets are never cached here.
 */
const SHELL_CACHE = "app-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add(new Request("/", { cache: "reload" })))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("app-shell-") && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  // Network first; the cached shell only when the network is unreachable.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && new URL(req.url).pathname === "/") {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put("/", copy));
        }
        return res;
      })
      .catch(() => caches.match("/").then((hit) => hit || Response.error())),
  );
});
