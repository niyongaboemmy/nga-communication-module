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
 * - the user said "Not now" in this browser session (unless the NGA
 *   installer sent them here on purpose with `nga_install=1`).
 *
 * Whenever the card is closed and the app is installable, a small corner
 * "Install" button stays available -- dismissing never removes the way to
 * install (no DevTools, no waiting).
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
/** Legacy 24 h snooze (removed: it hid the only way to install for a day). */
const LEGACY_SNOOZE_KEY = "nga.installSnoozedUntil";
/** "Not now" hides the big card until the browser is reopened. */
const DISMISS_KEY = "nga.installDismissedThisSession";
/** The small corner button can be hidden for the session too. */
const PILL_HIDDEN_KEY = "nga.installPillHidden";
const INSTALLED_KEY = "nga.appInstalled";
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

/**
 * Tell the NGA installer (the tab that opened this one) how it went, so its
 * list updates live -- the installer can't see other sites' installed apps on
 * desktop, only what the app itself reports. Message goes only to the
 * installer's origin; no-op without an opener or return URL.
 */
export type InstallReport = "installed" | "already" | "skipped";
export const installerKeyFrom = (returnUrl: string | null) => {
  if (!returnUrl) return null;
  const url = safe(() => new URL(returnUrl), null);
  return url?.searchParams.get("done") ?? null;
};
/**
 * The cookie channel: every NGA app lives under amashuri.com, so a cookie on
 * that parent domain reaches the installer even when there is no opener --
 * which is the normal case, because Chrome only opens a link in an installed
 * app's window when it has no opener. Short-lived; the installer clears it.
 */
export const reportCookieName = (key: string) => `nga_inst_${key.replace(/[^a-z0-9_-]/gi, "")}`;
export const writeReportCookie = (key: string, status: InstallReport, host = window.location.hostname, now = Date.now()) => {
  const domain = host === "amashuri.com" || host.endsWith(".amashuri.com") ? "; domain=.amashuri.com; secure" : "";
  safe(() => {
    document.cookie = `${reportCookieName(key)}=${status}.${now}; path=/; max-age=900; samesite=lax${domain}`;
  }, undefined);
};

export const notifyInstaller = (status: InstallReport, returnUrl: string | null) => {
  const key = installerKeyFrom(returnUrl);
  if (!returnUrl || !key) return false;
  writeReportCookie(key, status);
  const opener = safe(() => window.opener as Window | null, null);
  if (!opener) return false;
  return safe(() => {
    opener.postMessage({ type: "nga-install", app: key, status }, new URL(returnUrl).origin);
    return true;
  }, false);
};
/** The way back after skipping: never reported as installed. */
export const skipReturnUrl = (returnUrl: string) => returnUrl.replace(/([?&])done=/, "$1skipped=");

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
  safe(() => localStorage.removeItem(LEGACY_SNOOZE_KEY), undefined);
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
    notifyInstaller("installed", safe(() => sessionStorage.getItem(RETURN_KEY), null));
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

/** Pure decision, unit-tested: should the big card open on this load? */
export const shouldOffer = (s: {
  standalone: boolean;
  knownInstalled: boolean;
  platform: Platform;
  forced: boolean;
  dismissedThisSession: boolean;
}) => {
  if (s.standalone || s.knownInstalled) return false;
  if (s.platform === "firefox-other") return false; // can't install web apps
  if (s.forced) return true;
  return !s.dismissedThisSession;
};

/**
 * Pure decision, unit-tested: show the small always-available "Install"
 * button? On Chromium only when the browser itself says the app is
 * installable (beforeinstallprompt) -- so never for an installed app. Where
 * there's no such signal (iPhone/iPad, Safari on Mac, Firefox on Windows) it
 * shows unless running installed.
 */
export const shouldShowInstallButton = (s: {
  standalone: boolean;
  installed: boolean;
  platform: Platform;
  canPrompt: boolean;
  cardOpen: boolean;
  hidden: boolean;
}) => {
  if (s.standalone || s.installed || s.cardOpen || s.hidden) return false;
  if (s.canPrompt) return true;
  return s.platform === "ios" || s.platform === "mac-safari" || s.platform === "firefox-windows";
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
export const NgaInstallPrompt: React.FC<{
  appName: string;
  accent?: string;
  installerUrl?: string;
  /** Where the installed app starts (in scope), used by "Open the app". */
  startPath?: string;
}> = ({ appName, accent = "#2563eb", installerUrl = DEFAULT_INSTALLER_URL, startPath = "/" }) => {
  useInstallState();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // The installer sent us here, but this app is already installed.
  const [already, setAlready] = useState(false);
  const [dark, setDark] = useState(false);
  const [closedThisLoad, setClosedThisLoad] = useState(false);
  const [pillHidden, setPillHidden] = useState(() => safe(() => sessionStorage.getItem(PILL_HIDDEN_KEY) === "1", false));
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
      dismissedThisSession: safe(() => sessionStorage.getItem(DISMISS_KEY) === "1", false),
    };
    // Running as the installed app (e.g. the installer's link opened it
    // straight in its window): nothing to ask -- just tell the installer.
    if (base.standalone) {
      if (forced) {
        notifyInstaller("already", returnUrl);
        safe(() => sessionStorage.removeItem(FORCED_KEY), undefined);
      }
      return;
    }
    // Sent by the installer, installed already, but opened in a browser tab:
    // offer to open the app window (and tell the installer).
    const answerInstaller = () => {
      if (!forced) return;
      setAlready(true);
      setOpen(true);
      notifyInstaller("already", returnUrl);
    };
    if (forced && (base.standalone || base.knownInstalled)) {
      answerInstaller();
      return;
    }
    if (!shouldOffer(base)) return;
    relatedAppInstalled().then((isInstalled) => {
      if (!alive) return;
      if (isInstalled) {
        safe(() => localStorage.setItem(INSTALLED_KEY, "1"), undefined);
        answerInstaller();
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

  // Installing from a tab: Chrome moves this very page into the new app
  // window. The card has done its job -- get out of the way.
  useEffect(() => {
    const mq = safe(() => window.matchMedia("(display-mode: standalone)"), null);
    if (!mq) return;
    const onChange = () => {
      if (!mq.matches) return;
      if (safe(() => sessionStorage.getItem(FORCED_KEY) === "1", false)) {
        notifyInstaller("installed", returnUrl);
        safe(() => sessionStorage.removeItem(FORCED_KEY), undefined);
      }
      setOpen(false);
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The browser's "not installed, installable" signal can arrive after the
  // first render -- open then too (still honouring "Not now").
  const canPrompt = Boolean(deferred);
  useEffect(() => {
    // Chromium only offers installation when the app is NOT installed here,
    // so a remembered "installed" note was stale: show the install view.
    if (canPrompt && already) setAlready(false);
    if (!canPrompt || open || closedThisLoad) return;
    const ok = shouldOffer({
      standalone: isStandalone(),
      knownInstalled: false,
      platform,
      forced,
      dismissedThisSession: safe(() => sessionStorage.getItem(DISMISS_KEY) === "1", false),
    });
    if (ok) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPrompt]);

  if (!open) {
    const knownInstalled = safe(() => localStorage.getItem(INSTALLED_KEY) === "1", false);
    // Installed, but this is a browser tab: a one-click way into the app.
    if (!isStandalone() && !pillHidden && (installed || (knownInstalled && !deferred))) {
      const url = safe(() => new URL(startPath, window.location.origin).toString(), "/");
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener"
          onClick={() => window.setTimeout(() => window.close(), 600)}
          style={{
            position: "fixed",
            right: 16,
            bottom: "calc(16px + env(safe-area-inset-bottom))",
            zIndex: 2147482000,
            padding: "10px 16px",
            borderRadius: 999,
            background: accent,
            color: "#fff",
            fontSize: 14,
            fontWeight: 700,
            textDecoration: "none",
            boxShadow: "0 10px 30px -8px rgba(0,0,0,.45)",
            fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
          }}
        >
          ↗ Open in the {appName} app
        </a>
      );
    }
    const showButton = shouldShowInstallButton({
      standalone: isStandalone(),
      // Chromium's own signal outranks any remembered note.
      installed: installed || (knownInstalled && !deferred),
      platform,
      canPrompt: Boolean(deferred),
      cardOpen: open,
      hidden: pillHidden,
    });
    if (!showButton) return null;
    return (
      <div
        style={{
          position: "fixed",
          right: 16,
          bottom: "calc(16px + env(safe-area-inset-bottom))",
          zIndex: 2147482000,
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: 4,
          borderRadius: 999,
          background: accent,
          boxShadow: "0 10px 30px -8px rgba(0,0,0,.45)",
          fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
        }}
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{ border: 0, background: "transparent", color: "#fff", fontSize: 14, fontWeight: 700, padding: "8px 12px", cursor: "pointer", borderRadius: 999 }}
        >
          ⤓ Install {appName}
        </button>
        <button
          type="button"
          aria-label={`Hide the install ${appName} button`}
          onClick={() => {
            safe(() => sessionStorage.setItem(PILL_HIDDEN_KEY, "1"), undefined);
            setPillHidden(true);
          }}
          style={{ border: 0, background: "rgba(255,255,255,.18)", color: "#fff", width: 28, height: 28, borderRadius: 999, cursor: "pointer", fontSize: 14, lineHeight: "28px" }}
        >
          ×
        </button>
      </div>
    );
  }

  const close = () => {
    safe(() => sessionStorage.removeItem(FORCED_KEY), undefined);
    setClosedThisLoad(true);
    setOpen(false);
  };
  const notNow = () => {
    // Until the browser is reopened; the corner button stays available.
    safe(() => sessionStorage.setItem(DISMISS_KEY, "1"), undefined);
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
        notifyInstaller("installed", returnUrl);
        if (returnUrl) setDone(true);
        else close();
      }
    } finally {
      setBusy(false);
      emit();
    }
  };

  /**
   * Back to the installer: when it opened this tab, report and close (the
   * installer tab is right behind); otherwise navigate there.
   */
  const backToInstaller = (status: InstallReport) => (e: React.MouseEvent) => {
    if (!returnUrl) return;
    const reported = notifyInstaller(status, returnUrl);
    if (reported) {
      e.preventDefault();
      safe(() => (window.opener as Window).focus(), undefined);
      window.close();
    }
  };

  /**
   * "Open the app": a real link click. Chrome's navigation capturing sends a
   * user-clicked link into an installed app's window (window.open and
   * redirects are never captured), then this browser tab can go.
   */
  const openUrl = safe(() => new URL(startPath, window.location.origin).toString(), "/");
  const openApp = () => {
    notifyInstaller(done ? "installed" : "already", returnUrl);
    safe(() => sessionStorage.removeItem(FORCED_KEY), undefined);
    window.setTimeout(() => {
      window.close();
      // Not closable (opened by the person, not by a script): tidy up.
      setOpen(false);
    }, 600);
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

        {done || already ? (
          <>
            <h2 id="nga-install-title" style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: 1.25 }}>
              {appName} is installed
            </h2>
            <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.5, color: muted }}>
              Open it in its own window — no browser tabs. If it opens here instead, use “Open in app” in the address bar.
            </p>
            <a href={openUrl} target="_blank" rel="noopener" onClick={openApp} autoFocus style={button(true)}>
              Open the {appName} app
            </a>
            {returnUrl ? (
              <a href={returnUrl} onClick={backToInstaller(done ? "installed" : "already")} style={button(false)}>
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
                {busy ? "Waiting for your browser…" : `Install & open ${appName}`}
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
              <a href={skipReturnUrl(returnUrl)} onClick={backToInstaller("skipped")} style={button(false)}>
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
