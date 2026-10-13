import 'dotenv/config';

const DEFAULT_JWT_SECRET = 'local_dev_secret_change_in_production';

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '5191', 10),
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0',
  /** Must match apps/api — the realtime gateway verifies the very same session JWT. */
  jwtSecret: process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET,
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5194,http://127.0.0.1:5194')
    .split(',').map((o) => o.trim()).filter(Boolean),

  /** The /meet namespace writes captions, chat and participant state directly.
   *  Same database as the API — the gateway is a second reader/writer of the
   *  meeting tables, not a service with a store of its own. */
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/tupo_dev',
};

// Same rule as the API (RT-05): never verify production sessions against the
// public development secret — anyone could mint a token that passes.
if (config.env === 'production' && (!process.env.JWT_SECRET || config.jwtSecret === DEFAULT_JWT_SECRET)) {
  throw new Error('JWT_SECRET must be set to a private value in production.');
}
