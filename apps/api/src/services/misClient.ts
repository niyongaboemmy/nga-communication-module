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

/**
 * The user's central NGA profile picture (256 px) from a MIS payload -- /sso/token,
 * /users/me or /auth/verify. null = MIS says there is none; undefined = this payload
 * says nothing about pictures (an older MIS), so keep what we have.
 */
export function misAvatarUrl(data: unknown): string | null | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as { avatar?: { md?: unknown } | null; user?: { avatar_url?: unknown } };
  const valid = (u: unknown) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u : null);
  if (d.avatar !== undefined) return d.avatar ? valid(d.avatar.md) : null;
  if (d.user && d.user.avatar_url !== undefined) return valid(d.user.avatar_url);
  return undefined;
}

/** Is this MIS session still alive? Used by the /verify-mis poll. */
export async function verifyMisSession(misToken: string): Promise<'valid' | 'invalid' | 'unreachable'> {
  return (await verifyMisSessionDetailed(misToken)).state;
}

/**
 * Same as verifyMisSession, plus the user's current MIS `access_version`
 * (access control v2) when the MIS reports one — used to invalidate the
 * cached access snapshot.
 */
export async function verifyMisSessionDetailed(misToken: string): Promise<{
  state: 'valid' | 'invalid' | 'unreachable'; accessVersion: number | null;
  /** The current profile picture, when this MIS reports one (see misAvatarUrl). */
  avatarUrl?: string | null;
}> {
  try {
    // Bounded: a hung MIS must not hold the caller (the Home relay gives up
    // after ~8 s) open indefinitely. A timeout is "unreachable" below.
    const response = await fetch(`${config.misBaseUrl}/auth/verify`, {
      headers: { Authorization: `Bearer ${misToken}` },
      signal: AbortSignal.timeout(Number(process.env.MIS_VERIFY_TIMEOUT_MS) || 10_000),
    });
    if (!response.ok) return { state: 'invalid', accessVersion: null };
    let accessVersion: number | null = null;
    let avatarUrl: string | null | undefined;
    try {
      const body = (await response.json()) as { data?: { access_version?: unknown } };
      const v = Number(body?.data?.access_version);
      accessVersion = body?.data?.access_version != null && Number.isFinite(v) ? v : null;
      avatarUrl = misAvatarUrl(body?.data);
    } catch { /* older MIS / empty body: no version */ }
    return { state: 'valid', accessVersion, avatarUrl };
  } catch {
    return { state: 'unreachable', accessVersion: null };
  }
}

/**
 * Who does this MIS token belong to? Used by the server-to-server integration
 * routes, where the MIS token arrives on its own rather than inside a Tupo
 * session. Unlike verifyMisSessionDetailed, only a 400/401/403 is 'invalid'
 * here; any other failure is 'unreachable' — the caller answers 503, not
 * "your session ended".
 */
export async function verifyMisToken(misToken: string): Promise<{
  state: 'valid' | 'invalid' | 'unreachable'; userId: string | null; accessVersion: number | null;
}> {
  try {
    // Bounded: a hung MIS must not hold the caller (the Home relay gives up
    // after ~8 s) open indefinitely. A timeout is "unreachable" below.
    const response = await fetch(`${config.misBaseUrl}/auth/verify`, {
      headers: { Authorization: `Bearer ${misToken}` },
      signal: AbortSignal.timeout(Number(process.env.MIS_VERIFY_TIMEOUT_MS) || 10_000),
    });
    // Only an explicit rejection means "this token is no good". Anything else
    // that is not a 2xx — a 404 from a mis-set base URL, a 429, a 5xx — says
    // nothing about the token, so the caller answers 503 and caches nothing.
    if ([400, 401, 403].includes(response.status)) return { state: 'invalid', userId: null, accessVersion: null };
    if (!response.ok) return { state: 'unreachable', userId: null, accessVersion: null };
    let body: { data?: { userId?: unknown; access_version?: unknown } } | null;
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // A 200 that is not JSON is a proxy's error page, not the MIS answering.
      return { state: 'unreachable', userId: null, accessVersion: null };
    }
    const rawId = body?.data?.userId;
    // A 200 that names nobody (or names something that is not an id) cannot be
    // mapped to a user; treat it as invalid rather than stringify an object.
    const userId = typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0 ? String(rawId)
      : typeof rawId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(rawId) ? rawId
      : null;
    if (!userId) return { state: 'invalid', userId: null, accessVersion: null };
    const v = Number(body?.data?.access_version);
    const accessVersion = body?.data?.access_version != null && Number.isFinite(v) ? v : null;
    return { state: 'valid', userId, accessVersion };
  } catch {
    return { state: 'unreachable', userId: null, accessVersion: null };
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
