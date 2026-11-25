import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The API suite's global setup: points DATABASE_URL at TEST_DATABASE_URL
    // (default tupo_test) and migrates it.
    globalSetup: ['../api/src/__tests__/globalSetup.ts'],
    env: { TENANCY_REGISTRY_SOURCE: 'local' },
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 30_000,
  },
});
