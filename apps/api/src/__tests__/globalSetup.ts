import { execSync } from 'node:child_process';

/**
 * Point the whole suite at a throwaway database and migrate it before any test
 * runs. Uses the real PostgreSQL rather than a mock so migrations, constraints
 * and the partitioned messages table are exercised for real.
 */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/tupo_test';
  process.env.DATABASE_URL = url;

  const dbName = url.split('/').pop()!;
  try {
    execSync(`psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'" | grep -q 1 || createdb ${dbName}`,
      { stdio: 'pipe', shell: '/bin/bash' });
  } catch {
    throw new Error(
      `Could not create the test database '${dbName}'. Is PostgreSQL running? ` +
      `Start it with: brew services start postgresql`
    );
  }
  execSync('npm run migrate -w @tupo/db', {
    cwd: new URL('../../../../', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
