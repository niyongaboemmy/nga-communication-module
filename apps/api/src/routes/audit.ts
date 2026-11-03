import { Router, type Request, type Response } from 'express';
import { getPool } from '@tupo/db';
import { ok, fail, AUDIT_ROUTINE, AUDIT_SIGNIN_ACTIONS, auditViewOf } from '@tupo/shared';
import { authMiddleware } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';

const router = Router();
router.use(authMiddleware);

/*
 * The audit log (F-13). Opens on privileged actions — authority used over
 * other people or the system — with sign-ins and routine activity one click
 * away; filterable by action, person, target and date; paged by a cursor so
 * a long history never loads at once; and every target comes back with a
 * name and, where one exists, a link, instead of a bare "role:12".
 */

const ROUTINE_EXACT = AUDIT_ROUTINE.filter((a) => !a.endsWith('.'));
const ROUTINE_PREFIX = AUDIT_ROUTINE.filter((a) => a.endsWith('.')).map((p) => `${p}%`);

interface AuditRow {
  id: string; action: string; target_type: string | null; target_id: string | null;
  metadata: Record<string, unknown>; ip_address: string | null; created_at: string; cursor: string;
  actor_id: string | null; actor_name: string | null; actor_email: string | null; actor_avatar: string | null;
}

router.get('/', authorizePermission('AUDIT_VIEW'), async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const view = ['signins', 'all'].includes(String(req.query.view)) ? String(req.query.view) : 'privileged';
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: (n: string) => string, value: unknown) => { params.push(value); where.push(sql(`$${params.length}`)); };

  if (view === 'privileged') {
    params.push([...ROUTINE_EXACT, ...AUDIT_SIGNIN_ACTIONS], ROUTINE_PREFIX);
    where.push(`NOT (a.action = ANY($${params.length - 1}::text[]) OR a.action LIKE ANY($${params.length}::text[]))`);
  } else if (view === 'signins') {
    add((n) => `a.action = ANY(${n}::text[])`, [...AUDIT_SIGNIN_ACTIONS]);
  }

  const action = String(req.query.action ?? '').trim();
  if (action) {
    if (action.endsWith('.')) add((n) => `a.action LIKE ${n}`, `${action}%`);
    else add((n) => `a.action = ${n}`, action);
  }
  const actor = String(req.query.actor ?? '').trim();
  if (actor) add((n) => `a.actor_id = ${n}`, actor);
  const targetType = String(req.query.targetType ?? '').trim();
  const targetId = String(req.query.targetId ?? '').trim();
  if (targetType) add((n) => `a.target_type = ${n}`, targetType);
  if (targetId) add((n) => `a.target_id = ${n}`, targetId);
  const q = String(req.query.q ?? '').trim().slice(0, 100);
  if (q) add((n) => `(u.name ILIKE '%' || ${n} || '%' OR u.email ILIKE '%' || ${n} || '%' OR a.action ILIKE '%' || ${n} || '%' OR a.target_id = ${n})`, q);
  for (const [key, op] of [['from', '>='], ['to', '<']] as const) {
    const raw = String(req.query[key] ?? '').trim();
    if (!raw) continue;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return res.status(400).json(fail(`"${key}" is not a date.`));
    // "to" is a calendar day, inclusive: everything before the next midnight.
    if (key === 'to' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) d.setUTCDate(d.getUTCDate() + 1);
    add((n) => `a.created_at ${op} ${n}`, d.toISOString());
  }
  // Cursor: the last row's exact time (to the microsecond) and id.
  const before = String(req.query.before ?? '');
  if (before) {
    const [ts, id] = before.split('|');
    if (!ts || !id || Number.isNaN(new Date(ts).getTime())) return res.status(400).json(fail('Bad cursor.'));
    params.push(ts, id);
    where.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length})`);
  }

  params.push(limit + 1);
  const { rows } = await getPool().query<AuditRow>(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.metadata, a.ip_address, a.created_at,
            to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || a.id AS cursor,
            a.actor_id, u.name AS actor_name, u.email AS actor_email, u.avatar_url AS actor_avatar
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit);
  const targets = await describeTargets(page);
  const refs = await referencedNames(page);
  return res.json({
    ...ok(page.map(({ cursor: _c, ...r }) => ({
      ...r, category: auditViewOf(r.action), target: targets.get(`${r.target_type}:${r.target_id}`) ?? null,
    }))),
    nextBefore: rows.length > limit ? page[page.length - 1]!.cursor : null,
    refs,
  });
});

/** Every action that has been recorded, with counts, for the filter list. */
router.get('/actions', authorizePermission('AUDIT_VIEW'), async (_req: Request, res: Response) => {
  const { rows } = await getPool().query<{ action: string; n: number }>(
    'SELECT action, count(*)::int AS n FROM audit_log GROUP BY action ORDER BY action');
  return res.json(ok(rows.map((r) => ({ action: r.action, count: r.n, category: auditViewOf(r.action) }))));
});

interface TargetLabel { label: string; link: string | null; gone?: boolean }

/**
 * Names (and links) for the targets on one page: one query per kind of
 * target, not one per row. A target that has since been deleted still says
 * what it was, marked as gone.
 */
async function describeTargets(rows: AuditRow[]): Promise<Map<string, TargetLabel>> {
  const out = new Map<string, TargetLabel>();
  const idsOf = (type: string) => [...new Set(rows.filter((r) => r.target_type === type && r.target_id).map((r) => r.target_id!))];
  const pool = getPool();
  const lookups: Array<[string, string, (r: Record<string, unknown>) => TargetLabel]> = [
    ['user', `SELECT id, name FROM users WHERE id = ANY($1::text[])`,
      (r) => ({ label: String(r.name), link: `/app/admin/users?q=${encodeURIComponent(String(r.name))}` })],
    ['role', `SELECT id::text AS id, name FROM roles WHERE id::text = ANY($1::text[])`,
      (r) => ({ label: String(r.name), link: `/app/admin/roles?role=${r.id}` })],
    ['conversation', `SELECT id, name, type, deleted_at FROM conversations WHERE id = ANY($1::text[])`,
      (r) => ({ label: r.name ? `#${r.name}` : r.type === 'dm' ? 'Direct message' : 'Group conversation', link: null, gone: Boolean(r.deleted_at) })],
    ['feed_page', `SELECT id, name, slug, deleted_at FROM feed_pages WHERE id = ANY($1::text[])`,
      (r) => ({ label: String(r.name), link: r.deleted_at ? null : `/app/feed/p/${r.slug}`, gone: Boolean(r.deleted_at) })],
    ['feed_post', `SELECT id, left(regexp_replace(coalesce(body, ''), '\\s+', ' ', 'g'), 60) AS body, deleted_at FROM feed_posts WHERE id = ANY($1::text[])`,
      (r) => ({ label: r.body ? `“${r.body}”` : 'Post', link: r.deleted_at ? null : `/app/feed/post/${r.id}`, gone: Boolean(r.deleted_at) })],
    ['feed_reel', `SELECT id, left(coalesce(caption, ''), 60) AS caption, deleted_at FROM feed_reels WHERE id = ANY($1::text[])`,
      (r) => ({ label: r.caption ? `Reel “${r.caption}”` : 'Reel', link: r.deleted_at ? null : `/app/feed/reels/${r.id}`, gone: Boolean(r.deleted_at) })],
    ['mail_campaign', `SELECT id, coalesce(nullif(name, ''), subject) AS name FROM mail_campaigns WHERE id = ANY($1::text[])`,
      (r) => ({ label: String(r.name ?? 'Campaign'), link: `/app/mail/campaigns/${r.id}` })],
    ['mail_list', `SELECT id, name FROM mail_distribution_lists WHERE id = ANY($1::text[])`,
      (r) => ({ label: String(r.name), link: '/app/mail/lists' })],
    ['mail_message', `SELECT id, subject FROM mail_messages WHERE id = ANY($1::text[])`,
      (r) => ({ label: r.subject ? `“${r.subject}”` : 'Mail', link: null })],
    ['meeting', `SELECT id, title FROM meetings WHERE id = ANY($1::text[])`,
      (r) => ({ label: String(r.title ?? 'Meeting'), link: `/app/meet/${r.id}/summary` })],
  ];
  await Promise.all(lookups.map(async ([type, sql, label]) => {
    const ids = idsOf(type);
    if (!ids.length) return;
    const { rows: found } = await pool.query(sql, [ids]).catch(() => ({ rows: [] as Record<string, unknown>[] }));
    for (const r of found) out.set(`${type}:${r.id}`, label(r));
    // Deleted outright: say so, with whatever the entry itself remembers.
    for (const id of ids) {
      if (out.has(`${type}:${id}`)) continue;
      const meta = rows.find((r) => r.target_type === type && r.target_id === id)?.metadata ?? {};
      const remembered = (meta.name ?? meta.title ?? meta.subject) as string | undefined;
      out.set(`${type}:${id}`, { label: remembered ? String(remembered) : `${type.replace(/_/g, ' ')} ${id}`, link: null, gone: true });
    }
  }));
  return out;
}

/** People and roles that entries mention by id in their details. */
async function referencedNames(rows: AuditRow[]): Promise<{ people: Record<string, string>; roles: Record<string, string> }> {
  const people = new Set<string>();
  const roles = new Set<number>();
  for (const r of rows) {
    const m = r.metadata ?? {};
    for (const k of ['removed', 'userId', 'newOwnerId', 'reportedUserId']) if (typeof m[k] === 'string') people.add(m[k] as string);
    if (r.action === 'user.role.assign') for (const k of ['from', 'to']) if (typeof m[k] === 'number') roles.add(m[k] as number);
  }
  const pool = getPool();
  const [p, ro] = await Promise.all([
    people.size ? pool.query<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = ANY($1::text[])', [[...people]]) : { rows: [] },
    roles.size ? pool.query<{ id: number; name: string }>('SELECT id, name FROM roles WHERE id = ANY($1::int[])', [[...roles]]) : { rows: [] },
  ]);
  return {
    people: Object.fromEntries(p.rows.map((r) => [r.id, r.name])),
    roles: Object.fromEntries(ro.rows.map((r) => [String(r.id), r.name])),
  };
}

export default router;
