import { getPool } from '@tupo/db';

/**
 * Meeting reminders, delivered by the NGA MIS Reminder Hub.
 *
 * Tupo does not schedule "your meeting starts in 10 minutes" itself. The MIS
 * already owns every person's reminder preferences, their Web Push devices and
 * their calendar feed, so Tupo *describes* each scheduled meeting to the MIS
 * Source API and the Hub decides when and how to remind people.
 *
 *   PUT    {MIS}/reminders/sources/batch          { items: [...] }  (≤ 200)
 *   PUT    {MIS}/reminders/sources                 one item
 *   DELETE {MIS}/reminders/sources/tupo/meeting/<external_id>
 *
 * Re-sending an item with the same `external_id` replaces it — new time, new
 * title, new audience — and the Hub withdraws pending reminders from anyone no
 * longer in the audience. That makes every call here idempotent, which is what
 * lets the API fire them without waiting and lets the worker's sweep repeat
 * them as a backstop.
 *
 * Lives in @tupo/notify because both tupo-api (on every schedule / edit /
 * cancel) and tupo-worker (the sweep) need exactly the same item for a meeting.
 * Configuration is read from the environment for the same reason the Redis
 * URL is — see the note at the top of index.ts.
 */

export const REMINDER_SOURCE_APP = 'tupo';
export const REMINDER_SOURCE_TYPE = 'meeting';
/** The Source API's per-request item limit. */
export const REMINDER_BATCH_LIMIT = 200;
/** The Source API's per-item audience limit. */
export const REMINDER_MAX_AUDIENCE = 5000;
/** How far ahead the sweep looks. The Hub plans nothing further out anyway. */
export const REMINDER_SWEEP_HORIZON_DAYS = 14;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ReminderItem {
  source_app: typeof REMINDER_SOURCE_APP;
  source_type: typeof REMINDER_SOURCE_TYPE;
  external_id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  link: string;
  location: string | null;
  critical: boolean;
  audience_user_ids: number[];
}

export interface ReminderConfig {
  misBaseUrl: string;
  clientId: string;
  clientSecret: string;
  /** The SPA's public origin, for the join link. */
  appPublicUrl: string;
  /** False when switched off, under test, or without credentials. */
  enabled: boolean;
  /** Why it is disabled, for one honest log line. */
  disabledReason: string | null;
}

/** What went over the wire. The transport is swapped out in tests. */
export interface ReminderRequest {
  method: 'PUT' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}
export interface ReminderResponse { status: number; body: unknown }
export type ReminderTransport = (req: ReminderRequest) => Promise<ReminderResponse>;

const PLACEHOLDER_SECRET = 'placeholder_client_secret';

/**
 * Read the configuration from the environment.
 *
 * The same variable names, and the same defaults, as apps/api/src/config.ts —
 * the Hub authenticates Tupo with the very client credentials Tupo already uses
 * for the SSO exchange, so there is no second secret to provision or leak.
 */
export function reminderConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ReminderConfig {
  const misBaseUrl = (env.NGA_MIS_BASE_URL ?? 'https://mis.amashuri.com').replace(/\/+$/, '');
  const clientId = (env.SSO_CLIENT_ID ?? 'tupo').trim();
  const rawSecret = (env.SSO_CLIENT_SECRET ?? '').trim();
  const clientSecret = rawSecret === PLACEHOLDER_SECRET ? '' : rawSecret;
  const appPublicUrl = (env.APP_PUBLIC_URL
    ?? (env.CORS_ORIGINS ?? 'http://localhost:5194').split(',')[0]!.trim())
    .replace(/\/+$/, '');

  const flag = (env.REMINDERS_SYNC ?? '').trim().toLowerCase();
  let disabledReason: string | null = null;
  if (['false', 'off', '0', 'no'].includes(flag)) disabledReason = 'REMINDERS_SYNC is off';
  else if (env.NODE_ENV === 'test') disabledReason = 'NODE_ENV is test';
  else if (!clientId || !clientSecret) disabledReason = 'SSO_CLIENT_ID / SSO_CLIENT_SECRET are not set';

  return { misBaseUrl, clientId, clientSecret, appPublicUrl, enabled: !disabledReason, disabledReason };
}

/** Global fetch with a hard timeout: a hung MIS must never hold a worker slot. */
export const fetchTransport: ReminderTransport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* empty or non-JSON body */ }
  return { status: res.status, body };
};

/* ------------------------------------------------------------------ *
 * Overrides (tests, and anything that wants to pin its own config)
 * ------------------------------------------------------------------ */

let configOverride: Partial<ReminderConfig> | null = null;
let transport: ReminderTransport = fetchTransport;

export function configureReminders(opts: {
  config?: Partial<ReminderConfig> | null; transport?: ReminderTransport | null;
}): void {
  if (opts.config !== undefined) configOverride = opts.config;
  if (opts.transport !== undefined) transport = opts.transport ?? fetchTransport;
}

export function resetReminders(): void {
  configOverride = null;
  transport = fetchTransport;
  inFlight.clear();
}

export function reminderConfig(): ReminderConfig {
  const base = reminderConfigFromEnv();
  if (!configOverride) return base;
  const merged = { ...base, ...configOverride };
  if (configOverride.enabled === true) merged.disabledReason = null;
  return merged;
}

/* ------------------------------------------------------------------ *
 * Building items
 * ------------------------------------------------------------------ */

export const meetingExternalId = (meetingId: string) => `meeting-${meetingId}`;

/** The row shape the builder needs — a subset of `meetings`. */
export interface ReminderMeetingRow {
  id: string;
  title: string;
  status: string;
  join_code: string;
  scheduled_start: Date | null;
  scheduled_end: Date | null;
}

/**
 * Why a meeting gets no reminder. `cancel` means any reminder already sent to
 * the Hub must be withdrawn; `skip` means there is nothing to say (an instant
 * meeting, one already live, one whose start has passed).
 */
export type ReminderDecision =
  | { action: 'sync'; item: ReminderItem }
  | { action: 'cancel'; reason: string }
  | { action: 'skip'; reason: string };

/**
 * MIS user ids are positive integers. Tupo stores them as text, and a value
 * that does not parse is not something the Hub can address — it is dropped
 * rather than sent to fail the whole item.
 */
export function toMisUserIds(misUserIds: Iterable<string | number | null | undefined>): number[] {
  const out = new Set<number>();
  for (const raw of misUserIds) {
    if (raw === null || raw === undefined) continue;
    const s = String(raw).trim();
    if (!/^\d+$/.test(s)) continue;
    const n = Number(s);
    if (Number.isSafeInteger(n) && n > 0) out.add(n);
  }
  return [...out];
}

export function decideMeetingReminder(
  m: ReminderMeetingRow,
  audienceMisUserIds: Iterable<string | number | null | undefined>,
  cfg: Pick<ReminderConfig, 'appPublicUrl'>,
  now: Date = new Date(),
): ReminderDecision {
  if (m.status === 'cancelled' || m.status === 'ended') {
    return { action: 'cancel', reason: `meeting is ${m.status}` };
  }
  // Only a meeting still waiting to happen is worth a reminder. A live one has
  // started (an instant call is born live) and the Hub has nothing to add.
  if (m.status !== 'scheduled') return { action: 'skip', reason: `meeting is ${m.status}` };
  if (!m.scheduled_start) return { action: 'skip', reason: 'no scheduled start' };
  const start = new Date(m.scheduled_start);
  if (Number.isNaN(start.getTime())) return { action: 'skip', reason: 'invalid scheduled start' };
  if (start.getTime() <= now.getTime()) return { action: 'skip', reason: 'start has passed' };

  const audience = toMisUserIds(audienceMisUserIds).slice(0, REMINDER_MAX_AUDIENCE);
  // The Hub refuses an item with nobody to remind; withdrawing is the honest
  // equivalent (everyone who had it has since been removed).
  if (!audience.length) return { action: 'cancel', reason: 'nobody to remind' };

  const end = m.scheduled_end ? new Date(m.scheduled_end) : null;
  return {
    action: 'sync',
    item: {
      source_app: REMINDER_SOURCE_APP,
      source_type: REMINDER_SOURCE_TYPE,
      external_id: meetingExternalId(m.id),
      title: (m.title ?? '').trim() || 'Meeting',
      starts_at: start.toISOString(),
      ends_at: end && !Number.isNaN(end.getTime()) && end > start ? end.toISOString() : null,
      // The same deep link the ICS attachment and the MIS Home summary use:
      // the room route accepts the join code as well as the id.
      link: `${cfg.appPublicUrl}/app/meet/${encodeURIComponent(m.join_code)}`,
      location: null,
      critical: false,
      audience_user_ids: audience,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Loading from the database
 * ------------------------------------------------------------------ */

/**
 * Who is reminded, as MIS user ids, per meeting:
 *
 *  - the host;
 *  - everyone invited, except anyone who declined;
 *  - for a meeting started from a conversation (a group or channel call),
 *    every current member of that conversation.
 *
 * Only active accounts. Guests never have a users row, so they are never here.
 */
export async function loadMeetingAudiences(meetingIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!meetingIds.length) return out;
  const { rows } = await getPool().query<{ meeting_id: string; mis_user_id: string }>(
    `SELECT DISTINCT a.meeting_id, u.mis_user_id
       FROM (
         SELECT m.id AS meeting_id, m.host_id AS user_id
           FROM meetings m WHERE m.id = ANY($1::text[])
         UNION
         SELECT i.meeting_id, i.user_id
           FROM meeting_invites i
          WHERE i.meeting_id = ANY($1::text[]) AND i.response <> 'declined'
         UNION
         SELECT m.id, cm.user_id
           FROM meetings m
           JOIN conversations c ON c.id = m.conversation_id AND c.deleted_at IS NULL
           JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.left_at IS NULL
          WHERE m.id = ANY($1::text[])
       ) a
       JOIN users u ON u.id = a.user_id AND u.status = 'active'
      ORDER BY a.meeting_id, u.mis_user_id`,
    [meetingIds],
  );
  for (const r of rows) {
    const list = out.get(r.meeting_id);
    if (list) list.push(r.mis_user_id);
    else out.set(r.meeting_id, [r.mis_user_id]);
  }
  return out;
}

const MEETING_COLUMNS = 'id, title, status, join_code, scheduled_start, scheduled_end';

async function loadMeetings(ids: string[]): Promise<ReminderMeetingRow[]> {
  if (!ids.length) return [];
  const { rows } = await getPool().query<ReminderMeetingRow>(
    `SELECT ${MEETING_COLUMNS} FROM meetings WHERE id = ANY($1::text[])`, [ids]);
  return rows;
}

/* ------------------------------------------------------------------ *
 * Talking to the Hub
 * ------------------------------------------------------------------ */

function authHeaders(cfg: ReminderConfig): Record<string, string> {
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json', Accept: 'application/json' };
}

const messageOf = (body: unknown): string => {
  const msg = (body as { message?: unknown } | null)?.message;
  return typeof msg === 'string' ? msg : '';
};

async function putItems(cfg: ReminderConfig, items: ReminderItem[]): Promise<Map<string, string | null>> {
  const res = await transport({
    method: 'PUT',
    url: `${cfg.misBaseUrl}/reminders/sources/batch`,
    headers: authHeaders(cfg),
    body: { items },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`MIS refused the batch: HTTP ${res.status} ${messageOf(res.body)}`.trim());
  }
  const results = (res.body as { data?: { results?: unknown } } | null)?.data?.results;
  const outcome = new Map<string, string | null>();
  if (Array.isArray(results)) {
    for (const r of results as Array<{ external_id?: unknown; ok?: unknown; error?: unknown }>) {
      if (typeof r?.external_id !== 'string') continue;
      outcome.set(r.external_id, r.ok ? null : (typeof r.error === 'string' ? r.error : 'rejected'));
    }
  }
  return outcome;
}

async function deleteItem(cfg: ReminderConfig, externalId: string): Promise<void> {
  const res = await transport({
    method: 'DELETE',
    url: `${cfg.misBaseUrl}/reminders/sources/${REMINDER_SOURCE_APP}/${REMINDER_SOURCE_TYPE}/${encodeURIComponent(externalId)}`,
    headers: authHeaders(cfg),
  });
  // 404: the Hub never had it, or already withdrew it — the goal is met.
  if (res.status === 404 || (res.status >= 200 && res.status < 300)) return;
  throw new Error(`MIS refused the cancel: HTTP ${res.status} ${messageOf(res.body)}`.trim());
}

/* ------------------------------------------------------------------ *
 * The operations
 * ------------------------------------------------------------------ */

export type SyncOutcome = 'synced' | 'cancelled' | 'skipped' | 'disabled';

/**
 * Bring the Hub's copy of one meeting up to date: send it, withdraw it, or
 * leave it alone. Throws on a transport or MIS failure — callers on a request
 * path use `queueMeetingReminderSync`, which never does.
 */
export async function syncMeeting(meetingId: string): Promise<SyncOutcome> {
  const cfg = reminderConfig();
  if (!cfg.enabled) return 'disabled';

  const [m] = await loadMeetings([meetingId]);
  // Purged: nothing left to describe, so make sure nothing is left to remind.
  if (!m) { await deleteItem(cfg, meetingExternalId(meetingId)); return 'cancelled'; }

  const audience = (await loadMeetingAudiences([m.id])).get(m.id) ?? [];
  const decision = decideMeetingReminder(m, audience, cfg);
  if (decision.action === 'skip') return 'skipped';
  if (decision.action === 'cancel') { await deleteItem(cfg, meetingExternalId(m.id)); return 'cancelled'; }

  const outcome = await putItems(cfg, [decision.item]);
  const error = outcome.get(decision.item.external_id);
  if (error) throw new Error(`MIS rejected ${decision.item.external_id}: ${error}`);
  return 'synced';
}

/** Withdraw one meeting's reminders, whatever state the row is in (or if it is gone). */
export async function cancelMeeting(meetingId: string): Promise<SyncOutcome> {
  const cfg = reminderConfig();
  if (!cfg.enabled) return 'disabled';
  await deleteItem(cfg, meetingExternalId(meetingId));
  return 'cancelled';
}

/* ------------------------------------------------------------------ *
 * Fire-and-forget, for request paths
 * ------------------------------------------------------------------ */

const inFlight = new Set<Promise<unknown>>();

function track(label: string, meetingId: string, work: () => Promise<SyncOutcome>): void {
  const p: Promise<unknown> = work()
    .catch((err) => {
      console.warn(`[reminders] ${label} ${meetingId} failed:`, err instanceof Error ? err.message : err);
    })
    .finally(() => { inFlight.delete(p); });
  inFlight.add(p);
}

/**
 * Schedule a sync and return immediately. A slow or unreachable MIS costs the
 * reminder (the worker's sweep retries within 30 minutes), never the request.
 */
export function queueMeetingReminderSync(meetingId: string): void {
  if (!reminderConfig().enabled) return;
  track('sync', meetingId, () => syncMeeting(meetingId));
}

/** As above, for a cancel or a delete. */
export function queueMeetingReminderCancel(meetingId: string): void {
  if (!reminderConfig().enabled) return;
  track('cancel', meetingId, () => cancelMeeting(meetingId));
}

/** Resolves once every queued sync has settled. For tests and shutdown. */
export async function flushReminderSyncs(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

/* ------------------------------------------------------------------ *
 * The sweep (tupo-worker)
 * ------------------------------------------------------------------ */

export interface SweepResult {
  status: 'ok' | 'disabled';
  reason?: string;
  considered: number;
  synced: number;
  rejected: number;
  cancelled: number;
  batches: number;
  errors: string[];
}

/**
 * Re-send every scheduled meeting starting within the horizon, in batches of
 * 200, and withdraw any meeting cancelled or ended recently whose start is
 * still ahead — which covers a cancel made while the MIS was unreachable, and
 * a meeting the realtime gateway ended without passing through the API.
 *
 * One failed batch does not stop the others; it is reported and retried on
 * the next run.
 */
export async function runReminderSweep(now: Date = new Date()): Promise<SweepResult> {
  const cfg = reminderConfig();
  const result: SweepResult = {
    status: 'ok', considered: 0, synced: 0, rejected: 0, cancelled: 0, batches: 0, errors: [],
  };
  if (!cfg.enabled) return { ...result, status: 'disabled', reason: cfg.disabledReason ?? undefined };

  const pool = getPool();
  const horizon = new Date(now.getTime() + REMINDER_SWEEP_HORIZON_DAYS * 24 * 60 * 60 * 1000);

  const { rows: upcoming } = await pool.query<ReminderMeetingRow>(
    `SELECT ${MEETING_COLUMNS} FROM meetings
      WHERE status = 'scheduled' AND scheduled_start > $1 AND scheduled_start <= $2
      ORDER BY scheduled_start`,
    [now, horizon],
  );
  result.considered = upcoming.length;

  const audiences = await loadMeetingAudiences(upcoming.map((m) => m.id));
  const items: ReminderItem[] = [];
  const toCancel: string[] = [];
  for (const m of upcoming) {
    const d = decideMeetingReminder(m, audiences.get(m.id) ?? [], cfg, now);
    if (d.action === 'sync') items.push(d.item);
    else if (d.action === 'cancel') toCancel.push(m.id);
  }

  for (let i = 0; i < items.length; i += REMINDER_BATCH_LIMIT) {
    const chunk = items.slice(i, i + REMINDER_BATCH_LIMIT);
    result.batches++;
    try {
      const outcome = await putItems(cfg, chunk);
      for (const item of chunk) {
        const error = outcome.get(item.external_id);
        if (error) { result.rejected++; result.errors.push(`${item.external_id}: ${error}`); }
        else result.synced++;
      }
    } catch (err) {
      result.rejected += chunk.length;
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // Recently withdrawn meetings. Bounded to a day, so a cancelled meeting is
  // re-withdrawn for a while (cheap, idempotent) rather than forever.
  const { rows: withdrawn } = await pool.query<{ id: string }>(
    `SELECT id FROM meetings
      WHERE status IN ('cancelled','ended')
        AND scheduled_start > $1 AND scheduled_start <= $2
        AND COALESCE(ended_at, updated_at) > $1::timestamptz - interval '1 day'`,
    [now, horizon],
  );
  for (const id of [...toCancel, ...withdrawn.map((r) => r.id)]) {
    try { await deleteItem(cfg, meetingExternalId(id)); result.cancelled++; }
    catch (err) { result.errors.push(err instanceof Error ? err.message : String(err)); }
  }

  return result;
}
