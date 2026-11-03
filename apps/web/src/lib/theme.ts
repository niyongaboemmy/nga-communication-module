export type Theme = 'light' | 'dark';
/** What the person picked: a fixed theme, or whatever the device is set to (F-10). */
export type ThemeMode = Theme | 'system';

/**
 * Read by the inline boot script in index.html as well as by AuthContext, so
 * the key is fixed in both places — change one and you must change the other.
 */
export const THEME_KEY = 'tupo_theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** What the device asks for right now. */
export function systemTheme(): Theme {
  try {
    return window.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** The saved pick; "system" when there is none. */
export function readStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch { /* storage blocked */ }
  return 'system';
}

/** Has this browser ever had a pick saved? */
export function hasStoredMode(): boolean {
  try { return localStorage.getItem(THEME_KEY) !== null; } catch { return false; }
}

export const resolveTheme = (mode: ThemeMode): Theme => (mode === 'system' ? systemTheme() : mode);

/**
 * Saves the pick, not the colour on screen. Saving the resolved colour is what
 * froze the theme: a first visit wrote the device's colour as if it had been
 * chosen, so a later change of the device setting was never followed.
 */
export function storeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // Storage blocked (private mode, embedded webview). The theme still holds
    // for this tab; it just won't survive a reload.
  }
}

/** Follow the device setting while it changes. */
export function onSystemThemeChange(fn: (t: Theme) => void): () => void {
  try {
    const mq = window.matchMedia(DARK_QUERY);
    const handler = () => fn(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  } catch {
    return () => {};
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
