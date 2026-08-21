import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import type { SessionUser } from '@tupo/shared';
import {
  SESSION_KEY, USER_KEY, PERMISSIONS_KEY, ROLE_PERMISSIONS_KEY, clearSession, apiGet, apiPatch,
} from '../lib/api';
import { THEME_KEY, readStoredTheme, storeTheme, patchCachedUserTheme } from '../lib/theme';

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
  theme: Theme;
  /** Set the appearance and persist it — locally at once, then up to the MIS
   *  so every NGA app follows. */
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [rolePermissions, setRolePermissions] = useState<string[]>([]);
  const [roleName, setRoleName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Initialised straight from storage rather than in an effect: starting at
  // 'light' and correcting later would write 'light' over the user's saved
  // choice on every reload, which is exactly why the theme never stuck.
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
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
        if (!localStorage.getItem(THEME_KEY) && parsed.preferredTheme) {
          setThemeState(parsed.preferredTheme);
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
    storeTheme(theme);
  }, [theme]);

  const signOut = useCallback(() => {
    clearSession();
    setToken(null);
    setUser(null);
    setPermissions([]);
    setRolePermissions([]);
    setRoleName(null);
    window.location.href = '/';
  }, []);

  /**
   * Tupo's session is self-contained for its full 24h life, so logging out of
   * the MIS would otherwise leave this app open. Poll the MIS through our own
   * backend so a revoked MIS session ends this one too.
   */
  useEffect(() => {
    if (!token) return;
    const check = async () => {
      try {
        const res = await fetch('/api/sso/verify-mis', { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 401) signOut();
      } catch {
        // A network blip is not a logout; the next poll settles it.
      }
    };
    const id = setInterval(check, 3 * 60 * 1000);
    return () => clearInterval(id);
  }, [token, signOut]);


  const signIn = useCallback(() => {
    const clientId = import.meta.env.VITE_SSO_CLIENT_ID;
    const loginUrl = import.meta.env.VITE_MIS_LOGIN_URL;
    const redirectUri = `${window.location.origin}/sso/callback`;
    window.location.href =
      `${loginUrl}?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
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
    if (newUser.preferredTheme) {
      setThemeState(newUser.preferredTheme);
      storeTheme(newUser.preferredTheme);
    }
  }, []);

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

  /**
   * A theme the user picked here. Saved locally first so the UI is instant and
   * survives a reload even when offline, then pushed to the MIS
   * (`PATCH /users/me/theme` behind our own API) so TaskMentor, Discipline &
   * Attendance and the MIS itself all follow. A failed push is deliberately
   * silent — the choice is already saved, and the next sign-in reconciles.
   */
  const setTheme = useCallback((next: Theme) => {
    lastPull.current = Date.now();
    setThemeState(next);
    storeTheme(next);
    patchCachedUserTheme(USER_KEY, next);
    setUser((u) => (u ? { ...u, preferredTheme: next } : u));

    if (!localStorage.getItem(SESSION_KEY)) return;
    void apiPatch('/api/users/me/theme', { theme: next }).catch(() => {
      // Offline, or the MIS is down. Nothing to undo.
    });
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'light' ? 'dark' : 'light');
  }, [theme, setTheme]);

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
        if (remote === 'light' || remote === 'dark') {
          setThemeState(remote);
          storeTheme(remote);
          patchCachedUserTheme(USER_KEY, remote);
        }
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
      signIn, setSession, signOut, refreshPermissions, theme, setTheme, toggleTheme,
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
