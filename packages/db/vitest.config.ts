import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Only ever test sources. dist holds a compiled copy of every test file,
  // which would otherwise double the reported test count.
  test: { include: ['src/**/*.test.ts'], exclude: ['**/node_modules/**', '**/dist/**'] },
});
