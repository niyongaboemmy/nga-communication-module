import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closeDb } from './pool.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Forward-only migration runner. Each file runs once, inside a transaction,
 * and is recorded in _migrations — so `npm run db:migrate` is safe to run on
 * every deploy and a partially applied file never half-lands.
 */
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

migrate()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Migration failed:', err instanceof Error ? err.message : err);
    await closeDb();
    process.exit(1);
  });
