import crypto from "crypto";
import jwt from "jsonwebtoken";

/**
 * Verifying MIS single-sign-out requests -- OpenID Connect Back-Channel
 * Logout 1.0 (https://openid.net/specs/openid-connect-backchannel-1_0.html).
 *
 * When someone signs out of NGA MIS, MIS POSTs `logout_token=<JWT>` (RS256)
 * to this app. We verify it against MIS's published keys
 * (<NGA_MIS_BASE_URL>/.well-known/jwks.json) and the caller ends every
 * session of that MIS user.
 *
 * Framework-agnostic on purpose: the same file lives in Task Mentor, Tendo
 * and Tupo (nga_central_mis/docs/SINGLE_SIGN_OUT.md). Keep the copies identical.
 */

export const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

export interface LogoutVerifierConfig {
  /** MIS API origin, e.g. https://api.amashuri.com (also the expected `iss`). */
  misBaseUrl: string;
  /** This app's SSO client id (the expected `aud`). */
  clientId: string;
}

type Jwk = crypto.JsonWebKey & { kid?: string };
type FetchJwks = (url: string) => Promise<{ keys: Jwk[] }>;

const defaultFetchJwks: FetchJwks = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
  return (await res.json()) as { keys: Jwk[] };
};
let fetchJwks: FetchJwks = defaultFetchJwks;
/** Test hook. */
export const setJwksFetcher = (fn: FetchJwks | null) => {
  fetchJwks = fn ?? defaultFetchJwks;
  keyCache = null;
  lastForcedRefresh = 0;
};

let keyCache: { at: number; keys: Map<string, crypto.KeyObject> } | null = null;
let lastForcedRefresh = 0;
const KEY_TTL_MS = 3_600_000;

const loadKeys = async (misBaseUrl: string, force = false) => {
  const now = Date.now();
  if (!force && keyCache && now - keyCache.at < KEY_TTL_MS) return keyCache.keys;
  const { keys } = await fetchJwks(`${misBaseUrl.replace(/\/$/, "")}/.well-known/jwks.json`);
  const map = new Map<string, crypto.KeyObject>();
  for (const jwk of keys || []) {
    if (jwk.kty === "RSA" && jwk.kid) map.set(jwk.kid, crypto.createPublicKey({ key: jwk as any, format: "jwk" }));
  }
  keyCache = { at: now, keys: map };
  return map;
};

const keyFor = async (misBaseUrl: string, kid: string) => {
  let key = (await loadKeys(misBaseUrl)).get(kid);
  // Unknown key id: MIS may have rotated -- refetch, at most once a minute.
  if (!key && Date.now() - lastForcedRefresh > 60_000) {
    lastForcedRefresh = Date.now();
    key = (await loadKeys(misBaseUrl, true)).get(kid);
  }
  return key ?? null;
};

// Replay protection: a logout token is accepted once.
const seenJti = new Map<string, number>();
const rememberJti = (jti: string, until: number) => {
  const now = Date.now();
  for (const [k, exp] of seenJti) if (exp < now) seenJti.delete(k);
  if (seenJti.has(jti)) return false;
  seenJti.set(jti, until);
  return true;
};

export class LogoutTokenError extends Error {}

/**
 * Validate a logout token per spec section 2.6. Returns the MIS user id
 * (`sub`) whose sessions must end. Throws LogoutTokenError when invalid.
 */
export const verifyLogoutToken = async (token: unknown, cfg: LogoutVerifierConfig): Promise<string> => {
  if (typeof token !== "string" || token.split(".").length !== 3) throw new LogoutTokenError("missing logout_token");
  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"));
  } catch {
    throw new LogoutTokenError("malformed logout_token");
  }
  if (header.alg !== "RS256" || !header.kid) throw new LogoutTokenError("unexpected signing algorithm");
  const key = await keyFor(cfg.misBaseUrl, header.kid);
  if (!key) throw new LogoutTokenError("unknown signing key");

  let claims: any;
  try {
    claims = jwt.verify(token, key, {
      algorithms: ["RS256"],
      issuer: cfg.misBaseUrl.replace(/\/$/, ""),
      audience: cfg.clientId,
      clockTolerance: 60,
    });
  } catch (e: any) {
    throw new LogoutTokenError(`invalid logout_token: ${e?.message || e}`);
  }
  if (!claims.events || typeof claims.events !== "object" || !(LOGOUT_EVENT in claims.events)) {
    throw new LogoutTokenError("not a logout event");
  }
  if (claims.nonce !== undefined) throw new LogoutTokenError("logout_token must not carry a nonce");
  if (!claims.sub) throw new LogoutTokenError("logout_token has no subject");
  if (!claims.jti || !rememberJti(String(claims.jti), (Number(claims.exp) || 0) * 1000 + 120_000)) {
    throw new LogoutTokenError("logout_token already used");
  }
  return String(claims.sub);
};

/**
 * Was this app token issued before the user's sessions were ended?
 * `iatSeconds` is the token's `iat` (whole seconds); `revokedAt` when the
 * sessions were ended (ms). A token stamped with the same second as the
 * revocation might predate it, so it counts as revoked (the safe side); any
 * later second is a sign-in after the sign-out and stays valid.
 */
export const issuedBeforeRevocation = (iatSeconds: number | undefined, revokedAt: Date | number | null | undefined) => {
  if (!revokedAt) return false;
  const revokedMs = revokedAt instanceof Date ? revokedAt.getTime() : Number(revokedAt);
  if (!Number.isFinite(revokedMs)) return false;
  if (!iatSeconds) return true; // a token without iat can't prove it's newer
  return iatSeconds * 1000 <= revokedMs;
};
