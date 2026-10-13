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
const VERSION = "app-shell-v4"; // v3: web push (F-04); v4: offline shell (F-09)

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
      await Promise.all(keys.filter((k) => (k.startsWith("app-shell-") && k !== VERSION) || (k.startsWith("app-assets-") && k !== ASSETS)).map((k) => caches.delete(k)));
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

/* Offline (F-09). Pages: always ask the network, fall back to the cached app
 * shell (every route is the same single-page shell), and when even that is
 * missing, a small offline page instead of a blank window. Static assets
 * (scripts, styles, fonts, images): hashed build files straight from cache,
 * everything else from the network with the cached copy as the fallback, so a
 * launch with no connection still draws the app.
 * Never the API, never a hot-reload update (the dev server's client modules
 * are cached like any other script, or a dev build could never start offline).
 */
const ASSETS = "app-assets-v4";
const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tupo — offline</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7fb;color:#0f172a}
.c{max-width:22rem;text-align:center;padding:24px}h1{font-size:20px;margin:12px 0 6px}p{color:#64748b;font-size:14px;margin:0}
button{margin-top:18px;background:#2563eb;color:#fff;border:0;border-radius:999px;padding:10px 18px;font-weight:600;font-size:14px;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#0b1220;color:#e2e8f0}p{color:#94a3b8}}</style></head>
<body><div class="c"><img src="/icon-192.png" width="56" height="56" alt=""><h1>You’re offline</h1>
<p>Tupo will be back as soon as you’re connected. Nothing you sent was lost.</p>
<button onclick="location.reload()">Try again</button></div>
<script>addEventListener("online",()=>location.reload())</script></body></html>`;

const isAsset = (req, url) =>
  url.origin === self.location.origin &&
  ["script", "style", "font", "image", "manifest"].includes(req.destination) &&
  !url.pathname.startsWith("/api/") &&
  !url.pathname.includes("hot-update");

/** Content-hashed build output never changes under the same name: cache first. */
const isHashed = (url) => url.pathname.startsWith("/assets/");

/** One cache entry per file: the dev server's `?t=` reload stamp is not a new file. */
const assetKey = (url) => {
  const key = new URL(url);
  key.searchParams.delete("t");
  return key.toString();
};

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req, { cache: "no-cache" })
        .then((res) => {
          // The same shell serves every route; keep the latest copy.
          if (res.ok && (res.headers.get("content-type") || "").includes("text/html")) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(async () => (await caches.match("/")) ||
          new Response(OFFLINE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })),
    );
    return;
  }

  if (isAsset(req, url)) {
    const key = assetKey(url);
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const hit = await cache.match(key);
        if (hit && isHashed(url)) return hit;
        // Everything else (icons, the dev server's modules) stays fresh while
        // online and comes from the cache only when the network is gone.
        return fetch(req).then((res) => {
          if (res.ok) cache.put(key, res.clone()).catch(() => undefined);
          return res;
        }).catch(() => hit || Response.error());
      }),
    );
  }
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
