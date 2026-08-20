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
