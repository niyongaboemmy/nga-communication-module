import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Opening another NGA app from this app's launcher so it lands in its
 * *installed* app window (and asks to be installed when it isn't).
 *
 * Chrome (139+ desktop; Android via WebAPK) sends a navigation into an
 * installed web app only for a real link that opens a new top-level page --
 * `<a target="_blank" rel="noopener">` -- never for a scripted
 * `window.open()`. So launcher tiles are real links, and SSO codes are minted
 * *before* the click (single-use, ~5 min server lifetime, refreshed every 4
 * min and after each use). When this app itself runs as an installed app the
 * link also carries `nga_launch=app`, which makes the target app ask to be
 * installed straight away (src/pwa/ngaInstall.tsx).
 *
 * Identical copy in Task Mentor, Discipline & Attendance and Tupo; the MIS
 * equivalent is frontend/src/components/ui/appLaunch.ts. Docs:
 * nga_central_mis/docs/APP_LAUNCH.md.
 */

export interface LaunchSystem {
  system_id: number;
  client_id?: string | null;
  allowed_redirect_uris?: string | null;
  home_url?: string | null;
}

export type LaunchLink =
  | { status: "ready"; href: string }
  | { status: "error"; href: string }
  | { status: "pending" }
  | { status: "signed-out"; loginHref: string };

/** Mint an SSO code for `clientId` → `redirectUri` (this app's own endpoint). */
export type Authorize = (
  clientId: string,
  redirectUri: string,
  state: string,
) => Promise<{ code: string; state?: string } | null | void>;

export const CODE_REFRESH_MS = 4 * 60_000;

export const resolveRedirectUri = (system: LaunchSystem, origin: string): string | null => {
  const callbacks = system.allowed_redirect_uris
    ? system.allowed_redirect_uris.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  return callbacks.find((cb) => cb.startsWith(origin)) || callbacks[0] || system.home_url || null;
};

export const buildLaunchHref = (redirectUri: string, code: string, state?: string) => {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return url.toString();
};

export const runningAsInstalledApp = () =>
  typeof window !== "undefined" &&
  (Boolean((navigator as any).standalone) ||
    ["standalone", "window-controls-overlay", "fullscreen", "minimal-ui"].some(
      (m) => window.matchMedia?.(`(display-mode: ${m})`).matches,
    ));

/** Add `nga_launch=app` when this app runs installed, so the target offers to install. */
export const withLaunchMarker = (href: string, installedApp = runningAsInstalledApp()) => {
  if (!installedApp) return href;
  try {
    const url = new URL(href, window.location.href);
    url.searchParams.set("nga_launch", "app");
    return url.toString();
  } catch {
    return href;
  }
};

const newState = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Launch links for `systems`, kept fresh while `active` (menu open).
 * Without `authorize` (or for systems with no client_id) tiles link straight
 * to the app, which then runs its own sign-in.
 */
export const useLaunchLinks = (
  systems: LaunchSystem[],
  active: boolean,
  authorize?: Authorize,
  loginHrefFor?: (system: LaunchSystem, redirectUri: string, state: string) => string | null,
) => {
  const [links, setLinks] = useState<Record<number, LaunchLink>>({});
  const alive = useRef(true);
  const authorizeRef = useRef(authorize);
  authorizeRef.current = authorize;
  const loginRef = useRef(loginHrefFor);
  loginRef.current = loginHrefFor;

  const mint = useCallback(async (system: LaunchSystem) => {
    const redirectUri = resolveRedirectUri(system, window.location.origin);
    if (!redirectUri) return;
    const auth = authorizeRef.current;
    if (!system.client_id || !auth) {
      setLinks((l) => ({ ...l, [system.system_id]: { status: "ready", href: withLaunchMarker(redirectUri) } }));
      return;
    }
    const state = newState();
    setLinks((l) => (l[system.system_id]?.status === "ready" ? l : { ...l, [system.system_id]: { status: "pending" } }));
    try {
      const result = await auth(system.client_id, redirectUri, state);
      if (!alive.current) return;
      const link: LaunchLink =
        result && result.code
          ? { status: "ready", href: withLaunchMarker(buildLaunchHref(redirectUri, result.code, result.state)) }
          : { status: "error", href: withLaunchMarker(redirectUri) };
      setLinks((l) => ({ ...l, [system.system_id]: link }));
    } catch (error: any) {
      if (!alive.current) return;
      const loginHref = error?.response?.status === 401 ? loginRef.current?.(system, redirectUri, state) : null;
      const link: LaunchLink = loginHref
        ? { status: "signed-out", loginHref }
        : { status: "error", href: withLaunchMarker(redirectUri) };
      setLinks((l) => ({ ...l, [system.system_id]: link }));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const key = systems.map((s) => s.system_id).join(",");
  useEffect(() => {
    if (!active || systems.length === 0) return;
    systems.forEach((s) => void mint(s));
    const timer = window.setInterval(() => systems.forEach((s) => void mint(s)), CODE_REFRESH_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, mint]);

  /**
   * Props for a tile. `onLaunched` runs after the browser followed the link
   * (e.g. close the menu); closing *during* the click would detach the link
   * before it can navigate.
   */
  const tileProps = (system: LaunchSystem, onLaunched?: () => void) => {
    const link = links[system.system_id];
    const after = () => window.setTimeout(() => onLaunched?.(), 0);
    if (link?.status === "ready" || link?.status === "error") {
      return {
        href: link.href,
        target: "_blank",
        rel: "noopener noreferrer",
        onClick: () => {
          // The code is single-use: mint the next one once this click is done.
          if (system.client_id && authorizeRef.current) window.setTimeout(() => void mint(system), 500);
          after();
        },
      };
    }
    if (link?.status === "signed-out") return { href: link.loginHref, onClick: after };
    // Code still being minted: open the app's home page (never the bare
    // callback, which shows "no code" errors); the app signs in by itself.
    const fallback = system.home_url || resolveRedirectUri(system, window.location.origin);
    return {
      href: fallback ? withLaunchMarker(fallback) : undefined,
      target: "_blank",
      rel: "noopener noreferrer",
      "aria-busy": true as const,
      onClick: after,
    };
  };

  return { links, tileProps };
};

/** Props for a plain link to another NGA app (e.g. "Back to MIS"). */
export const appLinkProps = (href: string, onLaunched?: () => void) => ({
  href: withLaunchMarker(href),
  target: "_blank",
  rel: "noopener noreferrer",
  onClick: () => window.setTimeout(() => onLaunched?.(), 0),
});
