import 'dotenv/config';

const DEFAULT_JWT_SECRET = 'local_dev_secret_change_in_production';

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '5190', 10),

  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/tupo_dev',

  /** NGA Central MIS — the only source of identity for this app. */
  misBaseUrl: process.env.NGA_MIS_BASE_URL ?? 'https://mis.amashuri.com',
  ssoClientId: process.env.SSO_CLIENT_ID ?? 'tupo',
  ssoClientSecret: process.env.SSO_CLIENT_SECRET ?? 'placeholder_client_secret',

  jwtSecret: process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET,
  sessionTtl: process.env.SESSION_TTL ?? '24h',

  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5194,http://127.0.0.1:5194')
    .split(',').map((o) => o.trim()).filter(Boolean),

  /**
   * The SPA's public origin, for absolute links handed to other apps (the MIS
   * Home summary deep-links into Tupo). Defaults to the first CORS origin,
   * which is the SPA in every deployment we run.
   */
  appPublicUrl: (process.env.APP_PUBLIC_URL
    ?? (process.env.CORS_ORIGINS ?? 'http://localhost:5194').split(',')[0]!.trim())
    .replace(/\/+$/, ''),

  /**
   * Bootstrap administrators. The MIS grants no Tupo-specific role, so these
   * allowlists let named accounts hold 'admin' here regardless of their MIS
   * permissions. This is an *elevation* of an already-MIS-authenticated user —
   * not a login path. No credential is stored.
   */
  adminUsernames: (process.env.ADMIN_USERNAMES ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  adminEmails: (process.env.ADMIN_EMAILS ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  /* ---- Meet (SRS §10) ------------------------------------------------ *
   * All optional. With none of it set, Meet still works: meetings run on the
   * peer-to-peer transport with Google STUN, which is enough on an
   * unrestricted network and is what makes the module testable on a laptop. */

  /** Cloudflare Realtime TURN — the same credentials TaskMentor's proctoring
   *  module uses. Without TURN, WebRTC fails on any network that blocks UDP,
   *  which describes most school networks. */
  cloudflareTurnTokenId: process.env.CLOUDFLARE_TURN_TOKEN_ID ?? '',
  cloudflareTurnApiToken: process.env.CLOUDFLARE_TURN_API_TOKEN ?? '',

  /**
   * Cloudflare Realtime SFU — the media server Tupo uses.
   *
   * Create a Realtime app in the Cloudflare dashboard (Realtime → SFU) and
   * paste its App ID and secret. Unlike a self-hosted SFU there is nothing to
   * run: no container, no UDP port range, no TURN companion. Without these two
   * values meetings fall back to peer-to-peer and are capped at four people.
   */
  cloudflareRealtimeAppId: process.env.CLOUDFLARE_REALTIME_APP_ID ?? '',
  cloudflareRealtimeAppSecret: process.env.CLOUDFLARE_REALTIME_APP_SECRET ?? '',


  /** Where the realtime gateway lives, for server-initiated meeting events. */
  realtimeInternalUrl: process.env.REALTIME_INTERNAL_URL ?? 'http://127.0.0.1:5191',
  /** Shared secret for API → realtime calls. Defaults to the session secret so
   *  a single-secret dev setup works, but is separable in production. */
  realtimeInternalSecret: process.env.REALTIME_INTERNAL_SECRET ?? process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET,

  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0',
};

// Fail fast rather than sign production sessions with a public secret.
if (config.env === 'production') {
  if (config.jwtSecret === DEFAULT_JWT_SECRET) {
    throw new Error('JWT_SECRET is still the insecure default. Set a strong unique value before starting.');
  }
  if (config.ssoClientSecret === 'placeholder_client_secret') {
    throw new Error('SSO_CLIENT_SECRET is unset. Tupo cannot authenticate anyone without it.');
  }
}
