import React, { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Install prompt shown automatically when the app loads in a browser tab and
 * isn't installed on this device (nga_central_mis/docs/APP_LAUNCH.md).
 *
 * Browsers only open their native install dialog from a user gesture -- a
 * page can never pop it by itself -- so on load we show this card, and its
 * one button opens the browser's dialog (Chromium's beforeinstallprompt). On
 * iPhone/iPad, Safari on Mac and Firefox, where there is no dialog, the card
 * shows the exact steps.
 *
 * Never shown when:
 * - the app already runs installed (standalone), or the browser reports it
 *   installed here (manifest related_applications + getInstalledRelatedApps),
 * - the browser can't install web apps at all (desktop Firefox off Windows),
 * - the user said "Not now" in the last 24 hours (unless the NGA installer
 *   sent them here on purpose with `nga_install=1`).
 *
 * URL markers:
 * - `nga_launch=app`  opened from another installed NGA app (wording only)
 * - `nga_install=1`   sent by the NGA installer (mis.amashuri.com/apps):
 *                     always ask; `return=<installer url>` adds a way back.
 *
 * Self-contained on purpose (inline styles, no app imports): the same file
 * lives in Task Mentor, Tendo and Tupo. Keep the copies identical.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const FLAG_KEY = "nga.launchedFromApp";
const FORCED_KEY = "nga.installRequested";
const RETURN_KEY = "nga.installReturn";
const SNOOZE_KEY = "nga.installSnoozedUntil";
const INSTALLED_KEY = "nga.appInstalled";
export const SNOOZE_MS = 24 * 3_600_000;
/** Where "Install all NGA apps" lives. */
export const DEFAULT_INSTALLER_URL = "https://mis.amashuri.com/apps";

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

const safe = <T,>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export const isStandalone = () =>
  typeof window !== "undefined" &&
  (Boolean((navigator as any).standalone) ||
    ["standalone", "window-controls-overlay", "fullscreen", "minimal-ui"].some(
      (m) => window.matchMedia?.(`(display-mode: ${m})`).matches,
    ));

/** Only ever send people back to an NGA page (never an arbitrary URL). */
export const safeReturnUrl = (raw: string | null, installerUrl = DEFAULT_INSTALLER_URL): string | null => {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const allowed = new URL(installerUrl);
    const sameSite = url.hostname === allowed.hostname || url.hostname.endsWith(".amashuri.com");
    return url.protocol === "https:" && sameSite ? url.toString() : null;
  } catch {
    return null;
  }
};

/** Call first thing in main.tsx, before React renders. */
export const initNgaInstall = () => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  let changed = false;
  if (url.searchParams.get("nga_launch") === "app") {
    safe(() => sessionStorage.setItem(FLAG_KEY, "1"), undefined);
    url.searchParams.delete("nga_launch");
    changed = true;
  }
  if (url.searchParams.get("nga_install") === "1") {
    safe(() => sessionStorage.setItem(FORCED_KEY, "1"), undefined);
    const back = safeReturnUrl(url.searchParams.get("return"));
    if (back) safe(() => sessionStorage.setItem(RETURN_KEY, back), undefined);
    url.searchParams.delete("nga_install");
    url.searchParams.delete("return");
    changed = true;
  }
  // Leave OAuth callback URLs to the callback page; tidy everything else.
  if (changed && !url.searchParams.has("code")) window.history.replaceState(window.history.state, "", url.toString());

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // our card decides when to ask
    deferred = e as BeforeInstallPromptEvent;
    // Chromium only fires this when the app is NOT installed here -- the
    // authoritative answer. Forget a stale "installed" note (e.g. the app
    // was installed once and later uninstalled), or the card never returns.
    installed = false;
    safe(() => localStorage.removeItem(INSTALLED_KEY), undefined);
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    safe(() => localStorage.setItem(INSTALLED_KEY, "1"), undefined);
    emit();
  });
  // A real fetch handler is what lets Chromium offer its one-click install.
  if ("serviceWorker" in navigator) {
    const base = ((import.meta as any).env?.BASE_URL as string | undefined) || "/";
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => undefined);
  }
};

export type Platform = "ios" | "mac-safari" | "firefox-windows" | "firefox-other" | "chromium" | "other";
export const detectPlatform = (ua = navigator.userAgent, touch = navigator.maxTouchPoints): Platform => {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) return "ios";
  if (/Firefox\//.test(ua)) return /Windows|Android/.test(ua) ? "firefox-windows" : "firefox-other";
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) return "mac-safari";
  if (/Chrome|Chromium|Edg\//.test(ua)) return "chromium";
  return "other";
};

/** Pure decision, unit-tested: should the card open on this load? */
export const shouldOffer = (s: {
  standalone: boolean;
  knownInstalled: boolean;
  platform: Platform;
  forced: boolean;
  snoozedUntil: number;
  now: number;
}) => {
  if (s.standalone || s.knownInstalled) return false;
  if (s.platform === "firefox-other") return false; // can't install web apps
  if (s.forced) return true;
  return s.snoozedUntil <= s.now;
};

/** Does the browser say this app is installed here? (manifest related_applications) */
const relatedAppInstalled = async () => {
  const fn = (navigator as any).getInstalledRelatedApps;
  if (typeof fn !== "function") return false;
  try {
    const apps = await fn.call(navigator);
    return Array.isArray(apps) && apps.some((a: any) => a?.platform === "webapp");
  } catch {
    return false;
  }
};

const useInstallState = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => version,
  );

const STEPS: Record<Platform, string[]> = {
  ios: [
    "Tap the Share button in the browser toolbar.",
    "Choose “Add to Home Screen”.",
    "Keep “Open as Web App” on, then tap Add.",
    "Open the app from your Home Screen.",
  ],
  "mac-safari": ["In the menu bar choose File → Add to Dock…", "Click Add, then open the app from the Dock."],
  "firefox-windows": ["Click the “Add to taskbar” icon at the right of the address bar.", "Open the app from the taskbar."],
  "firefox-other": [],
  chromium: [
    "Click the install icon at the right of the address bar — or open the browser menu ⋮.",
    "Choose “Install” (or “Cast, save and share → Install page as app”).",
  ],
  other: ["Open the browser menu and choose “Install app” or “Add to Home screen”."],
};

/** The install card. Renders nothing unless it should ask. */
export const NgaInstallPrompt: React.FC<{ appName: string; accent?: string; installerUrl?: string }> = ({
  appName,
  accent = "#2563eb",
  installerUrl = DEFAULT_INSTALLER_URL,
}) => {
  useInstallState();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [dark, setDark] = useState(false);
  const [closedThisLoad, setClosedThisLoad] = useState(false);
  const platform = detectPlatform();
  const fromApp = safe(() => sessionStorage.getItem(FLAG_KEY) === "1", false);
  const forced = safe(() => sessionStorage.getItem(FORCED_KEY) === "1", false);
  const returnUrl = safe(() => sessionStorage.getItem(RETURN_KEY), null);

  useEffect(() => {
    let alive = true;
    setDark(Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches) || document.documentElement.classList.contains("dark"));
    const base = {
      standalone: isStandalone(),
      knownInstalled: safe(() => localStorage.getItem(INSTALLED_KEY) === "1", false),
      platform,
      forced,
      snoozedUntil: safe(() => Number(localStorage.getItem(SNOOZE_KEY) || 0), 0),
      now: Date.now(),
    };
    if (!shouldOffer(base)) return;
    relatedAppInstalled().then((isInstalled) => {
      if (!alive) return;
      if (isInstalled) {
        safe(() => localStorage.setItem(INSTALLED_KEY, "1"), undefined);
        return;
      }
      setOpen(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (installed && open) setDone(true);
  });

  // The browser's "not installed, installable" signal can arrive after the
  // first render -- open then too (still honouring "Not now").
  const canPrompt = Boolean(deferred);
  useEffect(() => {
    if (!canPrompt || open || closedThisLoad) return;
    const ok = shouldOffer({
      standalone: isStandalone(),
      knownInstalled: false,
      platform,
      forced,
      snoozedUntil: safe(() => Number(localStorage.getItem(SNOOZE_KEY) || 0), 0),
      now: Date.now(),
    });
    if (ok) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPrompt]);

  if (!open) return null;

  const close = () => {
    safe(() => sessionStorage.removeItem(FORCED_KEY), undefined);
    setClosedThisLoad(true);
    setOpen(false);
  };
  const notNow = () => {
    safe(() => localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)), undefined);
    close();
  };
  const install = async () => {
    if (!deferred) return;
    setBusy(true);
    try {
      const e = deferred;
      deferred = null;
      await e.prompt();
      const { outcome } = await e.userChoice;
      if (outcome === "accepted") {
        installed = true;
        safe(() => localStorage.setItem(INSTALLED_KEY, "1"), undefined);
        if (returnUrl) setDone(true);
        else close();
      }
    } finally {
      setBusy(false);
      emit();
    }
  };

  const fg = dark ? "#f1f5f9" : "#0f172a";
  const muted = dark ? "#cbd5e1" : "#475569";
  const card = dark ? "#0f172a" : "#ffffff";
  const soft = dark ? "#1e293b" : "#f1f5f9";
  const button = (primary: boolean): React.CSSProperties => ({
    display: "block",
    boxSizing: "border-box",
    width: "100%",
    marginTop: primary ? 18 : 10,
    border: 0,
    borderRadius: 14,
    padding: primary ? "13px 16px" : "11px 16px",
    background: primary ? accent : "transparent",
    color: primary ? "#fff" : muted,
    fontSize: primary ? 15 : 14,
    fontWeight: primary ? 700 : 600,
    textAlign: "center",
    textDecoration: "none",
    cursor: "pointer",
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="nga-install-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483000,
        background: "rgba(2,6,23,.62)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
      }}
    >
      <div style={{ width: "100%", maxWidth: 440, background: card, color: fg, borderRadius: 24, padding: 24, boxShadow: "0 24px 60px -12px rgba(0,0,0,.45)" }}>
        <div
          aria-hidden
          style={{ width: 52, height: 52, borderRadius: 16, background: accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, marginBottom: 14 }}
        >
          {done ? "✓" : "⤓"}
        </div>

        {done ? (
          <>
            <h2 id="nga-install-title" style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: 1.25 }}>
              {appName} is installed
            </h2>
            <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.5, color: muted }}>
              It now opens in its own window. Continue with the next NGA app.
            </p>
            {returnUrl ? (
              <a href={returnUrl} style={button(true)}>
                Back to the NGA installer
              </a>
            ) : null}
            <button type="button" onClick={close} style={button(false)}>
              Close
            </button>
          </>
        ) : (
          <>
            <h2 id="nga-install-title" style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: 1.25 }}>
              Install {appName} as an app
            </h2>
            <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.5, color: muted }}>
              {fromApp ? `You opened ${appName} from the installed NGA app. Install it too, and it` : `${appName} works best as an app: it`} opens in its own
              window from now on — faster, and without the browser tabs.
            </p>

            {deferred ? (
              <button type="button" onClick={install} disabled={busy} autoFocus style={{ ...button(true), opacity: busy ? 0.7 : 1 }}>
                {busy ? "Opening…" : `Install ${appName}`}
              </button>
            ) : (
              <ol style={{ margin: "16px 0 0", padding: 14, listStyle: "none", background: soft, borderRadius: 16 }}>
                {STEPS[platform].map((s, i) => (
                  <li key={i} style={{ display: "flex", gap: 10, fontSize: 14, lineHeight: 1.45, padding: "4px 0" }}>
                    <span
                      style={{ flex: "0 0 22px", height: 22, borderRadius: 11, background: accent, color: "#fff", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}
                    >
                      {i + 1}
                    </span>
                    <span>{s}</span>
                  </li>
                ))}
              </ol>
            )}

            {returnUrl ? (
              <a href={returnUrl} style={button(false)}>
                Skip — back to the NGA installer
              </a>
            ) : (
              <a href={installerUrl} target="_blank" rel="noopener noreferrer" style={{ ...button(false), color: accent }}>
                Install all NGA apps
              </a>
            )}
            <button type="button" onClick={forced ? close : notNow} style={button(false)}>
              {forced ? "Continue in the browser" : "Not now"}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
