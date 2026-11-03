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

  // Starter feed pages (FR-FEED-1). Idempotent by slug. The first Admin user,
  // if one exists yet, becomes the owner; otherwise the page is unclaimed and
  // an administrator can add themselves as owner later.
  const { rows: adminRows } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`,
  );
  const ownerId = adminRows[0]?.id ?? null;
  const PAGES = [
    { slug: 'nga-official', name: 'NGA Official', kind: 'official', audience: 'everyone', verified: true, mandatory: true, accent: '#2563eb', bio: 'Official announcements from New Generation Academy.' },
    { slug: 'academics', name: 'Academics & Exams', kind: 'official', audience: 'everyone', verified: true, mandatory: false, accent: '#7c3aed', bio: 'Timetables, exam news, results and study resources.' },
    { slug: 'sports-clubs', name: 'Sports & Clubs', kind: 'club', audience: 'everyone', verified: false, mandatory: false, accent: '#0d9488', bio: 'Fixtures, results, and everything the clubs are up to.' },
  ];
  for (const p of PAGES) {
    const res = await pool.query(
      `INSERT INTO feed_pages (id, slug, name, bio, kind, audience, verified, mandatory, accent, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (lower(slug)) WHERE deleted_at IS NULL DO NOTHING
       RETURNING id`,
      [snowflake(), p.slug, p.name, p.bio, p.kind, p.audience, p.verified, p.mandatory, p.accent, ownerId],
    );
    if (res.rowCount && ownerId) {
      await pool.query(
        `INSERT INTO feed_page_editors (page_id, user_id, role, added_by) VALUES ($1,$2,'owner',$2)
         ON CONFLICT DO NOTHING`,
        [res.rows[0]!.id, ownerId],
      );
    }
    console.log(res.rowCount ? `  ✅ created page '${p.slug}'` : `  ⏭  page '${p.slug}' exists`);
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
