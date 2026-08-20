import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./src/__tests__/globalSetup.ts'],
    // Never run compiled output: dist holds a second copy of every test, and
    // running both in one process makes them fight over the global fetch stub.
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // The SSO suite mutates shared module state (the rate limiter) and a shared
    // test database, so files run in one process rather than racing each other.
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
  },
});
