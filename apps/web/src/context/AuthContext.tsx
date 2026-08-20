import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { SessionUser } from '@tupo/shared';
import { SESSION_KEY, USER_KEY, PERMISSIONS_KEY, ROLE_PERMISSIONS_KEY, clearSession } from '../lib/api';

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
  const [theme, setTheme] = useState<Theme>('light');

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
        const saved = (localStorage.getItem('tupo_theme') ?? parsed.preferredTheme ?? 'light') as Theme;
        setTheme(saved);
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
    localStorage.setItem('tupo_theme', theme);
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
    if (newUser.preferredTheme) setTheme(newUser.preferredTheme);
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

  return (
    <AuthContext.Provider value={{
      isAuthenticated: !!token, user, token, permissions, rolePermissions, roleName, loading,
      signIn, setSession, signOut, refreshPermissions, theme,
      toggleTheme: () => setTheme((t) => (t === 'light' ? 'dark' : 'light')),
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
