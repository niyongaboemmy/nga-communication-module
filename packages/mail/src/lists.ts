/**
 * Distribution lists (FR-MAIL-4).
 *
 * A `manual` list is edited by hand. A `mis:*` list is *derived* — its
 * membership is a query over the local user mirror (which is itself kept in
 * sync with the NGA Central MIS by the directory sync), re-materialised by a
 * worker sweep so it "stays in sync automatically". Re-materialising rather
 * than joining at send time means a campaign's recipient count is a real
 * number you can preview and approve against.
 */
import { getPool, snowflake } from '@tupo/db';
import type { MailDistributionList } from '@tupo/shared';
import { MailError } from './errors.js';

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'list';
}

const rowToList = (r: {
  id: string; name: string; slug: string; description: string; origin: string; is_active: boolean;
  member_count: number; synced_at: string | null; created_at: string;
}): MailDistributionList => ({
  id: r.id, name: r.name, slug: r.slug, description: r.description, origin: r.origin,
  isActive: r.is_active, memberCount: r.member_count, syncedAt: r.synced_at, createdAt: r.created_at,
});

export async function listLists(includeInactive = false): Promise<MailDistributionList[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM mail_distribution_lists
      WHERE $1 OR is_active
      ORDER BY name`, [includeInactive],
  );
  return rows.map(rowToList);
}

export async function getList(id: string): Promise<MailDistributionList> {
  const { rows } = await getPool().query(`SELECT * FROM mail_distribution_lists WHERE id = $1`, [id]);
  if (!rows[0]) throw new MailError('Distribution list not found.', 404);
  return rowToList(rows[0]);
}

export async function createList(
  userId: string, input: { name: string; description?: string; origin?: string },
): Promise<MailDistributionList> {
  const name = input.name.trim();
  if (!name) throw new MailError('A list needs a name.');
  const origin = input.origin ?? 'manual';
  const id = snowflake();
  try {
    await getPool().query(
      `INSERT INTO mail_distribution_lists (id, name, slug, description, origin, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, name, slugify(name), input.description ?? '', origin, userId],
    );
  } catch {
    throw new MailError('A list with a similar name already exists.', 409);
  }
  if (origin !== 'manual') await syncList(id);
  return getList(id);
}

export async function updateList(
  id: string, patch: { name?: string; description?: string; isActive?: boolean },
): Promise<MailDistributionList> {
  const cur = await getList(id);
  await getPool().query(
    `UPDATE mail_distribution_lists SET name = $2, description = $3, is_active = $4, updated_at = now()
      WHERE id = $1`,
    [id, patch.name?.trim() || cur.name, patch.description ?? cur.description, patch.isActive ?? cur.isActive],
  );
  return getList(id);
}

export async function deleteList(id: string): Promise<void> {
  const { rowCount } = await getPool().query(`DELETE FROM mail_distribution_lists WHERE id = $1`, [id]);
  if (!rowCount) throw new MailError('Distribution list not found.', 404);
}

export interface ListMember {
  address: string;
  userId: string | null;
  name: string;
  mergeVars: Record<string, string>;
  source: string;
}

export async function listMembers(listId: string, limit = 500): Promise<ListMember[]> {
  const { rows } = await getPool().query<{
    address: string; user_id: string | null; name: string; merge_vars: Record<string, string>; source: string;
  }>(
    `SELECT address, user_id, name, merge_vars, source FROM mail_list_members
      WHERE list_id = $1 ORDER BY name LIMIT $2`, [listId, Math.min(limit, 5000)],
  );
  return rows.map((r) => ({
    address: r.address, userId: r.user_id, name: r.name, mergeVars: r.merge_vars ?? {}, source: r.source,
  }));
}

export async function addManualMember(
  listId: string, input: { address: string; name?: string; userId?: string; mergeVars?: Record<string, string> },
): Promise<void> {
  const list = await getList(listId);
  if (list.origin !== 'manual') throw new MailError('This list is synced automatically and cannot be edited by hand.');
  await getPool().query(
    `INSERT INTO mail_list_members (list_id, address, user_id, name, merge_vars, source)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'manual')
     ON CONFLICT (list_id, address) DO UPDATE SET name = EXCLUDED.name, merge_vars = EXCLUDED.merge_vars`,
    [listId, input.address.toLowerCase(), input.userId ?? null, input.name ?? input.address,
     JSON.stringify(input.mergeVars ?? {})],
  );
  await refreshCount(listId);
}

export async function removeMember(listId: string, address: string): Promise<void> {
  await getPool().query(
    `DELETE FROM mail_list_members WHERE list_id = $1 AND address = $2`, [listId, address.toLowerCase()],
  );
  await refreshCount(listId);
}

async function refreshCount(listId: string): Promise<void> {
  await getPool().query(
    `UPDATE mail_distribution_lists SET member_count =
       (SELECT count(*) FROM mail_list_members WHERE list_id = $1), updated_at = now()
      WHERE id = $1`, [listId],
  );
}

/**
 * Re-materialise a `mis:*` list. Deletes only the `sync`-sourced rows, so a
 * manual addition to a hybrid list survives (there are none today, but the
 * delete is scoped anyway).
 */
export async function syncList(listId: string): Promise<{ members: number }> {
  const list = await getList(listId);
  if (list.origin === 'manual') return { members: list.memberCount };

  const pool = getPool();
  let sql: string;
  let params: unknown[];

  if (list.origin === 'mis:all') {
    sql = `SELECT id, name, email, role FROM users WHERE status = 'active' AND email <> ''`;
    params = [];
  } else if (list.origin.startsWith('mis:role:')) {
    const roleName = list.origin.slice('mis:role:'.length);
    sql = `SELECT u.id, u.name, u.email, u.role
             FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.status = 'active' AND u.email <> '' AND r.name = $1`;
    params = [roleName];
  } else if (list.origin.startsWith('mis:space:')) {
    const slug = list.origin.slice('mis:space:'.length);
    sql = `SELECT u.id, u.name, u.email, u.role
             FROM users u
             JOIN space_members sm ON sm.user_id = u.id
             JOIN spaces s ON s.id = sm.space_id
            WHERE u.status = 'active' AND u.email <> '' AND s.slug = $1`;
    params = [slug];
  } else {
    throw new MailError(`Unknown list origin: ${list.origin}`);
  }

  const { rows } = await pool.query<{ id: string; name: string; email: string; role: string }>(sql, params);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM mail_list_members WHERE list_id = $1 AND source = 'sync'`, [listId]);
    for (const u of rows) {
      const first = u.name.split(/\s+/)[0] ?? u.name;
      await client.query(
        `INSERT INTO mail_list_members (list_id, address, user_id, name, merge_vars, source)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'sync')
         ON CONFLICT (list_id, address) DO UPDATE SET user_id = EXCLUDED.user_id, name = EXCLUDED.name,
           merge_vars = EXCLUDED.merge_vars, source = 'sync'`,
        [listId, u.email.toLowerCase(), u.id, u.name,
         JSON.stringify({ name: u.name, first_name: first, email: u.email, role: u.role })],
      );
    }
    await client.query(
      `UPDATE mail_distribution_lists SET member_count = $2, synced_at = now(), updated_at = now() WHERE id = $1`,
      [listId, rows.length],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { members: rows.length };
}

/** Sweep every synced list — the worker's periodic job. */
export async function syncAllLists(): Promise<{ lists: number; members: number }> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM mail_distribution_lists WHERE origin <> 'manual' AND is_active`,
  );
  let members = 0;
  for (const r of rows) {
    try { members += (await syncList(r.id)).members; }
    catch (e) { console.error(`[mail] list sync ${r.id} failed:`, e); }
  }
  return { lists: rows.length, members };
}

/**
 * Seed the standard institutional lists once. Called from db seed so a fresh
 * deployment has "All Staff", "All Parents", "All Students" ready.
 */
export async function seedDefaultLists(): Promise<void> {
  const defaults = [
    { name: 'All Staff', origin: 'mis:space:staff', description: 'Every member of the Staff space.' },
    { name: 'All Students', origin: 'mis:space:students', description: 'Every enrolled learner.' },
    { name: 'All Parents', origin: 'mis:space:parents', description: 'Every parent or guardian.' },
    { name: 'Everyone', origin: 'mis:all', description: 'Every active Tupo account.' },
  ];
  for (const d of defaults) {
    const { rows } = await getPool().query(
      `INSERT INTO mail_distribution_lists (id, name, slug, description, origin)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (lower(slug)) DO NOTHING
       RETURNING id`,
      [snowflake(), d.name, slugify(d.name), d.description, d.origin],
    );
    if (rows[0]) await syncList(rows[0].id).catch(() => { /* empty DB is fine */ });
  }
}
