import 'dotenv/config';
import { getPool, closeDb } from './pool.js';
import { snowflake } from './snowflake.js';
import { seedRbac } from './rbac.js';
import { PERMISSIONS } from '@tupo/shared';

/**
 * Seeds the three institutional spaces from the SRS. Idempotent by slug, so
 * re-seeding an existing database changes nothing.
 *
 * Deliberately seeds NO users: users only ever come into existence by signing
 * in through the MIS. A seeded user would be an account Tupo invented, which
 * is exactly what this app must not have.
 */
const CATEGORY_COUNT = new Set(PERMISSIONS.map((p) => p.category)).size;

const SPACES = [
  { slug: 'staff',    name: 'NGA Staff',    description: 'Teaching and administrative staff' },
  { slug: 'students', name: 'NGA Students', description: 'Enrolled learners' },
  { slug: 'parents',  name: 'NGA Parents',  description: 'Parents and guardians' },
];

async function seed(): Promise<void> {
  const pool = getPool();
  for (const space of SPACES) {
    const res = await pool.query(
      `INSERT INTO spaces (id, slug, name, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [snowflake(), space.slug, space.name, space.description]
    );
    console.log(res.rowCount ? `  ✅ created space '${space.slug}'` : `  ⏭  space '${space.slug}' exists`);
  }

  const rbac = await seedRbac(pool);
  console.log(`  ✅ ${rbac.permissions} permissions across ${CATEGORY_COUNT} categories`);
  console.log(`  ✅ ${rbac.roles} system roles with their permission sets`);
  if (rbac.removed > 0) console.log(`  🧹 removed ${rbac.removed} retired permission(s)`);

  console.log('\nSeed complete.');
}

seed()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Seed failed:', err instanceof Error ? err.message : err);
    await closeDb();
    process.exit(1);
  });
