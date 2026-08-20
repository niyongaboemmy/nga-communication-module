import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

let pool: pg.Pool | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export function getPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!pool) {
    if (!connectionString) {
      // Deliberately no default: silently connecting to a guessed database is
      // how a migration ends up running against the wrong environment.
      throw new Error(
        'DATABASE_URL is not set. For migrations/seeds set it in packages/db/.env ' +
        '(copy packages/db/.env.example); services read it from their own apps/*/.env.'
      );
    }
    pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  }
  return pool;
}

export function getDb() {
  if (!db) db = drizzle(getPool(), { schema });
  return db;
}

/** Used by health checks: a cheap round-trip that proves the pool is alive. */
export async function pingDb(): Promise<boolean> {
  const result = await getPool().query('SELECT 1 as ok');
  return result.rows[0]?.ok === 1;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

export { schema };
