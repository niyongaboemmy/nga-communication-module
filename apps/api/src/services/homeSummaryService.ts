import { getPool } from '@tupo/db';
import * as chat from '@tupo/chat';
import * as mail from '@tupo/mail';
import * as feed from '@tupo/feed';
import { config } from '../config.js';
import { decideForRequest, hasPermission } from '../access/gate.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';

/**
 * The MIS Home summary (HOME_OVERVIEW_IMPLEMENTATION_PLAN §6/§9, "Tupo").
 *
 * Everything that needs the signed-in person in Tupo, in the shape the MIS
 * Home page merges across apps. Strictly read-only: every number comes from
 * the same counter the Tupo UI already shows (chat totalUnread, mail
 * mailboxCounts, the meetings list's visibility rule) or a plain COUNT, and
 * nothing here writes a row.
 *
 * Signals:
 *   M-01  unread mentions / direct messages      slipping if mentions, else tidy
 *   M-02  meeting live now or starting ≤ 15 min  blocking while live, else slipping
 *   P-07  bulk sends awaiting MY approval        blocking (approver ≠ sender)
 *   O-05  open moderation reports                slipping, count only
 * Updates: the person's notifications of the last 7 days, minus `chat.*`
 * (the chat counters already carry those).
 */

export type Tier = 'blocking' | 'slipping' | 'tidy';

export interface AttentionItem {
  id: string;
  source: 'tupo';
  kind: string;
  tier: Tier;
  lens: string;
  via: number[];
  depth: 'summary' | 'detail' | 'write';
  count: number;
  title: string;
  entities: string[];
  why: string;
  cta: { label: string; href: string; external: true };
  due_at?: string | null;
  waiting_since?: string | null;
}

export interface UpdateItem {
  id: string; source: 'tupo'; kind: string; title: string; body: string | null;
  severity: 'info' | 'success' | 'warning' | 'critical'; created_at: string; read: boolean; href: string | null;
}

export interface CommsBlock {
  chat_unread: number;
  mentions: number;
  mail_unread: number;
  meetings: { id: string; title: string; starts_at: string; live: boolean; href: string }[];
}

export interface HomeSummary {
  version: 1;
  source: 'tupo';
  generated_at: string;
  provisioned: boolean;
  items: AttentionItem[];
  tiles: never[];
  updates: UpdateItem[];
  comms?: CommsBlock;
  app_url: string;
}

export interface LensHint { key: string; type: string; class_group_ids: number[] | null }

export interface SummaryInput { date: string; tz: string; lenses: LensHint[] }

export const DEFAULT_TZ = 'Africa/Kigali';
const MAX_ENTITIES = 8;
const MEETING_SOON_MIN = 15;
/** Hint caps: the body is untrusted, so oversized arrays are cut, not refused. */
const MAX_LENSES = 50;
const MAX_LENS_GROUPS = 500;

/* ────────────────────────────────────────────────────────────────────────── *
 * Input
 * ────────────────────────────────────────────────────────────────────────── */

const validTz = (tz: unknown): tz is string => {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

/** A real calendar day (no 2026-02-31, no year 0) in a sane range. */
const validDate = (d: unknown): d is string => {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const year = Number(d.slice(0, 4));
  if (year < 1970 || year > 2999) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};

/** Today's calendar date in a time zone, as YYYY-MM-DD. */
export function todayIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now);
}

/** How far `tz` is ahead of UTC at instant `t`, in ms. */
function offsetMs(tz: string, t: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(t));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(t / 1000) * 1000;
}

/** The UTC instant of local midnight starting `date` in `tz`. */
function zonedMidnight(date: string, tz: string): Date {
  const wall = Date.parse(`${date}T00:00:00Z`);
  // Two passes settle the offset even when midnight sits next to a DST change.
  let t = wall - offsetMs(tz, wall);
  t = wall - offsetMs(tz, t);
  return new Date(t);
}

/**
 * [start, end) of a school-local day as UTC instants. Worked out here rather
 * than with Postgres `AT TIME ZONE`: Intl (which validated the zone) and
 * Postgres disagree on some names and read "+02:00" with opposite signs.
 */
export function zonedDayRange(date: string, tz: string): { start: Date; end: Date } {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { start: zonedMidnight(date, tz), end: zonedMidnight(next, tz) };
}

/** Whole positive ids only; "12" is read as 12, true / 1.5 / -3 are dropped. */
const groupId = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * The body is all hints, so it is read leniently: anything malformed falls
 * back to the default rather than failing the whole Home page.
 */
export function parseSummaryInput(body: unknown): SummaryInput {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const tz = validTz(b.tz) ? b.tz : DEFAULT_TZ;
  const date = validDate(b.date) ? b.date : todayIn(tz);
  const lenses: LensHint[] = (Array.isArray(b.lenses) ? b.lenses : []).slice(0, MAX_LENSES).flatMap((l) => {
    const x = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    if (typeof x.key !== 'string' || !x.key || typeof x.type !== 'string') return [];
    const ids = x.class_group_ids === null ? null
      : Array.isArray(x.class_group_ids)
        ? x.class_group_ids.slice(0, MAX_LENS_GROUPS).map(groupId).filter((n): n is number => n !== null)
        : [];
    return [{ key: x.key.slice(0, 64), type: x.type.slice(0, 32).toUpperCase(), class_group_ids: ids }];
  });
  return { date, tz, lenses };
}

/**
 * Lens for a school-wide duty (approving bulk mail, moderating the feed):
 * the hinted SCHOOL lens when there is one, else SELF. Nothing in Tupo belongs
 * to a class group, so the narrower lenses never match. Hints label items;
 * they never decide who sees them.
 */
function schoolLens(lenses: LensHint[]): string {
  return lenses.find((l) => l.type === 'SCHOOL' && l.class_group_ids === null)?.key ?? 'SELF';
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Helpers
 * ────────────────────────────────────────────────────────────────────────── */

const link = (path: string) => `${config.appPublicUrl}${path.startsWith('/') ? path : `/${path}`}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

/**
 * How deep the viewer may look at a school-wide queue. Only enforce mode has a
 * scoped v2 decision to ask; the local RBAC set is global, so a holder of the
 * permission sees the queue in full, which is what the Tupo UI shows them.
 */
function depthFor(req: unknown, cap: string): 'summary' | 'detail' {
  const d = decideForRequest(req, cap);
  if (!d) return 'detail';
  return d.depth === 'summary' ? 'summary' : 'detail';
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Comms block
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Meetings for the day: live now, or scheduled on `date` (school-local), that
 * the person hosts or was invited to and did not decline. The Tupo meetings
 * list's own "mine" rule, narrowed to today.
 */
async function meetingsToday(userId: string, date: string, tz: string): Promise<CommsBlock['meetings']> {
  const { start, end } = zonedDayRange(date, tz);
  const { rows } = await getPool().query<{
    id: string; title: string; join_code: string; status: string;
    scheduled_start: Date | null; started_at: Date | null; created_at: Date;
  }>(
    `SELECT m.id, m.title, m.join_code, m.status, m.scheduled_start, m.started_at, m.created_at
       FROM meetings m
      WHERE (m.host_id = $1
             OR EXISTS (SELECT 1 FROM meeting_invites i
                         WHERE i.meeting_id = m.id AND i.user_id = $1 AND i.response <> 'declined'))
        AND (m.status = 'live'
             OR (m.status = 'scheduled' AND m.scheduled_start >= $2 AND m.scheduled_start < $3))
      ORDER BY (m.status = 'live') DESC, COALESCE(m.started_at, m.scheduled_start) ASC, m.id
      LIMIT 10`,
    [userId, start, end],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    starts_at: iso(r.status === 'live' ? (r.started_at ?? r.scheduled_start ?? r.created_at) : r.scheduled_start)!,
    live: r.status === 'live',
    href: link(`/app/meet/${encodeURIComponent(r.join_code)}`),
  }));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Signals
 * ────────────────────────────────────────────────────────────────────────── */

/** M-01 — the person's own unread direct messages and @-mentions. */
async function unreadMentionsAndDms(userId: string): Promise<AttentionItem | null> {
  // Same membership filter as chat.totalUnread (the rail badge): live
  // conversations the person has not left or muted entirely.
  // The totals are window sums over every matching conversation; only the
  // chips are cut to the first few.
  const { rows } = await getPool().query<{ label: string; dms: string; mentions: string }>(
    `SELECT COALESCE(NULLIF(c.name, ''), peer.name,
                     CASE WHEN c.type = 'dm' THEN 'Direct message' ELSE 'Group chat' END) AS label,
            sum(CASE WHEN c.type = 'dm' THEN m.unread_count ELSE 0 END) OVER ()::text AS dms,
            sum(CASE WHEN c.type = 'dm' THEN 0 ELSE m.unread_mentions END) OVER ()::text AS mentions
       FROM conversation_members m
       JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN LATERAL (
         SELECT u.name FROM conversation_members pm JOIN users u ON u.id = pm.user_id
          WHERE pm.conversation_id = c.id AND pm.user_id <> $1
          LIMIT 1
       ) peer ON c.type = 'dm'
      WHERE m.user_id = $1 AND m.left_at IS NULL
        AND c.deleted_at IS NULL AND m.notification <> 'none'
        AND ((c.type = 'dm' AND m.unread_count > 0) OR m.unread_mentions > 0)
      ORDER BY m.unread_mentions DESC, m.unread_count DESC, c.id
      LIMIT 50`,
    [userId],
  );
  if (!rows.length) return null;

  const mentions = Number(rows[0]!.mentions);
  const dms = Number(rows[0]!.dms);
  const count = mentions + dms;
  if (count === 0) return null;

  const parts = [
    mentions ? plural(mentions, 'unread mention') : '',
    dms ? plural(dms, 'unread direct message') : '',
  ].filter(Boolean);
  return {
    id: 'tupo:M-01:SELF',
    source: 'tupo',
    kind: 'M-01',
    tier: mentions > 0 ? 'slipping' : 'tidy',
    lens: 'SELF',
    via: [],
    depth: 'detail',
    count,
    title: parts.join(' and '),
    entities: [...new Set(rows.map((r) => r.label))].slice(0, MAX_ENTITIES),
    why: mentions > 0
      ? 'Someone asked for you by name and is waiting on a reply.'
      : 'Direct messages go stale if nobody answers them.',
    cta: { label: 'Open chat', href: link('/app/chat'), external: true },
    waiting_since: null,
  };
}

/** M-02 — a meeting the person belongs in is live, or starts within 15 minutes. */
async function meetingNow(userId: string): Promise<AttentionItem | null> {
  const { rows } = await getPool().query<{
    id: string; title: string; join_code: string; status: string; scheduled_start: Date | null;
    total: string; live_total: string;
  }>(
    `SELECT m.id, m.title, m.join_code, m.status, m.scheduled_start,
            count(*) OVER ()::text AS total,
            count(*) FILTER (WHERE m.status = 'live') OVER ()::text AS live_total
       FROM meetings m
      WHERE (m.host_id = $1
             OR EXISTS (SELECT 1 FROM meeting_invites i
                         WHERE i.meeting_id = m.id AND i.user_id = $1 AND i.response <> 'declined'))
        AND (
              (m.status = 'live'
               -- Already in the room: nothing to act on.
               AND NOT EXISTS (SELECT 1 FROM meeting_participants p
                                WHERE p.meeting_id = m.id AND p.user_id = $1
                                  AND p.state IN ('active','connecting','reconnecting')))
           OR (m.status = 'scheduled'
               AND m.scheduled_start <= now() + make_interval(mins => $2)
               AND COALESCE(m.scheduled_end, m.scheduled_start + interval '1 hour') > now())
        )
      ORDER BY (m.status = 'live') DESC, m.scheduled_start ASC NULLS LAST, m.id
      LIMIT $3`,
    [userId, MEETING_SOON_MIN, MAX_ENTITIES],
  );
  if (!rows.length) return null;

  const total = Number(rows[0]!.total);
  const live = Number(rows[0]!.live_total);
  const soon = total - live;
  const first = rows[0]!;
  const nextStart = rows.filter((r) => r.status === 'scheduled' && r.scheduled_start)
    .map((r) => r.scheduled_start!)[0] ?? null;
  const title = live
    ? `${plural(live, 'meeting')} of yours ${live === 1 ? 'is' : 'are'} live now`
      + (soon ? `, ${soon} more starting soon` : '')
    : `${plural(soon, 'meeting')} starting within ${MEETING_SOON_MIN} minutes`;
  return {
    id: 'tupo:M-02:SELF',
    source: 'tupo',
    kind: 'M-02',
    tier: live > 0 ? 'blocking' : 'slipping',
    lens: 'SELF',
    via: [],
    depth: 'detail',
    count: total,
    title,
    entities: rows.map((r) => r.title).slice(0, MAX_ENTITIES),
    why: live > 0 ? 'The meeting has started without you.' : 'It starts in a few minutes.',
    cta: total === 1
      ? { label: first.status === 'live' ? 'Join now' : 'Open meeting', href: link(`/app/meet/${encodeURIComponent(first.join_code)}`), external: true }
      : { label: 'Open meetings', href: link('/app/meet'), external: true },
    due_at: iso(nextStart),
  };
}

/**
 * P-07 — bulk sends waiting for approval that this person may approve. Their
 * own submissions are excluded: approveCampaign refuses self-approval, so
 * those are not theirs to act on. So are sends going out in their name that
 * someone else drafted — the approver must not be the sender.
 */
async function campaignsToApprove(req: unknown, userId: string, lens: string): Promise<AttentionItem | null> {
  if (!hasPermission(req, 'MAIL_APPROVE')) return null;
  const { rows } = await getPool().query<{ subject: string; name: string; updated_at: Date; total: string }>(
    `SELECT subject, name, updated_at, count(*) OVER ()::text AS total FROM mail_campaigns
      WHERE status = 'pending_approval' AND created_by <> $1 AND from_user_id <> $1
      ORDER BY updated_at ASC, id
      LIMIT $2`,
    [userId, MAX_ENTITIES],
  );
  if (!rows.length) return null;
  const count = Number(rows[0]!.total);
  const depth = depthFor(req, 'MAIL_APPROVE');
  return {
    id: `tupo:P-07:${lens}`,
    source: 'tupo',
    kind: 'P-07',
    tier: 'blocking',
    lens,
    via: [],
    depth,
    count,
    title: `${plural(count, 'bulk mail send')} waiting for your approval`,
    entities: depth === 'summary' ? [] : rows.map((r) => r.subject || r.name || 'Untitled').slice(0, MAX_ENTITIES),
    why: 'Nothing goes out until an approver other than the sender signs it off.',
    cta: { label: 'Review campaigns', href: link('/app/mail/campaigns'), external: true },
    waiting_since: iso(rows[0]!.updated_at),
  };
}

/** O-05 — open feed moderation reports. Counts only; the queue shows the content. */
async function openReports(req: unknown, lens: string): Promise<AttentionItem | null> {
  if (!hasPermission(req, 'MODERATION_QUEUE_VIEW')) return null;
  const { count, oldestAt } = await feed.moderation.openReportCount();
  if (!count) return null;
  return {
    id: `tupo:O-05:${lens}`,
    source: 'tupo',
    kind: 'O-05',
    tier: 'slipping',
    lens,
    via: [],
    depth: 'summary',
    count,
    title: `${plural(count, 'reported post or comment', 'reported posts or comments')} to review`,
    entities: [],
    why: 'Reported content stays visible on the feed until a moderator acts on it.',
    cta: { label: 'Open moderation queue', href: link('/app/feed/moderation'), external: true },
    waiting_since: oldestAt,
  };
}

/** The person's notifications from the last 7 days, unread first, minus chat. */
async function recentUpdates(userId: string): Promise<UpdateItem[]> {
  const { rows } = await getPool().query<{
    id: string; kind: string; title: string; body: string | null; link: string | null;
    read_at: Date | null; created_at: Date;
  }>(
    `SELECT id, kind, title, body, link, read_at, created_at
       FROM notifications
      WHERE user_id = $1 AND created_at >= now() - interval '7 days'
        AND kind NOT LIKE 'chat.%'
      ORDER BY (read_at IS NULL) DESC, created_at DESC, id
      LIMIT 10`,
    [userId],
  );
  return rows.map((r) => ({
    id: `tupo:notification:${r.id}`,
    source: 'tupo',
    kind: r.kind,
    title: r.title,
    body: r.body,
    severity: r.kind === 'meet.live' ? 'warning' : 'info',
    created_at: iso(r.created_at)!,
    read: r.read_at !== null,
    // Stored links are in-app paths by construction (see migration 0009).
    href: r.link && r.link.startsWith('/') && !r.link.startsWith('//') ? link(r.link) : null,
  }));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Entry points
 * ────────────────────────────────────────────────────────────────────────── */

/** The answer for a MIS user with no Tupo account yet. Nothing is created. */
export function unprovisionedSummary(): HomeSummary {
  return {
    version: 1, source: 'tupo', generated_at: new Date().toISOString(), provisioned: false,
    items: [], tiles: [], updates: [], app_url: config.appPublicUrl,
  };
}

const TIER_ORDER: Record<Tier, number> = { blocking: 0, slipping: 1, tidy: 2 };

export async function buildHomeSummary(req: AuthenticatedRequest, input: SummaryInput): Promise<HomeSummary> {
  const me = req.user!;
  const lens = schoolLens(input.lenses);

  const [totals, mailbox, meetings, m01, m02, p07, o05, updates] = await Promise.all([
    chat.totalUnread(me.id),
    // Same gate as GET /api/mail/counts.
    hasPermission(req, 'MAIL_READ') ? mail.mailboxCounts(me.id) : Promise.resolve(null),
    meetingsToday(me.id, input.date, input.tz),
    unreadMentionsAndDms(me.id),
    meetingNow(me.id),
    campaignsToApprove(req, me.id, lens),
    openReports(req, lens),
    recentUpdates(me.id),
  ]);

  const items = [m02, p07, o05, m01].filter((i): i is AttentionItem => i !== null)
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);

  return {
    version: 1,
    source: 'tupo',
    generated_at: new Date().toISOString(),
    provisioned: true,
    items,
    tiles: [],
    updates,
    comms: {
      chat_unread: totals.unread,
      mentions: totals.mentions,
      mail_unread: mailbox?.inbox ?? 0,
      meetings,
    },
    app_url: config.appPublicUrl,
  };
}
