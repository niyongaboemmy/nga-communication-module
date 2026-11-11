import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import type { SessionUser } from '@tupo/shared';
import {
  SESSION_KEY, USER_KEY, PERMISSIONS_KEY, ROLE_PERMISSIONS_KEY, clearSession, apiGet, apiPatch,
} from '../lib/api';
import {
  THEME_KEY, hasStoredMode, onSystemThemeChange, patchCachedUserTheme, readStoredMode, resolveTheme,
  storeMode, systemTheme, type ThemeMode,
} from '../lib/theme';
import { beginSsoState } from '../lib/ssoState';
import { endActivity } from '../activity';
import { setCacheOwner } from '../lib/localStore';
import { storageOwner, tidOfToken } from '../lib/tenant';
import { setSwSessionToken } from '../lib/swSession';

type Theme = 'light' | 'dark';

interface AuthContextValue {
  isAuthenticated: boolean;
  user: SessionUser | null;
  token: string | null;
  /** MIS-native permission strings. Informational only — never used to gate
   *  anything in Tupo. Do not confuse with `rolePermissions`. */
  permissions: string[];
  /** Tupo's own RBAC permission keys for the signed-in user's role.
   *  This is what `usePermissions()` reads. */
  rolePermissions: string[];
  roleName: string | null;
  loading: boolean;
  /** Sends the user to the MIS. This is the ONLY way to sign in to Tupo. */
  signIn: () => void;
  setSession: (
    token: string, user: SessionUser, permissions: string[],
    rolePermissions: string[], roleName: string | null
  ) => void;
  /** Re-read the caller's role and permissions without a re-login, so an
   *  administrator's change lands on the next page view. */
  refreshPermissions: () => Promise<void>;
  signOut: () => void;
  /** The colour on screen. */
  theme: Theme;
  /** What the person picked: light, dark, or follow the device (F-10). */
  themeMode: ThemeMode;
  /** Set the appearance and persist it — locally at once, then up to the MIS
   *  so every NGA app follows. */
  setTheme: (theme: Theme) => void;
  /** Light, dark or system. "System" stays on this device: the MIS has no word for it. */
  setThemeMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState<string | null>(null);
  // The service worker acts on notifications with this session (N-03).
  useEffect(() => { void setSwSessionToken(token); }, [token]);
  const [user, setUser] = useState<SessionUser | null>(null);
  // The on-device cache is per account (P-02). Set during render, not in an
  // effect, so providers' first reads already go to the right database.
  // Keyed by school too (tupo-cache-<tid>-<userId>): ids repeat across tenants' MIS.
  setCacheOwner(storageOwner(user?.id, tidOfToken(token)));
  const [permissions, setPermissions] = useState<string[]>([]);
  const [rolePermissions, setRolePermissions] = useState<string[]>([]);
  const [roleName, setRoleName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Initialised straight from storage rather than in an effect: starting at
  // 'light' and correcting later would write 'light' over the user's saved
  // choice on every reload, which is exactly why the theme never stuck.
  const [themeMode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [deviceTheme, setDeviceTheme] = useState<Theme>(systemTheme);
  const theme: Theme = themeMode === 'system' ? deviceTheme : themeMode;
  // Read inside callbacks registered once.
  const modeRef = useRef(themeMode);
  modeRef.current = themeMode;
  /** A fixed theme from elsewhere (the MIS, the desktop app) — never over "system". */
  const adoptRemote = useCallback((remote: Theme) => {
    if (modeRef.current === 'system') return;
    setModeState(remote);
    patchCachedUserTheme(USER_KEY, remote);
  }, []);
  /** When the MIS was last consulted about the theme. Also bumped on a local
   *  change, so a pull cannot race an in-flight save and undo it. */
  const lastPull = useRef(0);

  useEffect(() => {
    const savedToken = localStorage.getItem(SESSION_KEY);
    const savedUser = localStorage.getItem(USER_KEY);
    if (savedToken && savedUser) {
      try {
        const parsed = JSON.parse(savedUser) as SessionUser;
        setToken(savedToken);
        setUser(parsed);
        setPermissions(JSON.parse(localStorage.getItem(PERMISSIONS_KEY) ?? '[]'));
        const savedRole = JSON.parse(localStorage.getItem(ROLE_PERMISSIONS_KEY) ?? '{"keys":[],"name":null}');
        setRolePermissions(savedRole.keys ?? []);
        setRoleName(savedRole.name ?? null);
        // Nothing to restore for the theme: it was read from storage before
        // the first render. Only adopt the session's copy when this browser
        // has no saved choice of its own.
        if (!hasStoredMode() && parsed.preferredTheme) {
          setModeState(parsed.preferredTheme);
        }
      } catch {
        // Corrupt storage is not a recoverable session — start clean.
        clearSession();
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // The `.dark` class is what drives Tailwind's dark: variant here, matching
    // the MIS's `darkMode: "class"` so the two apps theme identically.
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);
  useEffect(() => { storeMode(themeMode); }, [themeMode]);
  // "System" follows the device as it changes (sunset, a manual switch).
  useEffect(() => onSystemThemeChange(setDeviceTheme), []);
  // A pick made in another tab applies here too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_KEY && e.newValue) setModeState(readStoredMode());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const signOut = useCallback(() => {
    // Tell usage analytics this tab's session is over while the token that
    // identifies it still exists (it is read synchronously, before the clear).
    void endActivity();
    // Nothing queued offline survives a sign-out to be sent as someone else.
    void import('../pages/chat/outbox').then((o) => o.clearAll()).catch(() => {});
    const finish = () => {
      clearSession();
      setToken(null);
      setUser(null);
      setPermissions([]);
      setRolePermissions([]);
      setRoleName(null);
      window.location.href = '/';
    };
    // This device stops receiving pushes for this person (F-04) — asked while
    // the session that may do so still exists, but never holding up sign-out.
    void Promise.race([
      import('../lib/push').then((p) => p.disablePush()).catch(() => undefined),
      new Promise((r) => setTimeout(r, 1500)),
    ]).finally(finish);
  }, []);

  /**
   * Tupo's session is self-contained for its full 24h life, so logging out of
   * the MIS would otherwise leave this app open. The MIS tells our API
   * directly (back-channel logout), which also drops open sockets; this check
   * is the backstop -- on load, whenever the tab comes back into view, and
   * every minute -- so switching accounts in the MIS never leaves this tab
   * signed in as the previous person.
   */
  useEffect(() => {
    if (!token) return;
    let last = 0;
    const check = async () => {
      if (Date.now() - last < 5000) return;
      last = Date.now();
      try {
        const res = await fetch('/api/sso/verify-mis', { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 401) {
          signOut();
          return;
        }
        // The poll carries the central NGA profile picture: a change made in MIS
        // (or another NGA app) reaches the shell, feed and chat within a minute.
        const body = (await res.json().catch(() => null)) as { data?: { avatarUrl?: string | null } } | null;
        const polled = body?.data?.avatarUrl;
        if (polled !== undefined) {
          setUser((prev) => {
            if (!prev || (prev.avatarUrl ?? null) === polled) return prev;
            const next = { ...prev, avatarUrl: polled ?? undefined };
            localStorage.setItem(USER_KEY, JSON.stringify(next));
            return next;
          });
        }
      } catch {
        // A network blip is not a logout; the next poll settles it.
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    void check();
    const id = setInterval(check, 60 * 1000);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [token, signOut]);


  const signIn = useCallback(() => {
    const clientId = import.meta.env.VITE_SSO_CLIENT_ID;
    const loginUrl = import.meta.env.VITE_MIS_LOGIN_URL;
    const redirectUri = `${window.location.origin}/sso/callback`;
    // `state` is the OAuth CSRF token: the MIS echoes it back to /sso/callback,
    // which checks it against the copy kept in this tab's sessionStorage.
    const state = beginSsoState();
    window.location.href =
      `${loginUrl}?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;
  }, []);

  const setSession = useCallback((
    newToken: string, newUser: SessionUser, perms: string[],
    rolePerms: string[], newRoleName: string | null
  ) => {
    localStorage.setItem(SESSION_KEY, newToken);
    localStorage.setItem(USER_KEY, JSON.stringify(newUser));
    localStorage.setItem(PERMISSIONS_KEY, JSON.stringify(perms));
    localStorage.setItem(ROLE_PERMISSIONS_KEY, JSON.stringify({ keys: rolePerms, name: newRoleName }));
    setToken(newToken);
    setUser(newUser);
    setPermissions(perms);
    setRolePermissions(rolePerms);
    setRoleName(newRoleName);
    // The MIS is the source of truth for appearance, so a fresh sign-in adopts
    // whatever it says — that is how a change made in the MIS or a sibling app
    // reaches this browser.
    if (newUser.preferredTheme) adoptRemote(newUser.preferredTheme);
  }, [adoptRemote]);

  const refreshPermissions = useCallback(async () => {
    try {
      const res = await fetch('/api/roles-permissions/me', {
        headers: { Authorization: `Bearer ${localStorage.getItem(SESSION_KEY)}` },
      });
      if (!res.ok) return;
      const body = await res.json();
      const keys: string[] = body.data?.permissionKeys ?? [];
      const name: string | null = body.data?.roleName ?? null;
      localStorage.setItem(ROLE_PERMISSIONS_KEY, JSON.stringify({ keys, name }));
      setRolePermissions(keys);
      setRoleName(name);
    } catch {
      // Offline or a transient failure — keep the cached set rather than
      // stripping the user's UI down to nothing.
    }
  }, []);

  // Re-read the caller's permissions whenever a session appears, so an
  // administrator's role change lands without waiting for a re-login.
  useEffect(() => {
    if (token) void refreshPermissions();
  }, [token, refreshPermissions]);

  /*
   * One identity across tabs (F-08). localStorage is shared by every tab, so:
   *   - the session removed elsewhere (sign-out in another tab) → this tab is
   *     signed out too, instead of carrying on as a ghost;
   *   - a different person signed in elsewhere → this tab restarts as them,
   *     never a page showing one person's data under another's session;
   *   - the same person's refreshed token → just picked up.
   */
  useEffect(() => {
    const subjectOf = (jwtToken: string | null): string | null => {
      try { return jwtToken ? JSON.parse(atob(jwtToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))).id ?? null : null; }
      catch { return null; }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SESSION_KEY && e.key !== null) return;
      const next = localStorage.getItem(SESSION_KEY);
      if (!next) {
        if (!token) return;
        setToken(null); setUser(null); setPermissions([]); setRolePermissions([]); setRoleName(null);
        window.location.href = '/';
        return;
      }
      if (next === token) return;
      if (token && subjectOf(next) !== subjectOf(token)) { window.location.reload(); return; }
      setToken(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [token]);

  /*
   * And while signed in (F-07): when an administrator changes this person's
   * role or what their role allows, the server says so over the socket; as a
   * backstop, the set is re-read when the tab comes back into view (at most
   * every 30 s). Menus, routes and buttons update without a reload.
   */
  useEffect(() => {
    if (!token) return;
    let last = Date.now();
    const maybe = () => {
      if (document.hidden || Date.now() - last < 30_000) return;
      last = Date.now();
      void refreshPermissions();
    };
    document.addEventListener('visibilitychange', maybe);
    window.addEventListener('focus', maybe);
    let off: (() => void) | undefined;
    void import('../lib/socket').then(({ onSocket }) => {
      off = onSocket('access:changed', () => { last = Date.now(); void refreshPermissions(); });
    });
    return () => {
      document.removeEventListener('visibilitychange', maybe);
      window.removeEventListener('focus', maybe);
      off?.();
    };
  }, [token, refreshPermissions]);

  /**
   * A theme the user picked here. Saved locally first so the UI is instant and
   * survives a reload even when offline, then pushed to the MIS
   * (`PATCH /users/me/theme` behind our own API) so TaskMentor, Discipline &
   * Attendance and the MIS itself all follow. A failed push is deliberately
   * silent — the choice is already saved, and the next sign-in reconciles.
   */
  const setTheme = useCallback((next: Theme) => {
    lastPull.current = Date.now();
    setModeState(next);
    patchCachedUserTheme(USER_KEY, next);
    setUser((u) => (u ? { ...u, preferredTheme: next } : u));

    if (!localStorage.getItem(SESSION_KEY)) return;
    void apiPatch('/api/users/me/theme', { theme: next }).catch(() => {
      // Offline, or the MIS is down. Nothing to undo.
    });
  }, []);

  /**
   * NGA desktop app: it keeps the desktop and all four NGA apps on one theme.
   * A switch made elsewhere arrives here, and the MIS account already has it,
   * so apply it locally without pushing it again (and hold off the next pull,
   * like a local change). preventDefault tells the desktop this app applied it.
   */
  useEffect(() => {
    const onDesktopTheme = (e: Event) => {
      const next = (e as CustomEvent<{ theme?: string }>).detail?.theme;
      if (next !== 'light' && next !== 'dark') return;
      e.preventDefault();
      lastPull.current = Date.now();
      // The desktop app sets a theme explicitly, so it replaces "system" too.
      setModeState(next);
      patchCachedUserTheme(USER_KEY, next);
      setUser((u) => (u ? { ...u, preferredTheme: next } : u));
    };
    window.addEventListener('nga:set-theme', onDesktopTheme);
    return () => window.removeEventListener('nga:set-theme', onDesktopTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(resolveTheme(modeRef.current) === 'light' ? 'dark' : 'light');
  }, [setTheme]);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    if (mode === 'system') { lastPull.current = Date.now(); setModeState('system'); return; }
    setTheme(mode);
  }, [setTheme]);

  /**
   * Pull the MIS's copy back down, so a theme changed in the MIS or a sibling
   * app lands here without a re-login. Runs when a session appears and again
   * when the tab is brought back to the foreground — throttled, because the
   * backend has to ask the MIS to answer it.
   */
  useEffect(() => {
    if (!token) return;

    const pull = async () => {
      if (Date.now() - lastPull.current < 60_000) return;
      lastPull.current = Date.now();
      try {
        const body = await apiGet<{ theme: Theme }>('/api/users/me/theme');
        const remote = body.data?.theme;
        if (remote === 'light' || remote === 'dark') adoptRemote(remote);
      } catch {
        // Keep whatever is on screen; the MIS is the source of truth but not
        // a reason to break the UI when it is unreachable.
      }
    };

    void pull();
    const onFocus = () => { if (document.visibilityState === 'visible') void pull(); };
    document.addEventListener('visibilitychange', onFocus);
    return () => document.removeEventListener('visibilitychange', onFocus);
  }, [token]);

  return (
    <AuthContext.Provider value={{
      isAuthenticated: !!token, user, token, permissions, rolePermissions, roleName, loading,
      signIn, setSession, signOut, refreshPermissions, theme, themeMode, setTheme, setThemeMode, toggleTheme,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
