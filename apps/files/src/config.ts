import 'dotenv/config';

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '5192', 10),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/tupo_dev',
  jwtSecret: process.env.JWT_SECRET ?? 'local_dev_secret_change_in_production',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5194,http://127.0.0.1:5194')
    .split(',').map((o) => o.trim()).filter(Boolean),

  /** 'local' keeps development dependency-free; 'a3' is the production path. */
  storageDriver: (process.env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
  localStoragePath: process.env.LOCAL_STORAGE_PATH ?? './storage',
  maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_BYTES ?? '5368709120', 10),
  signedUrlTtlSeconds: parseInt(process.env.SIGNED_URL_TTL_SECONDS ?? '900', 10),
};
