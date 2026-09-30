import { Router, type Request, type Response } from 'express';
import { getPool, snowflake } from '@tupo/db';
import {
  ok, fail, parseMeetSettings, meetRoleAtLeast, normalizeJoinCode,
  createMeetingSchema, updateMeetingSchema, joinMeetingSchema, askMeetingSchema,
  meetSettingsSchema, MESH_MAX_PARTICIPANTS, MAX_VIDEO_TILES, SIMULCAST_LAYERS,
  AI_SUMMARY_INTERVAL_MS, AI_PARTICIPANT_NAME,
  guestJoinSchema, createNoteSchema, updateNoteSchema, captureNoteSchema,
  MEET_ADMISSION_POLICIES, ADMISSION_POLICY_LABELS, ADMISSION_POLICY_HINTS,
  MEET_CATEGORIES, CATEGORY_META, CATEGORY_TO_POLICY,
  defaultMeetingName, renameMeetingSchema,
  startRecordingSchema, attachRecordingSchema, meetingFolder, MAX_RECORDING_BYTES,
  isSfuTransport, capacityFor, SFU_MAX_TRACKS_PER_CALL, parseSfuTrackName,
} from '@tupo/shared';
import type { MeetJoinTicket, MeetRole, MeetTransport } from '@tupo/shared';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import {
  meetAuth, denyGuests, isGuestRequest, issueGuestToken, newGuestTokenId,
  type MeetRequest,
} from '../middleware/meetAuth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { hasPermission } from '../access/gate.js';
import { getIceServers, isTurnConfigured } from '../services/turnService.js';
import * as sfu from '../services/cloudflareSfuService.js';
import * as meet from '../services/meetService.js';
import * as notifications from '@tupo/notify';
import { reminders } from '@tupo/notify';
import * as ai from '../services/meetAiService.js';
import * as notes from '../services/meetNotesService.js';
import { getProviderStatus, isAnyProviderConfigured } from '../services/aiProviders/index.js';
import { enqueueMeetWrapUp } from '../services/queue.js';
import { audit } from '../services/userService.js';

/**
 * Meet's REST surface (SRS §6.5).
 *
 * The split against tupo-realtime is deliberate: anything durable or
 * authorization-bearing happens here, over HTTP, where it can be audited and
 * rate-limited. Anything ephemeral and fast — roster deltas, hand raises,
 * captions, SDP — happens on the socket. A client that only had this router
 * could still schedule, join, and export a meeting; it just could not be in one.
 */

const router = Router();

/* ================================================================== *
 * Guest join — the ONLY unauthenticated route in Tupo
 * ================================================================== *
 *
 * Mounted above the auth middleware on purpose. It does not create an account
 * and cannot be used to obtain one: it mints a ticket bound to a single
 * participant row in a single public meeting, and that row still has to be
 * admitted from the lobby by a host. See middleware/meetAuth.ts.
 */

/** Per-IP throttle. This route writes rows and is reachable by anyone. */
const guestAttempts = new Map<string, { count: number; resetAt: number }>();
const GUEST_WINDOW_MS = 10 * 60 * 1000;
const GUEST_MAX_PER_WINDOW = 10;

function guestRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = guestAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    guestAttempts.set(ip, { count: 1, resetAt: now + GUEST_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > GUEST_MAX_PER_WINDOW;
}

/** What a guest is told about a meeting *before* they commit to joining it. */
router.get('/:idOrCode/public', async (req: Request, res: Response) => {
  const raw = req.params.idOrCode ?? '';
  const m = await meet.findMeeting(raw.includes('-') ? normalizeJoinCode(raw) : raw);
  // A meeting that is not public is indistinguishable from one that does not
  // exist, so a stranger cannot probe for valid codes.
  if (!m || parseMeetSettings(m.settings).admissionPolicy !== 'public') {
    return res.status(404).json(fail('No public meeting with that code.'));
  }
  if (m.status === 'ended' || m.status === 'cancelled') {
    return res.status(410).json(fail('This meeting has ended.'));
  }

  const { rows } = await getPool().query<{ name: string }>(
    'SELECT name FROM users WHERE id = $1', [m.host_id],
  );
  return res.json(ok({
    meetingId: m.id,
    title: m.title,
    joinCode: m.join_code,
    hostName: rows[0]?.name ?? 'the host',
    status: m.status,
    lobbyEnabled: parseMeetSettings(m.settings).lobbyEnabled,
  }));
});

router.post('/:idOrCode/guest', async (req: Request, res: Response) => {
  if (guestRateLimited(req.ip ?? 'unknown')) {
    return res.status(429).json(fail('Too many attempts. Please wait a few minutes.'));
  }

  const parsed = guestJoinSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(fail(parsed.error.issues[0]?.message ?? 'Please enter your name.'));
  }

  const raw = req.params.idOrCode ?? '';
  const m = await meet.findMeeting(raw.includes('-') ? normalizeJoinCode(raw) : raw);
  if (!m) return res.status(404).json(fail('No meeting with that code.'));
  if (m.status === 'ended' || m.status === 'cancelled') {
    return res.status(410).json(fail('This meeting has ended.'));
  }

  const settings = parseMeetSettings(m.settings);
  if (settings.admissionPolicy !== 'public') {
    return res.status(403).json(fail(
      'This meeting is only open to members of the institution. Please sign in.'));
  }
  if (settings.locked) return res.status(403).json(fail('This meeting is locked.'));

  const currentCount = await meet.activeParticipantCount(m.id);
  try {
    meet.assertCapacity(settings, currentCount);
  } catch (err) {
    return res.status(409).json(fail(err instanceof Error ? err.message : 'Meeting is full.'));
  }

  let transport;
  try {
    transport = meet.decideTransport(m.media_mode, currentCount + 1).transport;
  } catch (err) {
    return res.status(409).json(fail(err instanceof Error ? err.message : 'No usable transport.'));
  }

  // A guest ALWAYS knocks, whatever the lobby setting says. Opening a meeting
  // to the public without seeing who walks in is not a thing a school should
  // be able to do by accident.
  const participant = await meet.upsertParticipant({
    meetingId: m.id,
    userId: null,
    displayName: parsed.data.displayName,
    isGuest: true,
    role: 'attendee',
    state: 'knocking',
    deviceLabel: String(req.body?.deviceLabel ?? '').slice(0, 200) || undefined,
    ipAddress: req.ip,
    settings,
  });

  const tokenId = newGuestTokenId();
  await getPool().query(
    'UPDATE meeting_participants SET guest_token_id = $2 WHERE id = $1',
    [participant.id, tokenId],
  );

  await meet.logMeetEvent(m.id, 'participant.knocked', {
    participantId: participant.id,
    payload: { guest: true, name: parsed.data.displayName },
  });

  const ticket: MeetJoinTicket = {
    meeting: meet.toSummaryPayload(m, transport),
    participantId: participant.id,
    role: 'attendee',
    state: 'knocking',
    transport,
    isGuest: true,
    guestToken: issueGuestToken({
      participantId: participant.id,
      meetingId: m.id,
      name: parsed.data.displayName,
      tokenId,
    }),
    iceServers: await getIceServers(),
  };
  return res.status(201).json(ok(ticket));
});

/* Everything below requires a session or a guest ticket. */
router.use(meetAuth);

const actor = (req: Request) => (req as AuthenticatedRequest).user!;

/** Express types params as possibly-undefined under noUncheckedIndexedAccess.
 *  Every route here declares the param it reads, so '' can never actually
 *  escape — but it keeps the routes free of non-null assertions. */
const param = (req: Request, name: string): string => req.params[name] ?? '';
// Shadow-compared with the v2 snapshot; the v2 set itself in enforce (access/gate.ts).
const can = (req: Request, key: string) => hasPermission(req, key);

/** Whether this user may run *this* meeting, as opposed to meetings in general. */
async function resolveMeetRole(req: Request, m: meet.MeetingRow): Promise<MeetRole> {
  const user = actor(req);
  if (m.host_id === user.id) return 'host';
  const { rows } = await getPool().query<{ role: MeetRole }>(
    `SELECT role FROM meeting_participants
      WHERE meeting_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [m.id, user.id],
  );
  if (rows[0] && meetRoleAtLeast(rows[0].role, 'cohost')) return rows[0].role;
  // A platform administrator can always take over a meeting — someone has to be
  // able to end a room whose host has left the building.
  if (user.permissions.has('MEET_HOST_CONTROLS') && user.roleLevel === 'ADMIN') return 'cohost';
  return rows[0]?.role ?? 'attendee';
}

async function requireHost(req: Request, res: Response, m: meet.MeetingRow): Promise<boolean> {
  const role = await resolveMeetRole(req, m);
  if (!meetRoleAtLeast(role, 'cohost')) {
    res.status(403).json(fail('Only the host or a co-host can do that.'));
    return false;
  }
  return true;
}

/* ================================================================== *
 * Capabilities — what this deployment can actually do
 * ================================================================== */

/**
 * The client asks this before rendering anything, so the UI can be honest about
 * a deployment with no SFU or no AI keys rather than offering a button that
 * fails. Deliberately not permission-gated beyond a valid session: it exposes
 * booleans about the server, never a credential.
 */
/**
 * Live meetings this person may walk into right now.
 *
 * Distinct from `GET /` with `scope=live`, which lists meetings you *own or
 * were invited to*. This answers a different question — "is anything on that I
 * am allowed to join?" — so it includes meetings whose category admits any
 * signed-in user, which no invitation row exists for.
 *
 * Placed above `/:id` deliberately: `live` would otherwise be read as an id.
 */
router.get('/live', async (req: Request, res: Response) => {
  const user = actor(req);

  const { rows } = await getPool().query(
    `SELECT m.id, m.title, m.join_code, m.started_at, m.settings,
            u.name AS host_name, u.avatar_url AS host_avatar,
            (SELECT COUNT(*) FROM meeting_participants p
              WHERE p.meeting_id = m.id AND p.state IN ('active','connecting','reconnecting')
            )::int AS active_count,
            COALESCE((
              SELECT json_agg(x) FROM (
                SELECT p.display_name AS name, pu.avatar_url AS avatar, p.role
                  FROM meeting_participants p
                  LEFT JOIN users pu ON pu.id = p.user_id
                 WHERE p.meeting_id = m.id
                   AND p.state IN ('active','connecting','reconnecting')
                 ORDER BY CASE p.role WHEN 'host' THEN 0 WHEN 'cohost' THEN 1 ELSE 2 END,
                          p.joined_at
                 LIMIT 6
              ) x
            ), '[]'::json) AS present,
            (m.host_id = $1
             OR EXISTS (SELECT 1 FROM meeting_invites i
                         WHERE i.meeting_id = m.id AND i.user_id = $1)) AS is_mine
       FROM meetings m
       JOIN users u ON u.id = m.host_id
      WHERE m.status = 'live'
      ORDER BY m.started_at DESC
      LIMIT 50`,
    [user.id],
  );

  // Admission is decided in one place, so the filter asks it rather than
  // reimplementing the policy in SQL and drifting from it.
  const joinable = rows.filter((r) => {
    const settings = parseMeetSettings(r.settings);
    if (r.is_mine) return true;
    // 'permission' is the default policy and means "anyone who holds
    // MEET_JOIN" — every signed-in user reaching this route already does, so
    // it belongs here alongside the two explicitly open ones. Only 'invited'
    // is exclusive, and that case is covered by is_mine.
    return settings.admissionPolicy === 'permission'
        || settings.admissionPolicy === 'authenticated'
        || settings.admissionPolicy === 'public';
  });

  res.json(ok(joinable.map((r) => ({
    id: r.id,
    title: r.title,
    joinCode: r.join_code,
    startedAt: r.started_at,
    hostName: r.host_name,
    hostAvatar: r.host_avatar,
    activeCount: r.active_count,
    present: r.present,
    isMine: r.is_mine,
  }))));
});

router.get('/capabilities', async (_req: Request, res: Response) => {
  const cloudflare = sfu.isCloudflareSfuConfigured();
  res.json(ok({
    // `sfu` stays a boolean the UI can branch on: is there a media server at
    // all? `mediaServer` says which, because the capacity and the recording
    // story differ between them.
    sfu: cloudflare,
    mediaServer: cloudflare ? 'cloudflare' : null,
    capacity: {
      mesh: capacityFor('mesh', false),
      cloudflare: capacityFor('cloudflare', false),
      cloudflareAudio: capacityFor('cloudflare', true),
    },
    turn: isTurnConfigured(),
    ai: isAnyProviderConfigured(),
    aiProviders: getProviderStatus(),
    meshMaxParticipants: MESH_MAX_PARTICIPANTS,
    maxVideoTiles: MAX_VIDEO_TILES,
    simulcastLayers: SIMULCAST_LAYERS,
    aiSummaryIntervalMs: AI_SUMMARY_INTERVAL_MS,
    aiParticipantName: AI_PARTICIPANT_NAME,
    categories: MEET_CATEGORIES.map((value) => ({
      value, policy: CATEGORY_TO_POLICY[value], ...CATEGORY_META[value],
    })),
    maxRecordingBytes: MAX_RECORDING_BYTES,
    admissionPolicies: MEET_ADMISSION_POLICIES.map((value) => ({
      value,
      label: ADMISSION_POLICY_LABELS[value],
      hint: ADMISSION_POLICY_HINTS[value],
    })),
  }));
});

/**
 * ICE servers. Behind auth on purpose — TURN relay bandwidth is metered, and an
 * open endpoint minting Cloudflare credentials is an open relay.
 */
router.get('/ice', async (_req: Request, res: Response) => {
  res.json(ok({ iceServers: await getIceServers() }));
});

/**
 * People search, for choosing who a private meeting is for.
 *
 * Deliberately not `/api/users`: that is the administrative roster and needs
 * USERS_VIEW, which a teacher scheduling a lesson has no business holding. This
 * returns the minimum needed to pick someone — name, email, avatar — to anyone
 * who may create a meeting in the first place, and refuses to list the whole
 * institution to a bare query.
 */
router.get('/directory', denyGuests,
  authorizePermission('MEET_SCHEDULE', 'MEET_START'), async (req: Request, res: Response) => {
    const search = String(req.query.q ?? '').trim();
    if (search.length < 2) {
      return res.json(ok([], { total: 0 }));
    }
    const { rows } = await getPool().query(
      `SELECT u.id, u.name, u.email, u.avatar_url, r.name AS role_name
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.status = 'active' AND u.id <> $2
          AND (u.name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%')
        ORDER BY u.name
        LIMIT 20`,
      [search, actor(req).id],
    );
    return res.json(ok(rows, { total: rows.length }));
  });

/* ================================================================== *
 * Meetings — CRUD
 * ================================================================== */

/** The meetings list: upcoming, live and recent, scoped to what the user may see. */
router.get('/', denyGuests, async (req: Request, res: Response) => {
  const user = actor(req);
  const scope = String(req.query.scope ?? 'mine');
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);

  /* History needs a window and a search. Both are optional, and both are
   * parsed rather than interpolated — an unparseable date is dropped instead
   * of reaching the query. */
  const parseDay = (v: unknown): Date | null => {
    if (typeof v !== 'string' || !v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const from = parseDay(req.query.from);
  const to = parseDay(req.query.to);
  const search = String(req.query.q ?? '').trim().slice(0, 100);

  // A user sees a meeting when they host it, were invited to it, or attended
  // it. Anything else is somebody else's meeting.
  const visibility = `(
      m.host_id = $1
      OR EXISTS (SELECT 1 FROM meeting_invites i WHERE i.meeting_id = m.id AND i.user_id = $1)
      OR EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id = m.id AND p.user_id = $1)
    )`;

  const scopeClause =
    scope === 'upcoming' ? `AND m.status = 'scheduled'` :
    scope === 'live' ? `AND m.status = 'live'` :
    scope === 'past' ? `AND m.status IN ('ended','cancelled')` : '';

  /* When a meeting *happened* is not one column: a meeting that ran has
   * started_at, one that never did has only its scheduled time. Filtering on
   * either alone silently drops half the history. */
  const params: unknown[] = [user.id, limit, offset];
  const when = `COALESCE(m.started_at, m.scheduled_start, m.created_at)`;
  let windowClause = '';
  if (from) { params.push(from.toISOString()); windowClause += ` AND ${when} >= $${params.length}`; }
  if (to) { params.push(to.toISOString()); windowClause += ` AND ${when} <= $${params.length}`; }
  if (search) {
    params.push(`%${search}%`);
    windowClause += ` AND (m.title ILIKE $${params.length} OR m.join_code ILIKE $${params.length})`;
  }

  const { rows } = await getPool().query(
    `SELECT m.*, u.name AS host_name, u.avatar_url AS host_avatar,
            (SELECT COUNT(*) FROM meeting_participants p
              WHERE p.meeting_id = m.id AND p.state IN ('active','connecting','reconnecting')
            )::int AS active_count,
            -- Who is in there, not just how many. Capped at six: a row of
            -- faces answers "is my class already in?" at a glance, and a
            -- hundred of them answers nothing.
            COALESCE((
              SELECT json_agg(x) FROM (
                SELECT p.display_name AS name, pu.avatar_url AS avatar, p.role
                  FROM meeting_participants p
                  LEFT JOIN users pu ON pu.id = p.user_id
                 WHERE p.meeting_id = m.id
                   AND p.state IN ('active','connecting','reconnecting')
                 ORDER BY CASE p.role WHEN 'host' THEN 0 WHEN 'cohost' THEN 1 ELSE 2 END,
                          p.joined_at
                 LIMIT 6
              ) x
            ), '[]'::json) AS present,
            EXISTS (SELECT 1 FROM meeting_ai_artifacts a
                     WHERE a.meeting_id = m.id AND a.kind = 'minutes') AS has_minutes
       FROM meetings m
       JOIN users u ON u.id = m.host_id
      WHERE ${visibility} ${scopeClause} ${windowClause}
      ORDER BY
        CASE m.status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
        ${when} DESC
      LIMIT $2 OFFSET $3`,
    params,
  );

  res.json(ok(rows.map((r) => ({ ...r, settings: parseMeetSettings(r.settings) })), { total: rows.length }));
});

/** Schedule a meeting. */
router.post('/', denyGuests, authorizePermission('MEET_SCHEDULE', 'MEET_START'), async (req: Request, res: Response) => {
  const parsed = createMeetingSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(fail(parsed.error.issues[0]?.message ?? 'Invalid meeting.'));
  }
  const input = parsed.data;

  // Scheduling for later needs MEET_SCHEDULE specifically; MEET_START only
  // covers starting one now.
  if (input.scheduledStart && !can(req, 'MEET_SCHEDULE')) {
    return res.status(403).json(fail('You do not have permission to schedule meetings.'));
  }
  if (input.settings?.recordingEnabled && !can(req, 'MEET_RECORD')) {
    return res.status(403).json(fail('You do not have permission to record meetings.'));
  }
  if (input.settings?.aiAssistantEnabled && !can(req, 'MEET_AI_USE')) {
    return res.status(403).json(fail('You do not have permission to use the AI notetaker.'));
  }
  if (input.settings?.transcriptionEnabled && !can(req, 'MEET_TRANSCRIBE')) {
    return res.status(403).json(fail('You do not have permission to enable transcription.'));
  }

  try {
    const meeting = await meet.createMeeting({
      hostId: actor(req).id,
      ...input,
      // Every meeting gets a name. A list of eleven rows all called "Meeting"
      // is unusable, and the timestamp is the one thing always true and always
      // distinguishing. It is a proposal — the field is editable everywhere.
      title: input.title?.trim() ||
        defaultMeetingName(
          input.scheduledStart ? new Date(input.scheduledStart) : new Date(),
          input.scheduledStart ? 'scheduled' : 'instant',
        ),
      startNow: !input.scheduledStart,
    });
    // Scheduled for later: hand it to the MIS Reminder Hub. Fire-and-forget —
    // an unreachable MIS costs the reminder (the worker sweep retries), never
    // the meeting. An instant meeting has already started; nothing to remind.
    if (input.scheduledStart) reminders.queueMeetingReminderSync(meeting.id);
    res.status(201).json(ok({ ...meeting, settings: parseMeetSettings(meeting.settings) }));
  } catch (err) {
    res.status(400).json(fail(err instanceof Error ? err.message : 'Could not create the meeting.'));
  }
});

/** Instant meeting — the "Start a call" button. */
router.post('/instant', denyGuests, authorizePermission('MEET_START'), async (req: Request, res: Response) => {
  const { title, conversationId, settings } = req.body ?? {};
  const meeting = await meet.createMeeting({
    hostId: actor(req).id,
    title: String(title ?? '').trim() || defaultMeetingName(new Date(), 'instant'),
    conversationId,
    settings: {
      // An instant call has no lobby *by default* — whoever you just called is
      // already someone you are talking to. These are defaults, so they go
      // first: an explicit `lobbyEnabled: true` from the caller must win.
      lobbyEnabled: false,
      waitForHost: false,
      ...(settings ?? {}),
    },
    startNow: true,
  });
  // Born live, so it never crosses scheduled -> live and the join-path
  // announcement never fires for it. Announced here instead.
  void announceLive(meeting.id).catch(() => {});
  res.status(201).json(ok({ ...meeting, settings: parseMeetSettings(meeting.settings) }));
});

/** Look up by id or by the shareable `abc-defg-hij` code. */
router.get('/:idOrCode', async (req: Request, res: Response) => {
  const key = param(req, 'idOrCode').includes('-')
    ? normalizeJoinCode(param(req, 'idOrCode'))
    : param(req, 'idOrCode');

  const m = await meet.findMeeting(key);
  if (!m) return res.status(404).json(fail('Meeting not found.'));

  const { rows: participants } = await getPool().query(
    `SELECT p.id, p.display_name, p.role, p.state, p.joined_at, p.left_at,
            p.duration_seconds, u.avatar_url
       FROM meeting_participants p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.meeting_id = $1 ORDER BY p.created_at`,
    [m.id],
  );

  res.json(ok({
    ...m,
    settings: parseMeetSettings(m.settings),
    participants,
    yourRole: await resolveMeetRole(req, m),
  }));
});

router.patch('/:id', denyGuests, async (req: Request, res: Response) => {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) return res.status(404).json(fail('Meeting not found.'));
  if (!(await requireHost(req, res, m))) return;

  const parsed = updateMeetingSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(fail('Invalid update.'));
  const p = parsed.data;

  const { rows } = await getPool().query<meet.MeetingRow>(
    `UPDATE meetings SET
       title = COALESCE($2, title),
       description = COALESCE($3, description),
       scheduled_start = COALESCE($4, scheduled_start),
       scheduled_end = COALESCE($5, scheduled_end),
       recurrence_rule = COALESCE($6, recurrence_rule),
       status = COALESCE($7, status),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [m.id, p.title ?? null, p.description ?? null, p.scheduledStart ?? null,
      p.scheduledEnd ?? null, p.recurrenceRule ?? null, p.status ?? null],
  );

  if (p.settings) await meet.updateSettings(m.id, meetSettingsSchema.partial().parse(p.settings));
  // Rescheduled, renamed or cancelled via status: the sync works out which.
  reminders.queueMeetingReminderSync(m.id);
  const fresh = await meet.findMeeting(m.id);
  res.json(ok({ ...rows[0], settings: parseMeetSettings(fresh?.settings) }));
});

/**
 * Rename. Separate from the general PATCH so it can be reached from inside the
 * room by a co-host without handing them the whole settings surface.
 */
router.put('/:id/name', denyGuests, async (req: Request, res: Response) => {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) return res.status(404).json(fail('Meeting not found.'));
  if (!(await requireHost(req, res, m))) return;

  const parsed = renameMeetingSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(fail(parsed.error.issues[0]?.message ?? 'A meeting needs a name.'));
  }

  const { rows } = await getPool().query<{ title: string }>(
    'UPDATE meetings SET title = $2, updated_at = now() WHERE id = $1 RETURNING title',
    [m.id, parsed.data.title],
  );
  await meet.logMeetEvent(m.id, 'meeting.renamed', {
    actorId: actor(req).id, payload: { from: m.title, to: parsed.data.title },
  });
  reminders.queueMeetingReminderSync(m.id);
  res.json(ok({ title: rows[0]!.title }));
});

router.delete('/:id', denyGuests, async (req: Request, res: Response) => {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) return res.status(404).json(fail('Meeting not found.'));

  // Only the person who created it. Not a co-host, not an administrator —
  // deleting a meeting destroys its attendance record and its transcript, and
  // that is not a decision to hand to everyone who can run the session.
  // Ending or cancelling a meeting is what those roles have.
  if (m.host_id !== actor(req).id) {
    return res.status(403).json(fail(
      'Only the person who created this meeting can delete it.'));
  }

  const purge = String(req.query.purge ?? '') === 'true';

  if (!purge) {
    // The default is to cancel: the attendance record and the event stream are
    // evidence of what happened and outlive the meeting itself.
    await getPool().query(
      `UPDATE meetings SET status = 'cancelled', updated_at = now() WHERE id = $1`, [m.id]);
    await meet.logMeetEvent(m.id, 'meeting.ended',
      { actorId: actor(req).id, payload: { cancelled: true } });
    reminders.queueMeetingReminderCancel(m.id);
    return res.json(ok({ cancelled: true, deleted: false }));
  }

  // A real delete. Everything cascades from `meetings` — participants, events,
  // chat, transcript, notes, polls, recordings — so this is irreversible, and
  // it is audit-logged before the rows it describes disappear.
  await audit({
    actorId: actor(req).id,
    action: 'meet.deleted',
    targetType: 'meeting',
    targetId: m.id,
    metadata: { title: m.title, joinCode: m.join_code, startedAt: m.started_at },
    ipAddress: req.ip,
  });
  // `meeting_events` is range-partitioned, which means it carries no foreign
  // key back to `meetings` — so it does not cascade and has to go explicitly.
  // Everything else does cascade from the meetings row.
  await getPool().query('DELETE FROM meeting_events WHERE meeting_id = $1', [m.id]);
  await getPool().query('DELETE FROM meetings WHERE id = $1', [m.id]);
  reminders.queueMeetingReminderCancel(m.id);
  res.json(ok({ cancelled: false, deleted: true }));
});

/* ================================================================== *
 * Joining
 * ================================================================== */

/**
 * The join ticket: admission decision, transport choice, and the credentials
 * needed to open media. This is the one endpoint that must get authorization
 * exactly right, because everything after it is inside the room.
 */
// Deliberately NOT behind authorizePermission('MEET_JOIN'): the admission
// policy decides, and two of its four levels exist precisely to admit people
// whose role does not carry that permission. decideAdmission enforces it for
// the 'permission' policy.
router.post('/:idOrCode/join', async (req: Request, res: Response) => {
  const user = actor(req);
  const key = param(req, 'idOrCode').includes('-')
    ? normalizeJoinCode(param(req, 'idOrCode'))
    : param(req, 'idOrCode');

  const m = await meet.findMeeting(key);
  if (!m) return res.status(404).json(fail('Meeting not found. Check the code and try again.'));
  if (m.status === 'ended') return res.status(410).json(fail('This meeting has ended.'));
  if (m.status === 'cancelled') return res.status(410).json(fail('This meeting was cancelled.'));

  const parsed = joinMeetingSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(fail('Invalid join request.'));

  const settings = parseMeetSettings(m.settings);
  const pool = getPool();

  const [{ rows: invited }, { rows: convMember }] = await Promise.all([
    pool.query('SELECT 1 FROM meeting_invites WHERE meeting_id = $1 AND user_id = $2', [m.id, user.id]),
    m.conversation_id
      ? pool.query('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
          [m.conversation_id, user.id])
      : Promise.resolve({ rows: [] as unknown[] }),
  ]);

  const admission = meet.decideAdmission({
    meeting: m,
    settings,
    userId: user.id,
    isInvited: invited.length > 0,
    isConversationMember: convMember.length > 0,
    hasHostControls: can(req, 'MEET_HOST_CONTROLS'),
    hasJoinPermission: can(req, 'MEET_JOIN'),
  });

  if (admission.state === 'denied') return res.status(403).json(fail(admission.reason));

  const currentCount = await meet.activeParticipantCount(m.id);

  // Transport first, because capacity depends on it: peer-to-peer is bounded by
  // everyone's uplink, an SFU by each subscriber's downlink, and those are
  // wildly different numbers. Decided against the count *after* this join, so
  // the last person who would break a mesh call is refused rather than admitted
  // into one that then falls apart.
  let transport: MeetTransport;
  try {
    // Already pinned? Use it. Everyone in one meeting must be on the same
    // transport, so the first joiner's decision is the meeting's decision.
    transport = m.transport ?? meet.decideTransport(m.media_mode, currentCount + 1).transport;
  } catch (err) {
    return res.status(409).json(fail(err instanceof Error ? err.message : 'No usable transport.'));
  }

  try {
    meet.assertCapacity(settings, currentCount, transport);
  } catch (err) {
    return res.status(409).json(fail(err instanceof Error ? err.message : 'Meeting is full.'));
  }

  const participant = await meet.upsertParticipant({
    meetingId: m.id,
    userId: user.id,
    displayName: user.name,
    isGuest: false,
    role: admission.role,
    state: admission.state,
    deviceLabel: parsed.data.deviceLabel,
    ipAddress: req.ip,
    settings,
  });

  // The transport is pinned on first join. Everyone in one meeting must be on
  // the same one — a room half on mesh and half on the SFU is not a room.
  if (!m.transport) {
    await pool.query('UPDATE meetings SET transport = $2 WHERE id = $1', [m.id, transport]);
  }

  if (admission.role === 'host' && m.status === 'scheduled') {
    await meet.startMeeting(m.id, user.id);
    // Tell the people who may join that it is happening — now, rather than the
    // next time they happen to open Meet. Off the request path: a slow or
    // absent Redis must not make starting a meeting slow.
    void announceLive(m.id).catch(() => {});
  }
  await meet.recordPeak(m.id, currentCount + 1);
  await meet.logMeetEvent(m.id, admission.state === 'active' ? 'participant.joined' : 'participant.knocked', {
    participantId: participant.id,
    actorId: user.id,
    payload: { role: admission.role, reason: admission.reason, transport },
  });

  const fresh = (await meet.findMeeting(m.id))!;
  const ticket: MeetJoinTicket = {
    meeting: meet.toSummaryPayload(fresh, transport),
    participantId: participant.id,
    role: participant.role,
    state: participant.state,
    transport,
    iceServers: await getIceServers(),
    // The media token is issued only once the participant is actually admitted.
    // Handing it to someone still knocking would let them open media into a
    // room the host has not let them into.
    ...(transport === 'cloudflare' && participant.state === 'active'
      ? { sfuEndpoint: `/api/meet/${fresh.id}/sfu` }
      : {}),
  };

  res.json(ok(ticket));
});

/**
 * Exchange an admission for a media token.
 *
 * Separate from `/join` because admission is asynchronous: someone in the lobby
 * holds a participant row and a socket, and calls this the moment the host lets
 * them in, without re-running the whole admission decision.
 */
router.post('/:id/token', authorizePermission('MEET_JOIN'), async (req: Request, res: Response) => {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) return res.status(404).json(fail('Meeting not found.'));

  // A guest's row has `user_id IS NULL` — they are identified by the
  // participant id inside their ticket, the same way the SFU routes do it
  // (see sfuParticipant below). Matching them on user_id found nothing and
  // returned "You are not in this meeting" to somebody the host had just
  // admitted, so every public-link guest reached a working roster with no
  // audio or video at all.
  const guest = (req as MeetRequest).guest;
  const { rows } = guest
    ? await getPool().query<meet.ParticipantRow>(
        `SELECT * FROM meeting_participants WHERE id = $1 AND meeting_id = $2 LIMIT 1`,
        [guest.participantId, m.id])
    : await getPool().query<meet.ParticipantRow>(
        `SELECT * FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2
          ORDER BY created_at DESC LIMIT 1`,
        [m.id, actor(req).id]);
  const participant = rows[0];
  if (!participant) return res.status(404).json(fail('You are not in this meeting.'));
  if (participant.state !== 'active') {
    return res.status(409).json(fail('You have not been admitted yet.'));
  }

  const transport = (m.transport ?? 'mesh') as MeetTransport;
  res.json(ok({
    transport,
    iceServers: await getIceServers(),
    ...(transport === 'cloudflare' ? { sfuEndpoint: `/api/meet/${m.id}/sfu` } : {}),
  }));
});

router.post('/:id/leave', async (req: Request, res: Response) => {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) return res.status(404).json(fail('Meeting not found.'));

  // Guests match on their participant id, not user_id — see /token above.
  // Without this a guest was never marked as having left, so they kept
  // counting against the meeting's capacity and stayed in the attendance
  // export as present.
  const leavingGuest = (req as MeetRequest).guest;
  const { rows } = leavingGuest
    ? await getPool().query<{ id: string }>(
        `SELECT id FROM meeting_participants
          WHERE id = $1 AND meeting_id = $2 AND left_at IS NULL LIMIT 1`,
        [leavingGuest.participantId, m.id])
    : await getPool().query<{ id: string }>(
        `SELECT id FROM meeting_participants
          WHERE meeting_id = $1 AND user_id = $2 AND left_at IS NULL LIMIT 1`,
        [m.id, actor(req).id]);
  if (rows[0]) {
    await meet.markParticipantLeft(rows[0].id);
    await meet.logMeetEvent(m.id, 'participant.left', {
      participantId: rows[0].id, actorId: actor(req).id,
    });
  }
  res.json(ok({ left: true }));
});

router.post('/:id/end', authorizePermission('MEET_HOST_CONTROLS'), async (req: Request, res: Response) => {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) return res.status(404).json(fail('Meeting not found.'));
  if (!(await requireHost(req, res, m))) return;

  await meet.endMeeting(m.id, actor(req).id);
  // A meeting that has ended must stop inviting people into it.
  void notifications.revokeSubject('meeting', m.id).catch(() => {});
  // Ended before its scheduled start (the host ran it early): withdraw the
  // reminders that would otherwise still fire.
  reminders.queueMeetingReminderCancel(m.id);

  // Minutes, chapters and action items are generated off the request, so
  // ending a meeting stays instant and a Redis outage costs the minutes rather
  // than the ability to end the call.
  // Only the session claims travel to the worker — not the resolved RBAC
  // fields the middleware attached, which the worker re-resolves anyway.
  const { id, misUserId, name, email, role, avatarUrl } = actor(req);
  const queued = await enqueueMeetWrapUp(m.id, { id, misUserId, name, email, role, avatarUrl });
  res.json(ok({ ended: true, wrapUpQueued: queued }));
});

router.put('/:id/settings', authorizePermission('MEET_HOST_CONTROLS'), async (req: Request, res: Response) => {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) return res.status(404).json(fail('Meeting not found.'));
  if (!(await requireHost(req, res, m))) return;

  const parsed = meetSettingsSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(fail('Invalid settings.'));

  // Settings are the back door into the permission-gated features, so each one
  // re-checks the permission its REST equivalent would have required.
  if (parsed.data.recordingEnabled && !can(req, 'MEET_RECORD')) {
    return res.status(403).json(fail('You do not have permission to record meetings.'));
  }
  if (parsed.data.aiAssistantEnabled && !can(req, 'MEET_AI_USE')) {
    return res.status(403).json(fail('You do not have permission to use the AI notetaker.'));
  }
  if (parsed.data.transcriptionEnabled && !can(req, 'MEET_TRANSCRIBE')) {
    return res.status(403).json(fail('You do not have permission to enable transcription.'));
  }

  res.json(ok(await meet.updateSettings(m.id, parsed.data)));
});

/* ================================================================== *
 * Cloudflare Realtime SFU — proxied, never reached directly
 * ================================================================== *
 *
 * The app secret stays on the server. Every call the browser needs goes through
 * here, and every one of them is authorised against the meeting first: a client
 * holding that secret could create sessions on the account's bill and subscribe
 * to any track in any meeting on it.
 */

/** The caller's own participant row, which is what these routes act as. */
async function sfuParticipant(req: Request, meetingId: string): Promise<{
  id: string; sfu_session_id: string | null;
} | null> {
  const request = req as MeetRequest;
  const { rows } = request.guest
    ? await getPool().query<{ id: string; sfu_session_id: string | null }>(
        `SELECT id, sfu_session_id FROM meeting_participants
          WHERE id = $1 AND meeting_id = $2 AND state = 'active'`,
        [request.guest.participantId, meetingId])
    : await getPool().query<{ id: string; sfu_session_id: string | null }>(
        `SELECT id, sfu_session_id FROM meeting_participants
          WHERE meeting_id = $1 AND user_id = $2 AND state = 'active'
          ORDER BY created_at DESC LIMIT 1`,
        [meetingId, actor(req).id]);
  return rows[0] ?? null;
}

async function sfuPreflight(req: Request, res: Response): Promise<
  { meeting: meet.MeetingRow; me: { id: string; sfu_session_id: string | null } } | null
> {
  if (!sfu.isCloudflareSfuConfigured()) {
    res.status(503).json(fail('The Cloudflare media server is not configured.'));
    return null;
  }
  const meeting = await meet.findMeeting(param(req, 'id'));
  if (!meeting) { res.status(404).json(fail('Meeting not found.')); return null; }
  if (meeting.transport !== 'cloudflare') {
    res.status(409).json(fail('This meeting is not on the Cloudflare transport.'));
    return null;
  }
  // Active only. Someone still in the lobby has a participant row and a socket,
  // and must not be able to open media into the room.
  const me = await sfuParticipant(req, meeting.id);
  if (!me) { res.status(403).json(fail('You are not in this meeting.')); return null; }
  return { meeting, me };
}

const sfuError = (res: Response, err: unknown) => {
  if (err instanceof sfu.CloudflareSfuError) {
    return res.status(err.status).json(fail(err.message));
  }
  return res.status(502).json(fail('The media server could not be reached.'));
};

/** One PeerConnection's worth of session, bound to this participant. */
router.post('/:id/sfu/session', async (req: Request, res: Response) => {
  const pre = await sfuPreflight(req, res);
  if (!pre) return;
  try {
    // The correlation id makes a Cloudflare-side session traceable back to a
    // participant when reading their dashboard, which is the difference between
    // a diagnosable bill and an opaque one.
    const session = await sfu.createSession(`${pre.meeting.join_code}:${pre.me.id}`);
    await getPool().query(
      'UPDATE meeting_participants SET sfu_session_id = $2 WHERE id = $1',
      [pre.me.id, session.sessionId]);
    res.json(ok({ sessionId: session.sessionId, participantId: pre.me.id }));
  } catch (err) {
    sfuError(res, err);
  }
});

/**
 * Publish or subscribe — the same Cloudflare endpoint either way.
 *
 * The authorisation that matters is on *remote* tracks: a subscriber may only
 * pull tracks belonging to participants who are actually in this meeting, and
 * only under the names this application generates. Without that check, a valid
 * session token for one meeting would be a licence to listen to any other.
 */
router.post('/:id/sfu/tracks', async (req: Request, res: Response) => {
  const pre = await sfuPreflight(req, res);
  if (!pre) return;

  const { sessionDescription, tracks, autoDiscover } = req.body ?? {};
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return res.status(400).json(fail('No tracks given.'));
  }
  if (tracks.length > SFU_MAX_TRACKS_PER_CALL) {
    return res.status(400).json(fail(
      `At most ${SFU_MAX_TRACKS_PER_CALL} tracks can be added in one call.`));
  }
  if (!pre.me.sfu_session_id) {
    return res.status(409).json(fail('Open a media session first.'));
  }

  const remote = (tracks as sfu.TrackObject[]).filter((t) => t.location === 'remote');
  if (remote.length) {
    // Everyone whose tracks may be pulled: active in *this* meeting, publishing.
    const { rows: allowed } = await getPool().query<{ id: string; sfu_session_id: string }>(
      `SELECT id, sfu_session_id FROM meeting_participants
        WHERE meeting_id = $1 AND state = 'active' AND sfu_session_id IS NOT NULL`,
      [pre.meeting.id]);
    const sessions = new Map(allowed.map((r) => [r.sfu_session_id, r.id]));

    for (const track of remote) {
      const ownerId = track.sessionId ? sessions.get(track.sessionId) : undefined;
      if (!ownerId) {
        return res.status(403).json(fail('That track is not in this meeting.'));
      }
      // The name must be one this application generates, and must belong to the
      // session claimed — otherwise a caller could pull an arbitrary track from
      // a session that happens to be in the room.
      const parsed = track.trackName ? parseSfuTrackName(track.trackName) : null;
      if (!parsed || parsed.participantId !== ownerId) {
        return res.status(403).json(fail('That track name does not belong to that participant.'));
      }
    }
  }

  try {
    const result = await sfu.addTracks(pre.me.sfu_session_id, {
      sessionDescription, tracks, autoDiscover,
    });
    res.json(ok(result));
  } catch (err) {
    sfuError(res, err);
  }
});

router.put('/:id/sfu/renegotiate', async (req: Request, res: Response) => {
  const pre = await sfuPreflight(req, res);
  if (!pre) return;
  if (!pre.me.sfu_session_id) return res.status(409).json(fail('Open a media session first.'));

  const { sessionDescription } = req.body ?? {};
  if (!sessionDescription?.sdp || !sessionDescription?.type) {
    return res.status(400).json(fail('A session description is required.'));
  }
  try {
    res.json(ok(await sfu.renegotiate(pre.me.sfu_session_id, sessionDescription)));
  } catch (err) {
    sfuError(res, err);
  }
});

router.put('/:id/sfu/close', async (req: Request, res: Response) => {
  const pre = await sfuPreflight(req, res);
  if (!pre) return;
  if (!pre.me.sfu_session_id) return res.json(ok({ closed: true }));

  const { tracks, sessionDescription, force } = req.body ?? {};
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return res.status(400).json(fail('No tracks given.'));
  }
  try {
    res.json(ok(await sfu.closeTracks(pre.me.sfu_session_id, {
      tracks, sessionDescription, force,
    })));
  } catch (err) {
    sfuError(res, err);
  }
});

/**
 * Read the session back — and, incidentally, keep it alive.
 *
 * Cloudflare garbage-collects a session after 30 seconds without media, so a
 * participant sitting muted with their camera off would be dropped by the SFU
 * while still very much in the meeting.
 */
router.get('/:id/sfu/session', async (req: Request, res: Response) => {
  const pre = await sfuPreflight(req, res);
  if (!pre) return;
  if (!pre.me.sfu_session_id) return res.status(404).json(fail('No media session.'));
  try {
    res.json(ok(await sfu.getSession(pre.me.sfu_session_id)));
  } catch (err) {
    sfuError(res, err);
  }
});

/* ================================================================== *
 * Attendance & events
 * ================================================================== */

/** FR-MEET-15 — the lesson-delivery evidence. */
router.get('/:id/attendance', authorizePermission('MEET_ATTENDANCE_VIEW'), async (req: Request, res: Response) => {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) return res.status(404).json(fail('Meeting not found.'));

  const { rows } = await getPool().query(
    `SELECT p.id, p.display_name, p.is_guest, p.role, p.state,
            p.joined_at, p.left_at, p.duration_seconds, p.speaking_seconds,
            p.device_label, u.email, u.mis_user_id
       FROM meeting_participants p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.meeting_id = $1 ORDER BY p.joined_at NULLS LAST, p.created_at`,
    [m.id],
  );

  if (String(req.query.format) === 'csv') {
    const header = 'Name,Email,MIS ID,Role,Joined,Left,Duration (min),Speaking (min),Guest,Device';
    const csv = [header, ...rows.map((r) => [
      r.display_name, r.email ?? '', r.mis_user_id ?? '', r.role,
      r.joined_at ? new Date(r.joined_at).toISOString() : '',
      r.left_at ? new Date(r.left_at).toISOString() : '',
      (r.duration_seconds / 60).toFixed(1), (r.speaking_seconds / 60).toFixed(1),
      r.is_guest ? 'yes' : 'no', r.device_label ?? '',
    ].map(csvCell).join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="attendance-${m.join_code}.csv"`);
    return res.send(csv);
  }

  res.json(ok({
    meeting: {
      id: m.id, title: m.title, startedAt: m.started_at, endedAt: m.ended_at,
      peakParticipants: m.peak_participants,
    },
    participants: rows,
  }, { total: rows.length }));
});

/**
 * A cell that starts with =, +, - or @ is executed as a formula by Excel and
 * Sheets. Prefixing with an apostrophe is the standard defence.
 */
function csvCell(value: unknown): string {
  const s = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** The host console's feed — the proctoring dashboard's event stream. */
router.get('/:id/events', async (req: Request, res: Response) => {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) return res.status(404).json(fail('Meeting not found.'));
  if (!(await requireHost(req, res, m))) return;

  const severity = String(req.query.severity ?? '');
  const { rows } = await getPool().query(
    `SELECT e.id, e.type, e.severity, e.payload, e.created_at,
            e.participant_id, p.display_name
       FROM meeting_events e
       LEFT JOIN meeting_participants p ON p.id = e.participant_id
      WHERE e.meeting_id = $1 AND ($2 = '' OR e.severity = $2)
      ORDER BY e.created_at DESC LIMIT $3`,
    [m.id, severity, Math.min(Number(req.query.limit ?? 200), 1000)],
  );
  res.json(ok(rows, { total: rows.length }));
});

/* ================================================================== *
 * Transcript
 * ================================================================== */

router.get('/:id/transcript', async (req: Request, res: Response) => {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) return res.status(404).json(fail('Meeting not found.'));

  // Anyone who was in the meeting may read its transcript; nobody else may.
  const { rows: seen } = await getPool().query(
    'SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
    [m.id, actor(req).id],
  );
  if (!seen.length && m.host_id !== actor(req).id && !can(req, 'COMPLIANCE_EXPORT')) {
    return res.status(403).json(fail('You were not in this meeting.'));
  }

  const lines = await ai.loadTranscript(m.id);

  if (String(req.query.format) === 'txt') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transcript-${m.join_code}.txt"`);
    return res.send(`${m.title}\n${'='.repeat(m.title.length)}\n\n${ai.renderTranscript(lines, 10_000_000)}`);
  }

  res.json(ok(lines, { total: lines.length }));
});

/* ================================================================== *
 * AI
 * ================================================================== */

/** Meeting context every generator needs: title, description, who was there. */
async function contextFor(m: meet.MeetingRow): Promise<ai.MeetingContext> {
  const { rows } = await getPool().query<{ display_name: string }>(
    `SELECT DISTINCT display_name FROM meeting_participants WHERE meeting_id = $1`, [m.id],
  );
  return {
    title: m.title,
    description: m.description,
    participants: rows.map((r) => r.display_name),
    startedAt: m.started_at,
  };
}

/**
 * Guard shared by every generative endpoint: the permission, the meeting's own
 * AI setting, and enough transcript to say anything true.
 */
async function aiPreflight(req: Request, res: Response): Promise<
  { m: meet.MeetingRow; ctx: ai.MeetingContext; lines: ai.TranscriptLine[] } | null
> {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) { res.status(404).json(fail('Meeting not found.')); return null; }

  // Order matters. A meeting that never switched AI on, or that has no
  // transcript, is something the caller can fix — say so. "AI is not
  // configured on this server" is only the right answer once those are ruled
  // out, and it is nobody in the meeting's problem to solve.
  const settings = parseMeetSettings(m.settings);
  if (!settings.aiAssistantEnabled) {
    res.status(409).json(fail('The AI notetaker is not enabled for this meeting.'));
    return null;
  }

  const lines = await ai.loadTranscript(m.id);
  if (lines.length < 2) {
    res.status(409).json(fail(
      'There is not enough transcript yet. Turn on captions and let the conversation run.'));
    return null;
  }

  if (!isAnyProviderConfigured()) {
    res.status(503).json(fail('AI is not configured on this server.'));
    return null;
  }
  return { m, ctx: await contextFor(m), lines };
}

const AI_PERM = 'MEET_AI_USE';

router.get('/:id/ai', async (req: Request, res: Response) => {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) return res.status(404).json(fail('Meeting not found.'));
  res.json(ok(await ai.listArtifacts(m.id)));
});

router.post('/:id/ai/summary', authorizePermission(AI_PERM), async (req: Request, res: Response) => {
  const pre = await aiPreflight(req, res);
  if (!pre) return;
  try {
    const { data, providerUsed } = await ai.generateSummary(ai.renderTranscript(pre.lines), pre.ctx);
    const saved = await ai.saveArtifact(pre.m.id, 'summary', data, {
      providerUsed, segmentCount: pre.lines.length, requestedBy: actor(req).id,
    });
    await meet.logMeetEvent(pre.m.id, 'ai.artifact_generated', {
      actorId: actor(req).id, payload: { kind: 'summary', providerUsed },
    });
    res.json(ok({ ...saved, kind: 'summary', content: data, providerUsed }));
  } catch (err) {
    res.status(502).json(fail(err instanceof Error ? err.message : 'AI generation failed.'));
  }
});

router.post('/:id/ai/action-items', authorizePermission(AI_PERM), async (req: Request, res: Response) => {
  const pre = await aiPreflight(req, res);
  if (!pre) return;
  try {
    const { data, providerUsed } = await ai.generateActionItems(ai.renderTranscript(pre.lines), pre.ctx);
    const saved = await ai.saveArtifact(pre.m.id, 'action_items', data, {
      providerUsed, segmentCount: pre.lines.length, requestedBy: actor(req).id,
    });
    res.json(ok({ ...saved, kind: 'action_items', content: data, providerUsed }));
  } catch (err) {
    res.status(502).json(fail(err instanceof Error ? err.message : 'AI generation failed.'));
  }
});

router.post('/:id/ai/decisions', authorizePermission(AI_PERM), async (req: Request, res: Response) => {
  const pre = await aiPreflight(req, res);
  if (!pre) return;
  try {
    const { data, providerUsed } = await ai.generateDecisions(ai.renderTranscript(pre.lines), pre.ctx);
    const saved = await ai.saveArtifact(pre.m.id, 'decisions', data, {
      providerUsed, segmentCount: pre.lines.length, requestedBy: actor(req).id,
    });
    res.json(ok({ ...saved, kind: 'decisions', content: data, providerUsed }));
  } catch (err) {
    res.status(502).json(fail(err instanceof Error ? err.message : 'AI generation failed.'));
  }
});

router.post('/:id/ai/minutes', authorizePermission(AI_PERM), async (req: Request, res: Response) => {
  const pre = await aiPreflight(req, res);
  if (!pre) return;
  try {
    // Private in-meeting DMs are excluded — the minutes are a shared record.
    const { rows: chat } = await getPool().query<{ sender_name: string; body: string }>(
      `SELECT sender_name, body FROM meeting_chat_messages
        WHERE meeting_id = $1 AND to_participant_id IS NULL ORDER BY created_at LIMIT 500`,
      [pre.m.id],
    );
    const chatLog = chat.map((c) => `${c.sender_name}: ${c.body}`).join('\n');

    const { data, providerUsed } = await ai.generateMinutes(
      ai.renderTranscript(pre.lines), pre.ctx, chatLog || undefined);
    const saved = await ai.saveArtifact(pre.m.id, 'minutes', data, {
      providerUsed, segmentCount: pre.lines.length, requestedBy: actor(req).id,
    });
    res.json(ok({ ...saved, kind: 'minutes', content: data, providerUsed }));
  } catch (err) {
    res.status(502).json(fail(err instanceof Error ? err.message : 'AI generation failed.'));
  }
});

router.post('/:id/ai/chapters', authorizePermission(AI_PERM), async (req: Request, res: Response) => {
  const pre = await aiPreflight(req, res);
  if (!pre) return;
  try {
    const { data, providerUsed } = await ai.generateChapters(ai.renderTranscript(pre.lines), pre.ctx);
    const saved = await ai.saveArtifact(pre.m.id, 'chapters', data, {
      providerUsed, segmentCount: pre.lines.length, requestedBy: actor(req).id,
    });
    res.json(ok({ ...saved, kind: 'chapters', content: data, providerUsed }));
  } catch (err) {
    res.status(502).json(fail(err instanceof Error ? err.message : 'AI generation failed.'));
  }
});

/** "Ask the meeting" and "catch me up" — the same endpoint. */
router.post('/:id/ai/ask', authorizePermission(AI_PERM), async (req: Request, res: Response) => {
  const parsed = askMeetingSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(fail('Ask a question.'));

  const pre = await aiPreflight(req, res);
  if (!pre) return;
  try {
    const { data, providerUsed } = await ai.askMeeting(
      ai.renderTranscript(pre.lines), pre.ctx, parsed.data.question);
    // Q&A answers are saved so the panel keeps a history, but they are not the
    // meeting's "current" artifact of any kind.
    await ai.saveArtifact(pre.m.id, 'qa_answer', { question: parsed.data.question, ...data }, {
      providerUsed, segmentCount: pre.lines.length, requestedBy: actor(req).id,
    });
    res.json(ok({ ...data, providerUsed }));
  } catch (err) {
    res.status(502).json(fail(err instanceof Error ? err.message : 'AI generation failed.'));
  }
});

router.post('/:id/ai/lesson-followup', authorizePermission(AI_PERM), async (req: Request, res: Response) => {
  const pre = await aiPreflight(req, res);
  if (!pre) return;
  try {
    const { data, providerUsed } = await ai.generateLessonFollowUp(
      ai.renderTranscript(pre.lines), pre.ctx);
    const saved = await ai.saveArtifact(pre.m.id, 'lesson_followup', data, {
      providerUsed, segmentCount: pre.lines.length, requestedBy: actor(req).id,
    });
    res.json(ok({ ...saved, kind: 'lesson_followup', content: data, providerUsed }));
  } catch (err) {
    res.status(502).json(fail(err instanceof Error ? err.message : 'AI generation failed.'));
  }
});

/**
 * Engagement. The numbers are counted, not generated; only the closing
 * narrative goes to a model, and only when asked for.
 */
router.post('/:id/ai/engagement', authorizePermission('MEET_ATTENDANCE_VIEW'), async (req: Request, res: Response) => {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) return res.status(404).json(fail('Meeting not found.'));
  if (!(await requireHost(req, res, m))) return;

  const lines = await ai.loadTranscript(m.id);
  const ctx = await contextFor(m);
  const report = ai.computeEngagement(lines, ctx.participants);

  let providerUsed: string | undefined;
  if (req.body?.narrate && isAnyProviderConfigured() && lines.length >= 2) {
    try {
      const narration = await ai.narrateEngagement(report, ctx);
      report.narrative = narration.data;
      providerUsed = narration.providerUsed;
    } catch {
      // A missing narrative is not a reason to withhold the statistics.
    }
  }

  const saved = await ai.saveArtifact(m.id, 'engagement', report, {
    providerUsed, segmentCount: lines.length, requestedBy: actor(req).id,
  });
  res.json(ok({ ...saved, kind: 'engagement', content: report, providerUsed }));
});

/** Pre-meeting agenda. The only generator that needs no transcript. */
router.post('/:id/ai/agenda', authorizePermission(AI_PERM), async (req: Request, res: Response) => {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) return res.status(404).json(fail('Meeting not found.'));
  if (!isAnyProviderConfigured()) return res.status(503).json(fail('AI is not configured on this server.'));

  const minutes = Number(req.body?.durationMinutes) ||
    (m.scheduled_start && m.scheduled_end
      ? Math.round((m.scheduled_end.getTime() - m.scheduled_start.getTime()) / 60_000)
      : 30);

  try {
    const { data, providerUsed } = await ai.generateAgenda(await contextFor(m), minutes);
    const saved = await ai.saveArtifact(m.id, 'agenda', data, {
      providerUsed, requestedBy: actor(req).id,
    });
    res.json(ok({ ...saved, kind: 'agenda', content: data, providerUsed }));
  } catch (err) {
    res.status(502).json(fail(err instanceof Error ? err.message : 'AI generation failed.'));
  }
});

/** Live caption translation. Kept small and fast — it is on the caption path. */
router.post('/:id/ai/translate', authorizePermission('MEET_JOIN'), async (req: Request, res: Response) => {
  const { text, targetLang } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim() || typeof targetLang !== 'string') {
    return res.status(400).json(fail('text and targetLang are required.'));
  }
  if (!isAnyProviderConfigured()) return res.status(503).json(fail('AI is not configured on this server.'));

  try {
    const { data, providerUsed } = await ai.translateCaption(text.slice(0, 1000), targetLang);
    res.json(ok({ text: data, providerUsed }));
  } catch (err) {
    res.status(502).json(fail(err instanceof Error ? err.message : 'Translation failed.'));
  }
});

/* ================================================================== *
 * Notes — a person's own record, AI-assisted but never AI-owned
 * ================================================================== */

/** The caller's participant row in this meeting; notes are authored by it. */
async function participantFor(req: Request, meetingId: string): Promise<{
  id: string; displayName: string;
} | null> {
  const request = req as MeetRequest;
  if (request.guest) {
    const { rows } = await getPool().query<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM meeting_participants WHERE id = $1 AND meeting_id = $2',
      [request.guest.participantId, meetingId],
    );
    return rows[0] ? { id: rows[0].id, displayName: rows[0].display_name } : null;
  }
  const { rows } = await getPool().query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM meeting_participants
      WHERE meeting_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [meetingId, actor(req).id],
  );
  return rows[0] ? { id: rows[0].id, displayName: rows[0].display_name } : null;
}

router.get('/:id/notes', async (req: Request, res: Response) => {
  const me = await participantFor(req, param(req, 'id'));
  if (!me) return res.status(403).json(fail('You were not in this meeting.'));
  res.json(ok(await notes.listNotes(param(req, 'id'), me.id)));
});

router.post('/:id/notes', async (req: Request, res: Response) => {
  const meetingId = param(req, 'id');
  const me = await participantFor(req, meetingId);
  if (!me) return res.status(403).json(fail('You were not in this meeting.'));

  const parsed = createNoteSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(fail('A note needs some text.'));

  const note = await notes.createNote({
    meetingId,
    participantId: me.id,
    userId: isGuestRequest(req) ? null : actor(req).id,
    authorName: me.displayName,
    body: parsed.data.body,
    source: parsed.data.source,
    isShared: parsed.data.isShared,
    pinned: parsed.data.pinned,
  });
  res.status(201).json(ok(note));
});

router.patch('/:id/notes/:noteId', async (req: Request, res: Response) => {
  const me = await participantFor(req, param(req, 'id'));
  if (!me) return res.status(403).json(fail('You were not in this meeting.'));

  const parsed = updateNoteSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(fail('Invalid change.'));

  const note = await notes.updateNote(param(req, 'noteId'), me.id, parsed.data);
  // Not 403: the author check is in the WHERE clause, so "not yours" and "not
  // there" are the same answer — and that is the right answer to give.
  if (!note) return res.status(404).json(fail('Note not found.'));
  res.json(ok(note));
});

router.delete('/:id/notes/:noteId', async (req: Request, res: Response) => {
  const me = await participantFor(req, param(req, 'id'));
  if (!me) return res.status(403).json(fail('You were not in this meeting.'));
  const removed = await notes.deleteNote(param(req, 'noteId'), me.id);
  if (!removed) return res.status(404).json(fail('Note not found.'));
  res.json(ok({ deleted: true }));
});

/**
 * One-tap capture of what was just said.
 *
 * The moment worth writing down has usually just passed; by the time you have
 * typed it you have missed the next one. This reaches back over the transcript
 * instead, so manual note-taking survives a live meeting.
 */
router.post('/:id/notes/capture', async (req: Request, res: Response) => {
  const meetingId = param(req, 'id');
  const me = await participantFor(req, meetingId);
  if (!me) return res.status(403).json(fail('You were not in this meeting.'));

  const parsed = captureNoteSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(fail('Invalid capture window.'));

  const captured = await notes.captureFromTranscript(meetingId, parsed.data.seconds);
  if (!captured.lineCount) {
    return res.status(409).json(fail(
      'Nothing has been captioned in that time. Captures need live captions to be on.'));
  }

  res.status(201).json(ok(await notes.createNote({
    meetingId,
    participantId: me.id,
    userId: isGuestRequest(req) ? null : actor(req).id,
    authorName: me.displayName,
    body: captured.body,
    source: 'capture',
    isShared: parsed.data.isShared,
  })));
});

/**
 * Tidy up a note. AI-assisted, but the person still owns it: the pre-AI text is
 * kept on the row so this is always reversible.
 */
router.post('/:id/notes/:noteId/tidy', async (req: Request, res: Response) => {
  const meetingId = param(req, 'id');
  const me = await participantFor(req, meetingId);
  if (!me) return res.status(403).json(fail('You were not in this meeting.'));
  if (!isAnyProviderConfigured()) {
    return res.status(503).json(fail('AI is not configured on this server.'));
  }

  const { rows } = await getPool().query<{ body: string; original_body: string | null }>(
    `SELECT body, original_body FROM meeting_notes
      WHERE id = $1 AND participant_id = $2 AND deleted_at IS NULL`,
    [param(req, 'noteId'), me.id],
  );
  const existing = rows[0];
  if (!existing) return res.status(404).json(fail('Note not found.'));

  const m = await meet.findMeeting(meetingId);
  const recent = await ai.loadTranscript(meetingId, { limit: 40 });

  try {
    const tidied = await notes.tidyNote(existing.body, {
      title: m?.title ?? 'Meeting',
      recentTranscript: recent.length ? ai.renderTranscript(recent.slice(-25), 3000) : undefined,
    });
    await getPool().query(
      `UPDATE meeting_notes
          SET body = $3, source = 'tidied',
              -- Only stamp the original once, so tidying twice cannot lose it.
              original_body = COALESCE(original_body, $4),
              provider_used = $5, updated_at = now()
        WHERE id = $1 AND participant_id = $2`,
      [param(req, 'noteId'), me.id, tidied.body, existing.body, tidied.providerUsed],
    );
    const updated = await notes.listNotes(meetingId, me.id);
    res.json(ok(updated.find((n) => n.id === param(req, 'noteId'))));
  } catch (err) {
    res.status(502).json(fail(err instanceof Error ? err.message : 'The AI could not tidy that.'));
  }
});

/** Undo a tidy. */
router.post('/:id/notes/:noteId/restore', async (req: Request, res: Response) => {
  const meetingId = param(req, 'id');
  const me = await participantFor(req, meetingId);
  if (!me) return res.status(403).json(fail('You were not in this meeting.'));

  const { rows } = await getPool().query<{ original_body: string | null }>(
    `UPDATE meeting_notes
        SET body = original_body, source = 'manual',
            original_body = NULL, provider_used = NULL, updated_at = now()
      WHERE id = $1 AND participant_id = $2 AND original_body IS NOT NULL
        AND deleted_at IS NULL
      RETURNING original_body`,
    [param(req, 'noteId'), me.id],
  );
  if (!rows.length) return res.status(404).json(fail('There is nothing to restore.'));
  const updated = await notes.listNotes(meetingId, me.id);
  res.json(ok(updated.find((n) => n.id === param(req, 'noteId'))));
});

/* ================================================================== *
 * Recording
 * ================================================================== */

router.post('/:id/recording/start', denyGuests, authorizePermission('MEET_RECORD'),
  async (req: Request, res: Response) => {
    const m = await meet.findMeeting(param(req, 'id'));
    if (!m) return res.status(404).json(fail('Meeting not found.'));
    if (!(await requireHost(req, res, m))) return;

    const settings = parseMeetSettings(m.settings);
    if (!settings.recordingEnabled) {
      return res.status(409).json(fail('Recording is disabled for this meeting.'));
    }

    const parsed = startRecordingSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json(fail('Invalid recording request.'));

    // Recording happens in the host's browser: it composites the stage onto a
    // canvas, mixes the audio, and uploads the result. Cloudflare Realtime is
    // an SFU, not a recording product — it routes tracks and offers no
    // server-side compositing — so there is nowhere else with a view of the
    // meeting to record it from. Real recording with stated limits: it stops if
    // the host leaves, and it captures what the host could see.
    const mode = 'client' as const;
    if (parsed.data.mode === 'server') {
      return res.status(503).json(fail(
        'Server-side recording is not available on this deployment. Recording is made in ' +
        'the host browser instead — start it again without asking for server mode.'));
    }

    const { rows: open } = await getPool().query(
      `SELECT id FROM meeting_recordings WHERE meeting_id = $1 AND status = 'recording'`, [m.id]);
    if (open.length) return res.status(409).json(fail('This meeting is already being recorded.'));

    const id = snowflake();
    await getPool().query(
      `INSERT INTO meeting_recordings (id, meeting_id, started_by, status, mode, folder)
       VALUES ($1,$2,$3,'recording',$4,$5)`,
      [id, m.id, actor(req).id, mode, meetingFolder(m.id)],
    );
    await meet.logMeetEvent(m.id, 'recording.started', { actorId: actor(req).id, payload: { mode } });
    res.json(ok({
      recordingId: id, status: 'recording', mode, folder: meetingFolder(m.id),
      maxBytes: MAX_RECORDING_BYTES,
    }));
  });

router.post('/:id/recording/stop', denyGuests, authorizePermission('MEET_RECORD'),
  async (req: Request, res: Response) => {
    const m = await meet.findMeeting(param(req, 'id'));
    if (!m) return res.status(404).json(fail('Meeting not found.'));
    if (!(await requireHost(req, res, m))) return;

    const { rows } = await getPool().query(
      `UPDATE meeting_recordings
          SET status = CASE WHEN mode = 'client' THEN 'processing' ELSE 'processing' END,
              ended_at = now(),
              duration_seconds = EXTRACT(EPOCH FROM (now() - started_at))::int
        WHERE meeting_id = $1 AND status = 'recording'
        RETURNING id, mode, duration_seconds, folder`,
      [m.id],
    );
    if (!rows.length) return res.status(409).json(fail('This meeting is not being recorded.'));
    await meet.logMeetEvent(m.id, 'recording.stopped', { actorId: actor(req).id });
    res.json(ok(rows[0]));
  });

/**
 * Attach the uploaded file to a client-side recording.
 *
 * Two steps rather than one because the bytes go to the file service directly:
 * this only links the finished file to the meeting, and it is the point at
 * which a recording becomes readable.
 */
router.post('/:id/recordings/:recordingId/attach', denyGuests,
  authorizePermission('MEET_RECORD'), async (req: Request, res: Response) => {
    const m = await meet.findMeeting(param(req, 'id'));
    if (!m) return res.status(404).json(fail('Meeting not found.'));
    if (!(await requireHost(req, res, m))) return;

    const parsed = attachRecordingSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json(fail('Invalid recording metadata.'));
    if (parsed.data.sizeBytes > MAX_RECORDING_BYTES) {
      return res.status(413).json(fail('That recording is too large to store.'));
    }

    // The file must exist, be finished, and belong to the person attaching it —
    // otherwise this endpoint would let a host staple someone else's file to
    // their meeting.
    const { rows: files } = await getPool().query<{ owner_id: string; status: string }>(
      'SELECT owner_id, status FROM files WHERE id = $1', [parsed.data.fileId]);
    const file = files[0];
    if (!file) return res.status(404).json(fail('That upload does not exist.'));
    if (file.owner_id !== actor(req).id) {
      return res.status(403).json(fail('That upload is not yours.'));
    }
    if (file.status !== 'ready') {
      return res.status(409).json(fail('That upload has not finished.'));
    }

    const { rows } = await getPool().query(
      `UPDATE meeting_recordings
          SET file_id = $3, status = 'ready',
              duration_seconds = COALESCE(duration_seconds, $4),
              size_bytes = $5,
              ended_at = COALESCE(ended_at, now())
        WHERE id = $1 AND meeting_id = $2
        RETURNING id, file_id, mode, status, duration_seconds, size_bytes, started_at, ended_at`,
      [param(req, 'recordingId'), m.id, parsed.data.fileId,
        parsed.data.durationSeconds, parsed.data.sizeBytes],
    );
    if (!rows.length) return res.status(404).json(fail('Recording not found.'));
    res.json(ok(rows[0]));
  });

/** Mark a client recording that never produced a file, so it does not hang. */
router.post('/:id/recordings/:recordingId/fail', denyGuests,
  authorizePermission('MEET_RECORD'), async (req: Request, res: Response) => {
    const m = await meet.findMeeting(param(req, 'id'));
    if (!m) return res.status(404).json(fail('Meeting not found.'));
    if (!(await requireHost(req, res, m))) return;

    await getPool().query(
      `UPDATE meeting_recordings SET status = 'failed', ended_at = COALESCE(ended_at, now())
        WHERE id = $1 AND meeting_id = $2 AND status <> 'ready'`,
      [param(req, 'recordingId'), m.id],
    );
    res.json(ok({ status: 'failed' }));
  });

router.get('/:id/recordings', async (req: Request, res: Response) => {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) return res.status(404).json(fail('Meeting not found.'));
  const { rows } = await getPool().query(
    `SELECT r.id, r.meeting_id, r.file_id, r.mode, r.status, r.duration_seconds,
            r.size_bytes, r.folder, r.started_at, r.ended_at,
            u.name AS started_by_name, f.original_name, f.mime_type
       FROM meeting_recordings r
       LEFT JOIN users u ON u.id = r.started_by
       LEFT JOIN files f ON f.id = r.file_id
      WHERE r.meeting_id = $1 ORDER BY r.started_at DESC`,
    [m.id],
  );
  res.json(ok(rows));
});

/* ================================================================== *
 * Invites
 * ================================================================== */

router.post('/:id/invites', authorizePermission('MEET_SCHEDULE'), async (req: Request, res: Response) => {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) return res.status(404).json(fail('Meeting not found.'));
  if (!(await requireHost(req, res, m))) return;

  const userIds: string[] = Array.isArray(req.body?.userIds) ? req.body.userIds.slice(0, 500) : [];
  if (!userIds.length) return res.status(400).json(fail('No invitees given.'));

  await getPool().query(
    `INSERT INTO meeting_invites (meeting_id, user_id)
     SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
    [m.id, userIds],
  );
  reminders.queueMeetingReminderSync(m.id);
  res.json(ok({ invited: userIds.length }));
});

router.put('/:id/invites/me', async (req: Request, res: Response) => {
  const response = String(req.body?.response ?? '');
  if (!['accepted', 'declined', 'tentative'].includes(response)) {
    return res.status(400).json(fail('Response must be accepted, declined or tentative.'));
  }
  const { rowCount } = await getPool().query(
    `UPDATE meeting_invites SET response = $3 WHERE meeting_id = $1 AND user_id = $2`,
    [param(req, 'id'), actor(req).id, response],
  );
  if (!rowCount) return res.status(404).json(fail('You were not invited to this meeting.'));
  // Declining takes you out of the reminder audience; accepting puts you back.
  reminders.queueMeetingReminderSync(param(req, 'id'));
  res.json(ok({ response }));
});

/** An ICS attachment, so a meeting lands in whatever calendar the user uses. */
router.get('/:id/ics', async (req: Request, res: Response) => {
  const m = await meet.findMeeting(param(req, 'id'));
  if (!m) return res.status(404).json(fail('Meeting not found.'));

  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const start = m.scheduled_start ?? m.started_at ?? m.created_at;
  const end = m.scheduled_end ?? new Date(start.getTime() + 60 * 60 * 1000);
  const url = `${req.protocol}://${req.get('host')}/app/meet/${m.join_code}`;

  // Long lines must be folded at 75 octets per RFC 5545, and CRLF is required —
  // a bare LF is silently dropped by some calendar clients.
  const fold = (line: string) =>
    line.length <= 75 ? line
      : line.match(/.{1,74}/g)!.map((c, i) => (i === 0 ? c : ` ${c}`)).join('\r\n');

  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NGA//Tupo Meet//EN', 'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${m.id}@tupo.amashuri.com`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    fold(`SUMMARY:${m.title.replace(/[\n,;]/g, ' ')}`),
    fold(`DESCRIPTION:Join the meeting: ${url}\\nCode: ${m.join_code}`),
    fold(`LOCATION:${url}`),
    ...(m.recurrence_rule ? [`RRULE:${m.recurrence_rule}`] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${m.join_code}.ics"`);
  res.send(ics);
});

export default router;


/**
 * Announce a meeting that has just gone live.
 *
 * Runs off the request path, so everything in here is best-effort: the meeting
 * has already started by the time this is called, and nothing it does may
 * change that.
 */
async function announceLive(meetingId: string): Promise<void> {
  const m = await meet.findMeeting(meetingId);
  if (!m || m.status !== 'live') return;

  const settings = parseMeetSettings(m.settings);
  const { userIds, truncated } = await meet.audienceFor(m.id, settings);
  if (truncated) {
    // Named rather than silent: "nobody was notified" must never look the same
    // as "everybody was notified".
    console.warn(`[meet] ${m.id} audience exceeds ${meet.NOTIFY_BROADCAST_CAP}; not notifying`);
    return;
  }

  const { rows: hostRows } = await getPool().query<{ name: string }>(
    `SELECT name FROM users WHERE id = $1`, [m.host_id]);
  const hostName = hostRows[0]?.name ?? null;

  await notifications.notifyAndPush(userIds, {
    kind: 'meet.live',
    title: `${m.title} has started`,
    body: hostName ? `Hosted by ${hostName}` : null,
    link: `/app/meet/${m.id}`,
    subjectType: 'meeting',
    subjectId: m.id,
  }, {
    // The host does not need to be told about their own meeting.
    exclude: [m.host_id],
  });
}
