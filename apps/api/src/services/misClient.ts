import { config } from '../config.js';

export interface MisTokenResponse {
  success: boolean;
  message?: string;
  data?: {
    token: string;
    user: Record<string, unknown>;
    permissions?: string[];
  };
}

/**
 * Exchange an SSO authorization code for a MIS token.
 * This is the only place the client secret is ever used, and it only ever
 * runs server-side — the secret must never reach the browser.
 */
export async function exchangeCode(code: string): Promise<{ status: number; body: MisTokenResponse }> {
  const response = await fetch(`${config.misBaseUrl}/sso/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      client_id: config.ssoClientId,
      client_secret: config.ssoClientSecret,
    }),
  });
  return { status: response.status, body: (await response.json()) as MisTokenResponse };
}

/**
 * Hydrate the full profile (SRS FR-AUTH-2). Returns null instead of throwing:
 * a slow or unreachable MIS must degrade the login, not fail it — the caller
 * falls back to the minimal payload from the token exchange.
 */
export async function fetchMe(misToken: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${config.misBaseUrl}/users/me`, {
      headers: { Authorization: `Bearer ${misToken}` },
    });
    const result = (await response.json()) as { success?: boolean; data?: Record<string, unknown> };
    if (!response.ok || !result.success) return null;
    return result.data ?? null;
  } catch {
    return null;
  }
}

/** Is this MIS session still alive? Used by the /verify-mis poll. */
export async function verifyMisSession(misToken: string): Promise<'valid' | 'invalid' | 'unreachable'> {
  try {
    const response = await fetch(`${config.misBaseUrl}/auth/verify`, {
      headers: { Authorization: `Bearer ${misToken}` },
    });
    return response.ok ? 'valid' : 'invalid';
  } catch {
    return 'unreachable';
  }
}

/**
 * Push the user's appearance choice back to the MIS so every NGA app agrees
 * on it — `PATCH /users/me/theme`, the same endpoint TaskMentor proxies to.
 *
 * Returns false rather than throwing: the MIS being slow or down must not stop
 * a user from switching to dark mode. Tupo's own copy is already saved by the
 * time this runs, and the next login re-reads the MIS anyway.
 */
export async function updateMisTheme(misToken: string, theme: 'light' | 'dark'): Promise<boolean> {
  try {
    const response = await fetch(`${config.misBaseUrl}/users/me/theme`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${misToken}` },
      body: JSON.stringify({ theme }),
    });
    if (!response.ok) {
      console.warn('[mis] theme sync rejected:', response.status);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[mis] theme sync unreachable:', err);
    return false;
  }
}

/**
 * Read the MIS's copy of the appearance preference. The MIS is the source of
 * truth across the app family, so this is what a change made in the MIS (or in
 * a sibling app) looks like from here. Null means "MIS could not tell us" —
 * the caller falls back to Tupo's stored value rather than flipping the UI.
 */
export async function fetchMisTheme(misToken: string): Promise<'light' | 'dark' | null> {
  const me = await fetchMe(misToken);
  const user = (me?.user ?? {}) as Record<string, unknown>;
  const theme = user.preferred_theme;
  return theme === 'light' || theme === 'dark' ? theme : null;
}
