import { Redis } from 'ioredis';
import { getPool } from '@tupo/db';
import { presenceKey, lastSeenKey } from '@tupo/shared';
import { config } from '../config.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';

/**
 * The realtime admin dashboard.
 *
 * One rule runs through everything here: **a query is either unrestricted
 * (`userIds === null`, a super admin) or it is a `= ANY($ids)` filter on a
 * concrete list of Tupo user ids**. The list is derived once, from the viewer's
 * MIS placement (migration 0023) narrowed by whatever programme / grade they
 * picked, and then threaded verbatim into every aggregate. There is no third
 * state — "scoped to nothing" is an empty list, which every query treats as
 * "no rows", exactly as the MIS's own `resolveUserScope` does.
 */

type Actor = NonNullable<AuthenticatedRequest['user']>;

export interface DashboardScope {
  /** super_admin | program_lead | class_teacher | staff | student | parent | none */
  level: string;
  /** null → the viewer sees the whole institution. */
  unrestricted: boolean;
  /** Programmes / grades / class groups the viewer may filter by. */
  programs: Array<{ id: string; name: string }>;
  grades: Array<{ id: string; name: string }>;
  classGroups: Array<{ id: string; name: string }>;
}

export interface ScopeFilter {
  programId?: string;
  gradeId?: string;
  classGroupId?: string;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Presence (Redis, read-only, fail-soft — everyone reads offline if it is down)
 * ────────────────────────────────────────────────────────────────────────── */

let presenceClient: Redis | null = null;
function presence(): Redis | null {
  if (presenceClient) return presenceClient;
  try {
    presenceClient = new Redis(config.redisUrl, {
      lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: true,
    });
    presenceClient.on('error', () => {});
    void presenceClient.connect().catch(() => {});
  } catch { presenceClient = null; }
  return presenceClient;
}

async function presenceFor(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!ids.length) return out;
  const client = presence();
  if (!client) return out;
  try {
    const values = await client.mget(ids.map(presenceKey));
    ids.forEach((id, i) => { if (values[i]) out[id] = values[i] as string; });
  } catch { /* everyone offline */ }
  return out;
}

async function lastSeenFor(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!ids.length) return out;
  const client = presence();
  if (client) {
    try {
      const values = await client.mget(ids.map(lastSeenKey));
      ids.forEach((id, i) => { if (values[i]) out[id] = values[i] as string; });
    } catch { /* fall through */ }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Scope resolution
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * What the viewer may see and filter by.
 *
 * A Tupo `Admin`, or anyone whose synced `academic_level` is `super_admin`, is
 * unrestricted. A programme lead may filter within their programmes (and the
 * grades under them); a class teacher within their class groups. Anyone else is
 * scoped to nothing but their own row.
 */
export async function resolveScope(actor: Actor): Promise<DashboardScope> {
  const pool = getPool();
  const { rows } = await pool.query<{
    academic_level: string | null;
    mis_program_ids: string[]; mis_grade_ids: string[]; mis_class_group_ids: string[];
    mis_program_names: string[]; mis_grade_names: string[]; mis_class_group_names: string[];
  }>(
    `SELECT academic_level, mis_program_ids, mis_grade_ids, mis_class_group_ids,
            mis_program_names, mis_grade_names, mis_class_group_names
       FROM users WHERE id = $1`,
    [actor.id],
  );
  const me = rows[0];
  const level = me?.academic_level ?? 'none';

  const unrestricted = actor.role === 'admin'
    || actor.permissions.has('USERS_MANAGE')
    || level === 'super_admin';

  if (unrestricted) {
    // Offer the whole institution's programmes and grades as filters, pulled
    // from what every synced user carries.
    const opts = await pool.query<{ kind: string; id: string; name: string }>(
      `SELECT 'program' AS kind, pid AS id, pname AS name
         FROM users, unnest(mis_program_ids, mis_program_names) AS t(pid, pname)
        WHERE pid <> '' GROUP BY pid, pname
       UNION
       SELECT 'grade', gid, gname
         FROM users, unnest(mis_grade_ids, mis_grade_names) AS t(gid, gname)
        WHERE gid <> '' GROUP BY gid, gname
       UNION
       SELECT 'classGroup', cid, cname
         FROM users, unnest(mis_class_group_ids, mis_class_group_names) AS t(cid, cname)
        WHERE cid <> '' GROUP BY cid, cname
       ORDER BY name`,
    );
    return {
      level: 'super_admin', unrestricted: true,
      programs: opts.rows.filter((r) => r.kind === 'program').map((r) => ({ id: r.id, name: r.name })),
      grades: opts.rows.filter((r) => r.kind === 'grade').map((r) => ({ id: r.id, name: r.name })),
      classGroups: opts.rows.filter((r) => r.kind === 'classGroup').map((r) => ({ id: r.id, name: r.name })),
    };
  }

  const zip = (ids: string[], names: string[]) => ids
    .map((id, i) => ({ id, name: names[i] ?? id }))
    .filter((x) => x.id);

  return {
    level,
    unrestricted: false,
    programs: zip(me?.mis_program_ids ?? [], me?.mis_program_names ?? []),
    grades: zip(me?.mis_grade_ids ?? [], me?.mis_grade_names ?? []),
    classGroups: zip(me?.mis_class_group_ids ?? [], me?.mis_class_group_names ?? []),
  };
}

/**
 * The concrete list of Tupo user ids the dashboard aggregates over.
 *
 * `null` means "no filter — the whole institution". Otherwise it is every
 * synced user whose placement arrays overlap the viewer's scope, further
 * narrowed by the programme / grade / class group they selected. The viewer is
 * always in their own list so a scoped-to-nothing lead still sees themselves.
 */
export async function resolveUserIds(
  actor: Actor, scope: DashboardScope, filter: ScopeFilter,
): Promise<string[] | null> {
  const pool = getPool();

  // Which ids is the *selection* allowed to touch?
  const allowProgram = (id?: string) => !id
    || scope.unrestricted || scope.programs.some((p) => p.id === id);
  const allowGrade = (id?: string) => !id
    || scope.unrestricted || scope.grades.some((g) => g.id === id);
  const allowClassGroup = (id?: string) => !id
    || scope.unrestricted || scope.classGroups.some((c) => c.id === id);

  const programId = allowProgram(filter.programId) ? filter.programId : undefined;
  const gradeId = allowGrade(filter.gradeId) ? filter.gradeId : undefined;
  const classGroupId = allowClassGroup(filter.classGroupId) ? filter.classGroupId : undefined;

  if (scope.unrestricted && !programId && !gradeId && !classGroupId) return null;

  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => { params.push(value); clauses.push(sql.replace('$n', `$${params.length}`)); };

  if (!scope.unrestricted) {
    // The viewer's own umbrella: any overlap with the programmes/grades/groups
    // they carry, plus their own row.
    params.push(scope.programs.map((p) => p.id));
    params.push(scope.grades.map((g) => g.id));
    params.push(scope.classGroups.map((c) => c.id));
    params.push(actor.id);
    clauses.push(
      `(mis_program_ids && $${params.length - 3}::text[]
        OR mis_grade_ids && $${params.length - 2}::text[]
        OR mis_class_group_ids && $${params.length - 1}::text[]
        OR id = $${params.length})`,
    );
  }
  if (programId) add('mis_program_ids && ARRAY[$n]::text[]', programId);
  if (gradeId) add('mis_grade_ids && ARRAY[$n]::text[]', gradeId);
  if (classGroupId) add('mis_class_group_ids && ARRAY[$n]::text[]', classGroupId);

  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM users${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`,
    params,
  );
  const ids = rows.map((r) => r.id);
  // Always visible to themselves.
  if (!ids.includes(actor.id)) ids.push(actor.id);
  return ids;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * The aggregate — one payload, one poll
 * ────────────────────────────────────────────────────────────────────────── */

const WINDOWS: Record<string, number> = { '1h': 1, '24h': 24, '7d': 168, '30d': 720 };

export interface DashboardOverview {
  generatedAt: string;
  window: string;
  windowHours: number;
  scopedUsers: number | null;
  people: {
    total: number; onlineNow: number; activeToday: number; active7d: number;
    suspended: number; neverActive: number;
    byStatus: Record<string, number>;
  };
  chat: { messages: number; activeSenders: number; activeConversations: number; dms: number };
  mail: { sent: number; senders: number; unreadBacklog: number; bulk: number };
  feed: { posts: number; reactions: number; comments: number; activeAuthors: number };
  meet: { started: number; participants: number; liveNow: number };
  activitySeries: Array<{ bucket: string; chat: number; mail: number; feed: number }>;
  topPeople: Array<{
    id: string; name: string; avatarUrl: string | null; role: string | null;
    academicLevel: string | null; messages: number; mails: number; posts: number;
    total: number; presence: string; lastSeenAt: string | null;
  }>;
  recent: Array<{
    kind: string; at: string; actorId: string | null; actorName: string | null;
    summary: string;
  }>;
  quiet: Array<{
    id: string; name: string; avatarUrl: string | null; role: string | null;
    lastSeenAt: string | null;
  }>;
}

const scopeSql = (col: string, idx: number) => `($${idx}::text[] IS NULL OR ${col} = ANY($${idx}))`;

export async function overview(
  actor: Actor, filter: ScopeFilter, windowKey: string,
): Promise<DashboardOverview> {
  const pool = getPool();
  const scope = await resolveScope(actor);
  const userIds = await resolveUserIds(actor, scope, filter);
  const w = WINDOWS[windowKey] ?? 24;
  const win = `${w} hours`;
  const bucket = w <= 24 ? 'hour' : 'day';

  // $1 everywhere = the scoped id list (or NULL).
  const p = [userIds];

  const [people, chat, mail, feed, meet, series, top, recent, quiet] = await Promise.all([
    pool.query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE status <> 'active')::int AS suspended,
         count(*) FILTER (WHERE last_seen_at > now() - interval '24 hours')::int AS active_today,
         count(*) FILTER (WHERE last_seen_at > now() - interval '7 days')::int AS active_7d,
         count(*) FILTER (WHERE last_seen_at IS NULL AND last_login_at IS NULL)::int AS never_active,
         jsonb_object_agg(coalesce(nullif(academic_level, ''), 'unknown'), c)
           FILTER (WHERE academic_level IS NOT NULL) AS by_level
       FROM (
         SELECT status, last_seen_at, last_login_at, academic_level,
                count(*) OVER (PARTITION BY academic_level) AS c
           FROM users WHERE ${scopeSql('id', 1)}
       ) u`, p),
    pool.query(
      `SELECT count(*)::int AS messages,
              count(DISTINCT sender_id)::int AS senders,
              count(DISTINCT conversation_id)::int AS conversations
         FROM messages
        WHERE created_at > now() - interval '${win}'
          AND deleted_at IS NULL AND type <> 'system'
          AND ${scopeSql('sender_id', 1)}`, p),
    pool.query(
      `SELECT
         (SELECT count(*) FROM mail_messages
           WHERE created_at > now() - interval '${win}' AND NOT is_draft
             AND ${scopeSql('from_user_id', 1)})::int AS sent,
         (SELECT count(DISTINCT from_user_id) FROM mail_messages
           WHERE created_at > now() - interval '${win}' AND NOT is_draft
             AND ${scopeSql('from_user_id', 1)})::int AS senders,
         (SELECT count(*) FROM mail_messages
           WHERE created_at > now() - interval '${win}' AND NOT is_draft AND campaign_id IS NOT NULL
             AND ${scopeSql('from_user_id', 1)})::int AS bulk,
         (SELECT count(*) FROM mail_recipients
           WHERE NOT is_read AND folder = 'inbox' AND NOT is_hidden AND user_id IS NOT NULL
             AND ${scopeSql('user_id', 1)})::int AS unread_backlog`, p),
    pool.query(
      `SELECT
         (SELECT count(*) FROM feed_posts
           WHERE published_at > now() - interval '${win}' AND status = 'published' AND deleted_at IS NULL
             AND ${scopeSql('author_id', 1)})::int AS posts,
         (SELECT count(DISTINCT author_id) FROM feed_posts
           WHERE published_at > now() - interval '${win}' AND status = 'published' AND deleted_at IS NULL
             AND ${scopeSql('author_id', 1)})::int AS authors,
         (SELECT count(*) FROM feed_reactions
           WHERE created_at > now() - interval '${win}' AND ${scopeSql('user_id', 1)})::int AS reactions,
         (SELECT count(*) FROM feed_comments
           WHERE created_at > now() - interval '${win}' AND deleted_at IS NULL
             AND ${scopeSql('author_id', 1)})::int AS comments`, p),
    pool.query(
      `SELECT
         (SELECT count(DISTINCT m.id) FROM meetings m
           WHERE m.started_at > now() - interval '${win}'
             AND ${scopeSql('m.host_id', 1)})::int AS started,
         (SELECT count(*) FROM meeting_participants mp
           JOIN meetings m ON m.id = mp.meeting_id
           WHERE m.started_at > now() - interval '${win}' AND mp.user_id IS NOT NULL
             AND ${scopeSql('mp.user_id', 1)})::int AS participants,
         (SELECT count(DISTINCT m.id) FROM meetings m
           WHERE m.status = 'live' AND ${scopeSql('m.host_id', 1)})::int AS live_now`, p),
    pool.query(
      `WITH buckets AS (
         SELECT generate_series(
           date_trunc('${bucket}', now() - interval '${win}'),
           date_trunc('${bucket}', now()),
           interval '1 ${bucket}') AS b
       )
       SELECT to_char(b.b, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS bucket,
         (SELECT count(*) FROM messages
           WHERE date_trunc('${bucket}', created_at) = b.b AND type <> 'system' AND deleted_at IS NULL
             AND ${scopeSql('sender_id', 1)})::int AS chat,
         (SELECT count(*) FROM mail_messages
           WHERE date_trunc('${bucket}', created_at) = b.b AND NOT is_draft
             AND ${scopeSql('from_user_id', 1)})::int AS mail,
         (SELECT count(*) FROM feed_posts
           WHERE date_trunc('${bucket}', coalesce(published_at, created_at)) = b.b AND deleted_at IS NULL
             AND ${scopeSql('author_id', 1)})::int AS feed
       FROM buckets b ORDER BY b.b`, p),
    pool.query(
      `WITH activity AS (
         SELECT sender_id AS uid, count(*) AS messages, 0 AS mails, 0 AS posts
           FROM messages
          WHERE created_at > now() - interval '${win}' AND type <> 'system' AND deleted_at IS NULL
            AND ${scopeSql('sender_id', 1)}
          GROUP BY sender_id
         UNION ALL
         SELECT from_user_id, 0, count(*), 0 FROM mail_messages
          WHERE created_at > now() - interval '${win}' AND NOT is_draft
            AND ${scopeSql('from_user_id', 1)}
          GROUP BY from_user_id
         UNION ALL
         SELECT author_id, 0, 0, count(*) FROM feed_posts
          WHERE published_at > now() - interval '${win}' AND deleted_at IS NULL
            AND ${scopeSql('author_id', 1)}
          GROUP BY author_id
       )
       SELECT u.id, u.name, u.avatar_url, u.role, u.academic_level,
              sum(a.messages)::int AS messages, sum(a.mails)::int AS mails, sum(a.posts)::int AS posts,
              (sum(a.messages) + sum(a.mails) + sum(a.posts))::int AS total
         FROM activity a JOIN users u ON u.id = a.uid
        GROUP BY u.id, u.name, u.avatar_url, u.role, u.academic_level
        ORDER BY total DESC
        LIMIT 8`, p),
    pool.query(
      `(SELECT 'message' AS kind, m.created_at AS at, m.sender_id AS actor_id,
               su.name AS actor_name, coalesce(c.name, 'a direct message') AS ctx
          FROM messages m JOIN users su ON su.id = m.sender_id
          LEFT JOIN conversations c ON c.id = m.conversation_id
         WHERE m.created_at > now() - interval '${win}' AND m.type <> 'system' AND m.deleted_at IS NULL
           AND ${scopeSql('m.sender_id', 1)}
         ORDER BY m.created_at DESC LIMIT 8)
       UNION ALL
       (SELECT 'mail', mm.created_at, mm.from_user_id, mm.from_name, mm.subject
          FROM mail_messages mm
         WHERE mm.created_at > now() - interval '${win}' AND NOT mm.is_draft
           AND ${scopeSql('mm.from_user_id', 1)}
         ORDER BY mm.created_at DESC LIMIT 8)
       UNION ALL
       (SELECT 'post', fp.published_at, fp.author_id, au.name, fpg.name
          FROM feed_posts fp JOIN users au ON au.id = fp.author_id
          JOIN feed_pages fpg ON fpg.id = fp.page_id
         WHERE fp.published_at > now() - interval '${win}' AND fp.deleted_at IS NULL AND fp.status = 'published'
           AND ${scopeSql('fp.author_id', 1)}
         ORDER BY fp.published_at DESC LIMIT 8)
       UNION ALL
       (SELECT 'login', a.created_at, a.actor_id, u.name, ''
          FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.action = 'auth.login' AND a.created_at > now() - interval '${win}'
           AND ${scopeSql('a.actor_id', 1)}
         ORDER BY a.created_at DESC LIMIT 8)
       ORDER BY at DESC LIMIT 20`, p),
    pool.query(
      `SELECT id, name, avatar_url, role, last_seen_at
         FROM users
        WHERE ${scopeSql('id', 1)}
          AND status = 'active'
          AND (last_seen_at IS NULL OR last_seen_at < now() - interval '7 days')
          AND academic_level IN ('student', 'staff', 'class_teacher', 'program_lead')
        ORDER BY last_seen_at ASC NULLS FIRST
        LIMIT 8`, p),
  ]);

  const topRows = top.rows as Array<{
    id: string; name: string; avatar_url: string | null; role: string | null;
    academic_level: string | null; messages: number; mails: number; posts: number; total: number;
  }>;
  const topIds = topRows.map((r) => r.id);
  const [online, seen] = await Promise.all([presenceFor(topIds), lastSeenFor(topIds)]);

  // Online-now count across the whole scoped set — capped scan so a
  // whole-institution view does not mget a hundred thousand keys.
  const scanIds = userIds
    ? userIds
    : (await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE last_seen_at > now() - interval '20 minutes' LIMIT 5000`,
      )).rows.map((r) => r.id);
  const onlineMap = await presenceFor(scanIds);
  const onlineNow = Object.values(onlineMap).filter((s) => s && s !== 'offline').length;

  const pr = people.rows[0] as {
    total: number; suspended: number; active_today: number; active_7d: number;
    never_active: number; by_level: Record<string, number> | null;
  };
  const cr = chat.rows[0] as { messages: number; senders: number; conversations: number };
  const mr = mail.rows[0] as { sent: number; senders: number; bulk: number; unread_backlog: number };
  const fr = feed.rows[0] as { posts: number; authors: number; reactions: number; comments: number };
  const mt = meet.rows[0] as { started: number; participants: number; live_now: number };

  const dmCount = (await pool.query<{ n: number }>(
    `SELECT count(DISTINCT m.conversation_id)::int AS n
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.created_at > now() - interval '${win}' AND c.type = 'dm' AND m.type <> 'system'
        AND ${scopeSql('m.sender_id', 1)}`, p)).rows[0]?.n ?? 0;

  const summarise = (kind: string, name: string | null, ctx: string): string => {
    const who = name ?? 'Someone';
    if (kind === 'message') return `${who} messaged in ${ctx}`;
    if (kind === 'mail') return `${who} sent mail — “${ctx}”`;
    if (kind === 'post') return `${who} posted to ${ctx || 'the feed'}`;
    if (kind === 'login') return `${who} signed in`;
    return `${who} — ${kind}`;
  };

  return {
    generatedAt: new Date().toISOString(),
    window: windowKey,
    windowHours: w,
    scopedUsers: userIds ? userIds.length : null,
    people: {
      total: pr.total,
      onlineNow,
      activeToday: pr.active_today,
      active7d: pr.active_7d,
      suspended: pr.suspended,
      neverActive: pr.never_active,
      byStatus: pr.by_level ?? {},
    },
    chat: {
      messages: cr.messages, activeSenders: cr.senders,
      activeConversations: cr.conversations, dms: dmCount,
    },
    mail: { sent: mr.sent, senders: mr.senders, unreadBacklog: mr.unread_backlog, bulk: mr.bulk },
    feed: { posts: fr.posts, reactions: fr.reactions, comments: fr.comments, activeAuthors: fr.authors },
    meet: { started: mt.started, participants: mt.participants, liveNow: mt.live_now },
    activitySeries: (series.rows as Array<{ bucket: string; chat: number; mail: number; feed: number }>),
    topPeople: topRows.map((r) => ({
      id: r.id, name: r.name, avatarUrl: r.avatar_url, role: r.role,
      academicLevel: r.academic_level,
      messages: r.messages, mails: r.mails, posts: r.posts, total: r.total,
      presence: online[r.id] ?? 'offline', lastSeenAt: seen[r.id] ?? null,
    })),
    recent: (recent.rows as Array<{
      kind: string; at: string; actor_id: string | null; actor_name: string | null; ctx: string;
    }>).map((r) => ({
      kind: r.kind, at: r.at, actorId: r.actor_id, actorName: r.actor_name,
      summary: summarise(r.kind, r.actor_name, r.ctx),
    })),
    quiet: (quiet.rows as Array<{
      id: string; name: string; avatar_url: string | null; role: string | null; last_seen_at: string | null;
    }>).map((r) => ({
      id: r.id, name: r.name, avatarUrl: r.avatar_url, role: r.role, lastSeenAt: r.last_seen_at,
    })),
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Who is online right now — the live panel
 * ────────────────────────────────────────────────────────────────────────── */

export interface OnlinePerson {
  id: string; name: string; avatarUrl: string | null; role: string | null;
  academicLevel: string | null; status: string; lastSeenAt: string | null;
}

export async function onlineRoster(actor: Actor, filter: ScopeFilter): Promise<{
  people: OnlinePerson[]; total: number;
}> {
  const pool = getPool();
  const scope = await resolveScope(actor);
  const userIds = await resolveUserIds(actor, scope, filter);

  const { rows } = await pool.query<{
    id: string; name: string; avatar_url: string | null; role: string | null;
    academic_level: string | null; last_seen_at: string | null;
  }>(
    `SELECT id, name, avatar_url, role, academic_level, last_seen_at
       FROM users
      WHERE ${scopeSql('id', 1)} AND status = 'active'
        AND last_seen_at > now() - interval '30 minutes'
      ORDER BY last_seen_at DESC
      LIMIT 200`,
    [userIds],
  );
  const ids = rows.map((r) => r.id);
  const [online, seen] = await Promise.all([presenceFor(ids), lastSeenFor(ids)]);

  const people = rows
    .map((r) => ({
      id: r.id, name: r.name, avatarUrl: r.avatar_url, role: r.role,
      academicLevel: r.academic_level,
      status: online[r.id] ?? 'offline',
      lastSeenAt: seen[r.id] ?? r.last_seen_at,
    }))
    .filter((r) => r.status !== 'offline')
    .sort((a, b) => a.name.localeCompare(b.name));

  return { people, total: people.length };
}
