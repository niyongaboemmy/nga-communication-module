import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWithoutTenant } from '@tupo/tenancy';
import { getPool, closeDb } from './pool.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Forward-only migration runner. Each file runs once, inside a transaction,
 * and is recorded in _migrations — so `npm run db:migrate` is safe to run on
 * every deploy and a partially applied file never half-lands.
 *
 * The exception is a file whose first line is `-- migrate:no-transaction`, for
 * statements Postgres refuses inside a transaction (CREATE INDEX
 * CONCURRENTLY, which builds an index without locking writes). Its statements
 * are separated by `-- statement-break` lines and run one by one; each must be
 * safe to re-run (IF NOT EXISTS), since a failure part-way is not rolled back.
 */
const NO_TRANSACTION = /^--\s*migrate:no-transaction/;
const STATEMENT_BREAK = /^--\s*statement-break\s*$/m;
async function migrate(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM _migrations')).rows.map((r) => r.name)
  );

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  ⏭  ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    if (NO_TRANSACTION.test(sql)) {
      try {
        for (const statement of sql.split(STATEMENT_BREAK).map((x) => x.trim()).filter(Boolean)) {
          await client.query(statement);
        }
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        console.log(`  ✅ ${file} (no transaction)`);
        count++;
        continue;
      } catch (err) {
        console.error(`  ❌ ${file} failed — statements before the failure stay applied; it is safe to re-run`);
        throw err;
      } finally {
        client.release();
      }
    }
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  ✅ ${file}`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  ❌ ${file} failed — rolled back`);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(count === 0 ? '\nDatabase already up to date.' : `\nApplied ${count} migration(s).`);
}

// Migrations run with no tenant: DDL is unaffected by RLS, and since 0046 a
// data fix that must span tenants says so with `SET LOCAL ROLE tupo_platform`.
runWithoutTenant('migrations', () => migrate())
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Migration failed:', err instanceof Error ? err.message : err);
    await closeDb();
    process.exit(1);
  });
