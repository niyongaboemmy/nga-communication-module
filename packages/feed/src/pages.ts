/**
 * Pages — the posting identities (FR-FEED-1).
 *
 * A person never posts as themselves in the feed; they post *as a page* they
 * own or edit. Following is viewer-relative state; mandatory pages auto-follow
 * their whole audience and refuse manual unfollow.
 */
import type { PoolClient } from 'pg';
import { getPool, snowflake } from '@tupo/db';
import type {
  CreatePagePayload, FeedPageDetail, FeedPageKind, FeedPageSummary, UpdatePagePayload,
} from '@tupo/shared';
import { FEED_LIMITS, FEED_PAGE_KINDS, FEED_AUDIENCES } from '@tupo/shared';
import { FeedError } from './errors.js';
import {
  type FeedActor, type RoleLevel, can, canTargetAudience, slugify, visibleAudiences,
} from './common.js';

export interface PageRow {
  id: string;
  slug: string;
  name: string;
  bio: string;
  kind: string;
  audience: string;
  mandatory: boolean;
  verified: boolean;
  avatar_file_id: string | null;
  cover_file_id: string | null;
  accent: string;
  follower_count: number;
  post_count: number;
  created_by: string | null;
  created_at: string;
  my_follow: boolean;
  my_notify: boolean;
  my_editor_role: 'owner' | 'editor' | null;
}

const PAGE_SELECT = `
  SELECT p.id, p.slug, p.name, p.bio, p.kind, p.audience, p.mandatory, p.verified,
         p.avatar_file_id, p.cover_file_id, p.accent, p.follower_count, p.post_count,
         p.created_by, p.created_at,
         (f.user_id IS NOT NULL)               AS my_follow,
         COALESCE(f.notify, false)             AS my_notify,
         e.role                                AS my_editor_role
    FROM feed_pages p
    LEFT JOIN feed_page_followers f ON f.page_id = p.id AND f.user_id = $1
    LEFT JOIN feed_page_editors  e ON e.page_id = p.id AND e.user_id = $1
   WHERE p.deleted_at IS NULL`;

export function toPageSummary(row: PageRow, actor: FeedActor): FeedPageSummary {
  const canPost =
    row.my_editor_role !== null &&
    can(actor, 'FEED_POST') &&
    canTargetAudience(actor.roleLevel, row.audience as FeedPageSummary['audience']);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    bio: row.bio,
    kind: row.kind as FeedPageKind,
    audience: row.audience as FeedPageSummary['audience'],
    mandatory: row.mandatory,
    verified: row.verified,
    avatarFileId: row.avatar_file_id,
    coverFileId: row.cover_file_id,
    accent: row.accent,
    followerCount: row.follower_count,
    postCount: row.post_count,
    following: row.my_follow,
    notify: row.my_notify,
    myRole: row.my_editor_role,
    canPost,
  };
}

async function loadRow(actor: FeedActor, idOrSlug: string): Promise<PageRow> {
  const byId = /^\d+$/.test(idOrSlug);
  const { rows } = await getPool().query<PageRow>(
    `${PAGE_SELECT} AND ${byId ? 'p.id = $2' : 'lower(p.slug) = lower($2)'} LIMIT 1`,
    [actor.id, idOrSlug],
  );
  if (!rows[0]) throw new FeedError('Page not found.', 404);
  return rows[0];
}

export async function getPage(actor: FeedActor, idOrSlug: string): Promise<FeedPageDetail> {
  const row = await loadRow(actor, idOrSlug);
  if (!visibleAudiences(actor.roleLevel).includes(row.audience as FeedPageSummary['audience'])
      && row.my_editor_role === null) {
    throw new FeedError('Page not found.', 404);
  }
  const { rows: editors } = await getPool().query<{
    id: string; name: string; avatar_url: string | null; role: 'owner' | 'editor';
  }>(
    `SELECT u.id, u.name, u.avatar_url, e.role
       FROM feed_page_editors e JOIN users u ON u.id = e.user_id
      WHERE e.page_id = $1
      ORDER BY e.role = 'owner' DESC, e.added_at`,
    [row.id],
  );
  return {
    ...toPageSummary(row, actor),
    createdAt: row.created_at,
    editors: editors.map((e) => ({ id: e.id, name: e.name, avatarUrl: e.avatar_url, role: e.role })),
  };
}

export interface ListPagesOpts { mine?: boolean; kind?: string; q?: string; limit?: number; }

export async function listPages(actor: FeedActor, opts: ListPagesOpts = {}): Promise<FeedPageSummary[]> {
  const clauses: string[] = [];
  const params: unknown[] = [actor.id];
  const visible = visibleAudiences(actor.roleLevel);
  params.push(visible);
  clauses.push(`(p.audience = ANY($${params.length}) OR e.user_id IS NOT NULL)`);
  if (opts.mine) clauses.push('e.user_id IS NOT NULL');
  if (opts.kind && (FEED_PAGE_KINDS as readonly string[]).includes(opts.kind)) {
    params.push(opts.kind);
    clauses.push(`p.kind = $${params.length}`);
  }
  if (opts.q) {
    params.push(`%${opts.q.trim()}%`);
    clauses.push(`(p.name ILIKE $${params.length} OR p.slug ILIKE $${params.length})`);
  }
  params.push(Math.min(opts.limit ?? 50, 100));
  const { rows } = await getPool().query<PageRow>(
    `${PAGE_SELECT} AND ${clauses.join(' AND ')}
      ORDER BY e.user_id IS NOT NULL DESC, p.mandatory DESC, p.follower_count DESC, p.name
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => toPageSummary(r, actor));
}

export async function createPage(actor: FeedActor, payload: CreatePagePayload): Promise<FeedPageDetail> {
  if (!can(actor, 'FEED_PAGE_MANAGE')) throw new FeedError('You cannot create pages.', 403);
  const name = (payload.name ?? '').trim();
  if (name.length < 2) throw new FeedError('A page needs a name.', 400);
  const kind: FeedPageKind =
    payload.kind && (FEED_PAGE_KINDS as readonly string[]).includes(payload.kind) ? payload.kind : 'community';
  const audience = payload.audience && (FEED_AUDIENCES as readonly string[]).includes(payload.audience)
    ? payload.audience : 'everyone';
  const bio = (payload.bio ?? '').slice(0, FEED_LIMITS.PAGE_BIO_MAX);
  const base = slugify(payload.slug || name);

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    let slug = base;
    for (let n = 2; ; n++) {
      const { rows } = await client.query('SELECT 1 FROM feed_pages WHERE lower(slug) = lower($1) AND deleted_at IS NULL', [slug]);
      if (!rows.length) break;
      slug = `${base}-${n}`;
    }
    const id = snowflake();
    await client.query(
      `INSERT INTO feed_pages (id, slug, name, bio, kind, audience, accent, avatar_file_id, cover_file_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, slug, name, bio, kind, audience, payload.accent ?? '#2563eb',
       payload.avatarFileId ?? null, payload.coverFileId ?? null, actor.id],
    );
    await client.query(
      `INSERT INTO feed_page_editors (page_id, user_id, role, added_by) VALUES ($1,$2,'owner',$2)`,
      [id, actor.id],
    );
    await client.query(
      `INSERT INTO feed_page_followers (page_id, user_id, notify, source) VALUES ($1,$2,true,'manual')
       ON CONFLICT DO NOTHING`,
      [id, actor.id],
    );
    await client.query('UPDATE feed_pages SET follower_count = 1 WHERE id = $1', [id]);
    await client.query('COMMIT');
    return getPage(actor, id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/*
 * Two different questions, deliberately kept apart.
 *
 * `FEED_PAGE_MANAGE` is the permission to *create* pages. It is not a claim
 * over pages other people made, and until this was split it behaved like one:
 * every route below checked the platform permission, and the per-page check it
 * then called returned early for anyone whose role level was ADMIN — which is
 * the only level the permission is granted to. The ownership test never ran for
 * a single caller that reached it.
 */

/**
 * May this person change what the page *is* — its name, branding, audience,
 * and who else may write as it?
 *
 * Ownership of that specific page, and nothing else. No platform permission
 * substitutes for it: holding FEED_PAGE_MANAGE means you may make your own
 * pages, not redecorate somebody else's. Editors are excluded too — they speak
 * *as* the page, which is a different thing from deciding what it looks like.
 */
export async function assertPageOwner(actor: FeedActor, pageId: string): Promise<PageRow> {
  const row = await loadRow(actor, pageId);
  if (row.my_editor_role === 'owner') return row;
  throw new FeedError('Only an owner of this page can change it.', 403);
}

/**
 * May this person act on the page as the institution, rather than as its owner?
 *
 * Owners plus platform admins. This is the governance door: an admin must be
 * able to remove a page that should not exist, and to take one back when its
 * only owner has left the school — otherwise such a page is unmanageable
 * without a database edit. It is deliberately narrower than ownership: an admin
 * gets here to delete a page or set its institutional flags, not to rename one
 * or change its logo.
 */
export async function assertPageGovernance(actor: FeedActor, pageId: string): Promise<PageRow> {
  const row = await loadRow(actor, pageId);
  if (row.my_editor_role === 'owner') return row;
  if (actor.roleLevel === 'ADMIN') return row;
  throw new FeedError('You do not manage this page.', 403);
}

/** May this person publish as the page? Owners and editors both. */
export async function assertPageEditor(actor: FeedActor, pageId: string): Promise<PageRow> {
  const row = await loadRow(actor, pageId);
  if (row.my_editor_role !== null) return row;
  throw new FeedError('You are not an editor of this page.', 403);
}

export async function updatePage(
  actor: FeedActor, pageId: string, patch: UpdatePagePayload,
): Promise<FeedPageDetail> {
  /*
   * Split by *what is being changed*, not by who is asking.
   *
   * Everything describing the page — its name, bio, look, audience — belongs to
   * whoever owns it. `verified` and `mandatory` are institutional claims the
   * page cannot make about itself, so they are the admin's and only the
   * admin's. A request touching both needs to satisfy both tests.
   */
  const wantsContent = patch.name !== undefined || patch.bio !== undefined
    || patch.accent !== undefined || patch.avatarFileId !== undefined
    || patch.coverFileId !== undefined || patch.kind !== undefined
    || patch.audience !== undefined;
  const wantsGovernance = patch.verified !== undefined || patch.mandatory !== undefined;

  // Resolved first, so the UPDATE below can key off the real id even when the
  // caller addressed the page by slug.
  const row = wantsContent
    ? await assertPageOwner(actor, pageId)
    : await assertPageGovernance(actor, pageId);
  if (wantsGovernance && actor.roleLevel !== 'ADMIN') {
    throw new FeedError('Only an administrator can verify or pin a page institution-wide.', 403);
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (patch.name !== undefined) set('name', patch.name.trim());
  if (patch.bio !== undefined) set('bio', patch.bio.slice(0, FEED_LIMITS.PAGE_BIO_MAX));
  if (patch.accent !== undefined) set('accent', patch.accent);
  if (patch.avatarFileId !== undefined) set('avatar_file_id', patch.avatarFileId);
  if (patch.coverFileId !== undefined) set('cover_file_id', patch.coverFileId);
  if (patch.kind !== undefined && (FEED_PAGE_KINDS as readonly string[]).includes(patch.kind)) set('kind', patch.kind);
  if (patch.audience !== undefined && (FEED_AUDIENCES as readonly string[]).includes(patch.audience)) set('audience', patch.audience);
  if (patch.verified !== undefined) set('verified', patch.verified);
  if (patch.mandatory !== undefined) set('mandatory', patch.mandatory);

  if (sets.length) {
    /*
     * `row.id`, never the caller's string. `loadRow` accepts an id or a slug,
     * so keying the UPDATE off the raw parameter silently matched nothing
     * whenever a page was addressed by slug — and still returned 200 with the
     * unchanged page, which reads as "saved" to anyone watching.
     */
    params.push(row.id);
    await getPool().query(`UPDATE feed_pages SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
  }
  return getPage(actor, row.id);
}

/** Removing a page is governance: its owners, or an admin acting for the school. */
export async function deletePage(actor: FeedActor, pageId: string): Promise<void> {
  const row = await assertPageGovernance(actor, pageId);
  await getPool().query('UPDATE feed_pages SET deleted_at = now() WHERE id = $1', [row.id]);
}

/* ── Following ──────────────────────────────────────────────────────────── */

export async function follow(actor: FeedActor, pageId: string, notify = true): Promise<FeedPageSummary> {
  const row = await loadRow(actor, pageId);
  if (!visibleAudiences(actor.roleLevel).includes(row.audience as FeedPageSummary['audience'])) {
    throw new FeedError('Page not found.', 404);
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `INSERT INTO feed_page_followers (page_id, user_id, notify, source)
       VALUES ($1,$2,$3,'manual') ON CONFLICT (page_id, user_id) DO UPDATE SET notify = EXCLUDED.notify`,
      [row.id, actor.id, notify],
    );
    if (rowCount) {
      await client.query(
        `UPDATE feed_pages SET follower_count = (SELECT count(*) FROM feed_page_followers WHERE page_id = $1) WHERE id = $1`,
        [row.id],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return toPageSummary(await loadRow(actor, pageId), actor);
}

export async function unfollow(actor: FeedActor, pageId: string): Promise<FeedPageSummary> {
  const row = await loadRow(actor, pageId);
  if (row.mandatory) throw new FeedError('This page is required for your role and cannot be unfollowed.', 409);
  await getPool().query('DELETE FROM feed_page_followers WHERE page_id = $1 AND user_id = $2', [row.id, actor.id]);
  await getPool().query(
    `UPDATE feed_pages SET follower_count = (SELECT count(*) FROM feed_page_followers WHERE page_id = $1) WHERE id = $1`,
    [row.id],
  );
  // Also drop precomputed timeline rows from this page — a feed you unfollowed
  // should not keep showing its old posts.
  await getPool().query(
    'DELETE FROM feed_timeline WHERE user_id = $1 AND page_id = $2 AND reason = $3',
    [actor.id, row.id, 'follow'],
  );
  return toPageSummary(await loadRow(actor, pageId), actor);
}

export async function setNotify(actor: FeedActor, pageId: string, notify: boolean): Promise<void> {
  const row = await loadRow(actor, pageId);
  const { rowCount } = await getPool().query(
    'UPDATE feed_page_followers SET notify = $3 WHERE page_id = $1 AND user_id = $2',
    [row.id, actor.id, notify],
  );
  if (!rowCount) throw new FeedError('Follow the page first.', 409);
}

/* ── Editors ───────────────────────────────────────────────────────────── */

export async function addEditor(
  actor: FeedActor, pageId: string, userId: string, role: 'owner' | 'editor',
): Promise<void> {
  /*
   * Owners only, and this one matters most of the set: whoever can edit this
   * list can grant themselves anything else on the page. When a plain editor
   * could reach here, "editor" was not a lesser role at all — an editor could
   * promote themselves to owner and then remove the real one, and the
   * keep-one-owner rule below was no obstacle because they had just become one.
   */
  const page = await assertPageOwner(actor, pageId);
  const { rows } = await getPool().query('SELECT 1 FROM users WHERE id = $1', [userId]);
  if (!rows.length) throw new FeedError('No such user.', 404);
  await getPool().query(
    `INSERT INTO feed_page_editors (page_id, user_id, role, added_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (page_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [page.id, userId, role === 'owner' ? 'owner' : 'editor', actor.id],
  );
  await getPool().query(
    `INSERT INTO feed_page_followers (page_id, user_id, notify, source) VALUES ($1,$2,true,'manual')
     ON CONFLICT DO NOTHING`,
    [page.id, userId],
  );
}

export async function removeEditor(actor: FeedActor, pageId: string, userId: string): Promise<void> {
  const page = await assertPageOwner(actor, pageId);
  const { rows } = await getPool().query<{ role: string }>(
    'SELECT role FROM feed_page_editors WHERE page_id = $1 AND user_id = $2', [page.id, userId],
  );
  if (!rows[0]) return;
  if (rows[0].role === 'owner') {
    const { rows: owners } = await getPool().query(
      `SELECT 1 FROM feed_page_editors WHERE page_id = $1 AND role = 'owner' AND user_id <> $2`, [page.id, userId],
    );
    if (!owners.length) throw new FeedError('A page must keep at least one owner.', 409);
  }
  await getPool().query('DELETE FROM feed_page_editors WHERE page_id = $1 AND user_id = $2', [page.id, userId]);
}

/* ── Mandatory follows (FR-FEED-1) ─────────────────────────────────────── */

/**
 * Make sure this user follows every mandatory page in their audience. Called
 * lazily on the first feed load and after SSO hydrate. Cheap and idempotent.
 */
export async function ensureMandatoryFollows(userId: string, roleLevel: RoleLevel): Promise<void> {
  const audiences = visibleAudiences(roleLevel);
  await getPool().query(
    `INSERT INTO feed_page_followers (page_id, user_id, notify, source)
       SELECT p.id, $1, true, 'mandatory'
         FROM feed_pages p
        WHERE p.deleted_at IS NULL AND p.mandatory AND p.audience = ANY($2)
     ON CONFLICT (page_id, user_id) DO NOTHING`,
    [userId, audiences],
  );
  await getPool().query(
    `UPDATE feed_pages p SET follower_count = (SELECT count(*) FROM feed_page_followers f WHERE f.page_id = p.id)
      WHERE p.mandatory AND p.deleted_at IS NULL`,
  );
}

export async function followedPageIds(userId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ page_id: string }>(
    'SELECT page_id FROM feed_page_followers WHERE user_id = $1', [userId],
  );
  return rows.map((r) => r.page_id);
}

/** For fan-out: the followers of a page who want to be notified. */
export async function pageFollowers(
  client: PoolClient, pageId: string,
): Promise<Array<{ user_id: string; notify: boolean }>> {
  const { rows } = await client.query<{ user_id: string; notify: boolean }>(
    'SELECT user_id, notify FROM feed_page_followers WHERE page_id = $1', [pageId],
  );
  return rows;
}
