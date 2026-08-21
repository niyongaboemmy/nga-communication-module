export type Theme = 'light' | 'dark';

/**
 * Read by the inline boot script in index.html as well as by AuthContext, so
 * the key is fixed in both places — change one and you must change the other.
 */
export const THEME_KEY = 'tupo_theme';

/** The user's saved choice, or what their OS asks for if they have none. */
export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked (private mode, embedded webview). The theme still holds
    // for this tab; it just won't survive a reload.
  }
}

/** Keep the cached session user in step so a reload before the next login
 *  doesn't read back a stale preference. */
export function patchCachedUserTheme(userKey: string, theme: Theme): void {
  try {
    const raw = localStorage.getItem(userKey);
    if (!raw) return;
    localStorage.setItem(userKey, JSON.stringify({ ...JSON.parse(raw), preferredTheme: theme }));
  } catch {
    // A corrupt cache is the session loader's problem, not the theme's.
  }
}
