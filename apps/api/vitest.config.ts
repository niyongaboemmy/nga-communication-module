import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./src/__tests__/globalSetup.ts'],
    // Suites create content in bursts; rateLimit.test.ts switches limits back on.
    // No job queue: background work falls back to running inline against the
    // test database instead of landing on a dev worker reading tupo_dev.
    env: { RATE_LIMITS: 'off', JOB_QUEUE: 'off' },
    // A handful of suites are timing-sensitive across files (shared Redis
    // caches and rate windows) and fail intermittently — they did before the
    // remediation work too. CI retries a failing test up to twice so a deploy
    // is not decided by a race; local runs stay strict so the flakiness stays
    // visible until it is fixed (docs/REMEDIATION_DELIVERY_PLAN.md §15).
    retry: process.env.CI ? 2 : 0,
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
