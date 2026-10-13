/* App service worker, v2 (see src/pwa/ngaInstall.tsx).
 *
 * Small on purpose: it makes the app installable with the browser's
 * one-click dialog (Chromium only offers it when a worker handles fetch) and
 * shows the app shell when a launch has no connection. API calls and assets
 * are never cached here.
 *
 * v2 fixes "old release stuck in the browser": v1 fetched pages through the
 * normal HTTP cache, and the HTML used to be served without cache headers,
 * so Chrome could keep reusing an old page -- and its old code -- for hours
 * after a deploy. Pages are now always revalidated with the server, and when
 * this version takes over it refreshes open tabs that sit on a safe landing
 * page, so they switch to the current release at once. Pages where someone
 * could be mid-task (a quiz, an editor, a chat) are never reloaded.
 */
const VERSION = "app-shell-v3"; // v3: web push (F-04)

// Exact paths that are safe to reload without losing anyone's work.
const SAFE_TO_REFRESH = new Set(["/", "/dashboard", "/home", "/login", "/app", "/welcome", "/reminders", "/apps"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.add(new Request("/", { cache: "no-cache" })))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("app-shell-") && k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
      const windows = await self.clients.matchAll({ type: "window" });
      // Deliberately NOT awaited: the reload's own page request is held until
      // this activation finishes, so waiting for it here would deadlock the
      // worker in "activating" (seen in testing).
      windows.forEach((client) => {
        try {
          const url = new URL(client.url);
          if (url.origin !== self.location.origin || !SAFE_TO_REFRESH.has(url.pathname)) return;
          if ("navigate" in client) client.navigate(client.url).catch(() => null);
        } catch (e) {
          /* ignore */
        }
      });
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  // Always ask the server (revalidate); the cached shell only when offline.
  event.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        if (res.ok && new URL(req.url).pathname === "/") {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put("/", copy));
        }
        return res;
      })
      .catch(() => caches.match("/").then((hit) => hit || Response.error())),
  );
});

/* ── Web push (F-04) ─────────────────────────────────────────────────────
 * The server pushes only when the person has no open Tupo tab. Show it, and
 * on click go to exactly where it happened: focus an existing Tupo window if
 * there is one (and send it there), otherwise open one.
 */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Tupo", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Tupo";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-maskable-192.png",
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      data: { link: data.link || "/app" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/app";
  const target = new URL(link, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const mine = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (mine) {
        await mine.focus();
        if ("navigate" in mine) await mine.navigate(target).catch(() => null);
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
