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
   * Bootstrap administrators. The MIS grants no Tupo-specific role, so these
   * allowlists let named accounts hold 'admin' here regardless of their MIS
   * permissions. This is an *elevation* of an already-MIS-authenticated user —
   * not a login path. No credential is stored.
   */
  adminUsernames: (process.env.ADMIN_USERNAMES ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  adminEmails: (process.env.ADMIN_EMAILS ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
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
