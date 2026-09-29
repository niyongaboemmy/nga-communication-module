import React, { useEffect, useState, useSyncExternalStore } from "react";

/**
 * "Install this app too" -- shown when the app is opened from the installed
 * NGA MIS app but is itself running in a browser tab (not installed here).
 *
 * The MIS Apps menu adds `nga_launch=app` to its link only when MIS runs as
 * an installed app. Browsers never let a site install itself silently, so the
 * strongest thing a page can do is ask immediately with the browser's own
 * one-click dialog (Chromium's beforeinstallprompt), or show the exact steps
 * where no dialog exists (iPhone/iPad, Safari on Mac, Firefox).
 *
 * Self-contained on purpose (inline styles, no app imports): the same file
 * lives in Task Mentor and Tupo. Keep the copies identical.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const FLAG_KEY = "nga.launchedFromApp";
const DISMISS_KEY = "nga.installDismissed";
const INSTALLED_KEY = "nga.appInstalled";

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

/** Call first thing in main.tsx, before React renders. */
export const initNgaInstall = () => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (url.searchParams.get("nga_launch") === "app") {
    safe(() => sessionStorage.setItem(FLAG_KEY, "1"), undefined);
    url.searchParams.delete("nga_launch");
    // Leave OAuth callback URLs to the callback page; tidy everything else.
    if (!url.searchParams.has("code")) window.history.replaceState(window.history.state, "", url.toString());
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we show our own, better-timed prompt
    deferred = e as BeforeInstallPromptEvent;
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

type Platform = "ios" | "mac-safari" | "firefox" | "chromium" | "other";
const detect = (): Platform => {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) return "mac-safari";
  if (/Chrome|Chromium|Edg\//.test(ua)) return "chromium";
  return "other";
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
  firefox: ["Click the “Add to taskbar” icon at the right of the address bar.", "Open the app from the taskbar."],
  chromium: [
    "Click the install icon at the right of the address bar — or open the browser menu ⋮.",
    "Choose “Install” (or “Cast, save and share → Install page as app”).",
  ],
  other: ["Open the browser menu and choose “Install app” or “Add to Home screen”."],
};

/** Full-screen install card. Renders nothing unless it should ask. */
export const NgaInstallPrompt: React.FC<{ appName: string; accent?: string }> = ({ appName, accent = "#2563eb" }) => {
  useInstallState();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const launchedFromApp = safe(() => sessionStorage.getItem(FLAG_KEY) === "1", false);
    const dismissed = safe(() => sessionStorage.getItem(DISMISS_KEY) === "1", false);
    const knownInstalled = safe(() => localStorage.getItem(INSTALLED_KEY) === "1", false);
    setOpen(launchedFromApp && !dismissed && !isStandalone() && !knownInstalled);
    setDark(Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches) || document.documentElement.classList.contains("dark"));
  }, []);

  if (!open || installed) return null;

  const platform = detect();
  const close = () => {
    safe(() => sessionStorage.setItem(DISMISS_KEY, "1"), undefined);
    setOpen(false);
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
      }
      close();
    } finally {
      setBusy(false);
      emit();
    }
  };

  const fg = dark ? "#f1f5f9" : "#0f172a";
  const muted = dark ? "#cbd5e1" : "#475569";
  const card = dark ? "#0f172a" : "#ffffff";
  const soft = dark ? "#1e293b" : "#f1f5f9";

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
      <div
        style={{
          width: "100%",
          maxWidth: 440,
          background: card,
          color: fg,
          borderRadius: 24,
          padding: 24,
          boxShadow: "0 24px 60px -12px rgba(0,0,0,.45)",
        }}
      >
        <div
          aria-hidden
          style={{
            width: 52,
            height: 52,
            borderRadius: 16,
            background: accent,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 26,
            marginBottom: 14,
          }}
        >
          ⤓
        </div>
        <h2 id="nga-install-title" style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: 1.25 }}>
          Install {appName} as an app
        </h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.5, color: muted }}>
          You opened {appName} from the installed NGA app. Install it too, and it will open in its own window from now on
          — faster, and without the browser tabs.
        </p>

        {deferred ? (
          <button
            type="button"
            onClick={install}
            disabled={busy}
            autoFocus
            style={{
              marginTop: 18,
              width: "100%",
              border: 0,
              borderRadius: 14,
              padding: "13px 16px",
              background: accent,
              color: "#fff",
              fontSize: 15,
              fontWeight: 700,
              cursor: "pointer",
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? "Opening…" : `Install ${appName}`}
          </button>
        ) : (
          <ol style={{ margin: "16px 0 0", padding: 14, listStyle: "none", background: soft, borderRadius: 16 }}>
            {STEPS[platform].map((s, i) => (
              <li key={i} style={{ display: "flex", gap: 10, fontSize: 14, lineHeight: 1.45, padding: "4px 0" }}>
                <span
                  style={{
                    flex: "0 0 22px",
                    height: 22,
                    borderRadius: 11,
                    background: accent,
                    color: "#fff",
                    fontSize: 12,
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {i + 1}
                </span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
        )}

        <button
          type="button"
          onClick={close}
          style={{
            marginTop: 10,
            width: "100%",
            border: 0,
            borderRadius: 14,
            padding: "11px 16px",
            background: "transparent",
            color: muted,
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Continue in the browser
        </button>
      </div>
    </div>
  );
};
