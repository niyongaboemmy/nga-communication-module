import 'dotenv/config';

const DEFAULT_JWT_SECRET = 'local_dev_secret_change_in_production';

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '5192', 10),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/tupo_dev',
  jwtSecret: process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET,
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5194,http://127.0.0.1:5194')
    .split(',').map((o) => o.trim()).filter(Boolean),

  /** 'local' keeps development dependency-free; 'a3' is the production path. */
  storageDriver: (process.env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
  localStoragePath: process.env.LOCAL_STORAGE_PATH ?? './storage',
  maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_BYTES ?? '5368709120', 10),
  signedUrlTtlSeconds: parseInt(process.env.SIGNED_URL_TTL_SECONDS ?? '900', 10),
};

// apps/api refuses to boot on this same default in production (see its
// config.ts) — but this is a *separate* process with its own .env, so it can
// silently drift out of sync with the secret apps/api actually signed
// session tokens with. Left unguarded, every ticket mint / upload / download
// here 401s with no clue why: fail loudly at startup instead.
if (config.env === 'production' && config.jwtSecret === DEFAULT_JWT_SECRET) {
  throw new Error('JWT_SECRET is still the insecure default. Set a strong unique value before starting.');
}
