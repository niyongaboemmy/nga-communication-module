import { getPool, snowflake } from '@tupo/db';
import {
  DEFAULT_MEET_SETTINGS, MESH_MAX_PARTICIPANTS, capacityFor,
  generateJoinCode, parseMeetSettings, severityFor,
} from '@tupo/shared';
import type {
  MeetParticipant, MeetRole, MeetSettings, MeetSummaryPayload, MeetTransport, MeetingStatus,
  ParticipantState,
} from '@tupo/shared';
import { isCloudflareSfuConfigured } from './cloudflareSfuService.js';

/**
 * Meeting lifecycle, admission policy and the attendance record.
 *
 * This is the analogue of TaskMentor's proctoring session service: it owns the
 * session row, the participant state machine, and the severity-tagged event
 * stream both the live host console and the after-the-fact analytics read from.
 */

export interface MeetingRow {
  id: string;
  conversation_id: string | null;
  space_id: string | null;
  host_id: string;
  title: string;
  description: string | null;
  room_name: string;
  join_code: string;
  status: MeetingStatus;
  media_mode: string;
  transport: MeetTransport | null;
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  recurrence_rule: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  settings: unknown;
  peak_participants: number;
  total_participants: number;
  created_at: Date;
}

export interface ParticipantRow {
  id: string;
  meeting_id: string;
  user_id: string | null;
  display_name: string;
  is_guest: boolean;
  role: MeetRole;
  state: ParticipantState;
  connection_quality: string;
  audio_enabled: boolean;
  video_enabled: boolean;
  screen_sharing: boolean;
  hand_raised_at: Date | null;
  joined_at: Date | null;
  left_at: Date | null;
  duration_seconds: number;
  speaking_seconds: number;
  avatar_url?: string | null;
}

/* ------------------------------------------------------------------ *
 * Events — the proctoring event model
 * ------------------------------------------------------------------ */

/**
 * Append a meeting event. Severity is derived from the type rather than passed
 * in, so the same thing happening twice can never be logged at two different
 * severities — the bug that makes an event stream useless for filtering.
 *
 * Never throws: an event write failing must not take down the thing it was
 * describing. A meeting that keeps running with a gap in its log is strictly
 * better than one that drops a participant because logging failed.
 */
export async function logMeetEvent(
  meetingId: string,
  type: string,
  opts: { participantId?: string | null; actorId?: string | null; payload?: unknown } = {},
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO meeting_events (id, meeting_id, participant_id, actor_id, type, severity, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [snowflake(), meetingId, opts.participantId ?? null, opts.actorId ?? null,
        type, severityFor(type), JSON.stringify(opts.payload ?? {})],
    );
  } catch (err) {
    console.error('[meet] event log failed:', err instanceof Error ? err.message : err);
  }
}

/* ------------------------------------------------------------------ *
 * Creation
 * ------------------------------------------------------------------ */

/**
 * Join codes are short enough to read aloud, which means collisions are
 * possible in principle. Retry a few times rather than trusting one draw; the
 * unique index is the real guarantee and this just avoids surfacing it.
 */
async function allocateJoinCode(): Promise<string> {
  const pool = getPool();
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateJoinCode();
    const { rows } = await pool.query('SELECT 1 FROM meetings WHERE join_code = $1', [code]);
    if (rows.length === 0) return code;
  }
  throw new Error('Could not allocate a unique join code. Try again.');
}

export interface CreateMeetingParams {
  hostId: string;
  title?: string;
  description?: string;
  conversationId?: string;
  spaceId?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  recurrenceRule?: string;
  mediaMode?: string;
  settings?: Partial<MeetSettings>;
  inviteeIds?: string[];
  /** An instant meeting goes straight to `live`; a scheduled one waits. */
  startNow?: boolean;
}

export async function createMeeting(params: CreateMeetingParams): Promise<MeetingRow> {
  const pool = getPool();
  const id = snowflake();
  const joinCode = await allocateJoinCode();
  // The room name is unguessable and never shown; the join code is the handle
  // people share. Keeping them separate means a code can be rotated after a
  // leak without moving the room or invalidating live tokens.
  const roomName = `tupo-${id}`;
  const settings = { ...DEFAULT_MEET_SETTINGS, ...(params.settings ?? {}) };
  const status: MeetingStatus = params.startNow ? 'live' : 'scheduled';

  const { rows } = await pool.query<MeetingRow>(
    `INSERT INTO meetings
       (id, conversation_id, space_id, host_id, title, description, room_name, join_code,
        status, media_mode, scheduled_start, scheduled_end, recurrence_rule, settings, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      id, params.conversationId ?? null, params.spaceId ?? null, params.hostId,
      params.title?.trim() || 'Meeting', params.description ?? null, roomName, joinCode,
      status, params.mediaMode ?? 'auto',
      params.scheduledStart ?? null, params.scheduledEnd ?? null, params.recurrenceRule ?? null,
      JSON.stringify(settings), params.startNow ? new Date() : null,
    ],
  );

  const meeting = rows[0]!;

  if (params.inviteeIds?.length) {
    // ON CONFLICT because an invitee list is often re-submitted wholesale when
    // a scheduled meeting is edited.
    await pool.query(
      `INSERT INTO meeting_invites (meeting_id, user_id)
       SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
      [id, params.inviteeIds],
    );
  }

  await logMeetEvent(id, 'meeting.created', {
    actorId: params.hostId,
    payload: { title: meeting.title, mediaMode: meeting.media_mode, scheduled: !params.startNow },
  });

  return meeting;
}

/* ------------------------------------------------------------------ *
 * Lookup
 * ------------------------------------------------------------------ */

export async function findMeeting(idOrCode: string): Promise<MeetingRow | null> {
  const { rows } = await getPool().query<MeetingRow>(
    'SELECT * FROM meetings WHERE id = $1 OR join_code = $1 LIMIT 1', [idOrCode],
  );
  return rows[0] ?? null;
}

export async function activeParticipantCount(meetingId: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM meeting_participants
      WHERE meeting_id = $1 AND state IN ('connecting','active','reconnecting')`,
    [meetingId],
  );
  return Number(rows[0]?.count ?? 0);
}

/* ------------------------------------------------------------------ *
 * Transport selection
 * ------------------------------------------------------------------ */

export interface TransportDecision {
  transport: MeetTransport;
  reason: string;
}

/**
 * Pick the media transport for a meeting.
 *
 * `auto` prefers the SFU whenever one is configured — it is strictly better at
 * any size, because a publisher uploads once instead of once per peer. Mesh is
 * what makes the module work with no media infrastructure at all, and it is
 * genuinely the better choice for a two-person call: no server hop, so lower
 * latency and no egress bill.
 *
 * The size check is not advisory. Above MESH_MAX_PARTICIPANTS each laptop would
 * be uploading N−1 copies of its own camera, and the call falls apart in a way
 * that is very hard to diagnose from the inside — so the server refuses and
 * says why rather than letting it happen.
 */
export function decideTransport(mediaMode: string, expectedParticipants: number): TransportDecision {
  const cloudflare = isCloudflareSfuConfigured();

  if (mediaMode === 'cloudflare') {
    if (!cloudflare) {
      throw new Error(
        'This meeting requires the Cloudflare media server, which is not configured. ' +
        'Set CLOUDFLARE_REALTIME_APP_ID and CLOUDFLARE_REALTIME_APP_SECRET, or switch ' +
        'the meeting to automatic.',
      );
    }
    return { transport: 'cloudflare', reason: 'requested' };
  }

  // 'sfu' is a legacy alias. It used to mean the self-hosted server; it now
  // means "whatever SFU this deployment has", which is Cloudflare. Kept so a
  // meeting configured before the switch still opens instead of erroring.
  if (mediaMode === 'sfu') {
    if (cloudflare) return { transport: 'cloudflare', reason: 'requested; Cloudflare available' };
    throw new Error(
      'This meeting requires a media server, but none is configured. Set ' +
      'CLOUDFLARE_REALTIME_APP_ID and CLOUDFLARE_REALTIME_APP_SECRET, or switch the ' +
      'meeting to automatic.',
    );
  }

  if (mediaMode === 'mesh') {
    if (expectedParticipants > MESH_MAX_PARTICIPANTS) {
      throw new Error(
        `A peer-to-peer meeting is limited to ${MESH_MAX_PARTICIPANTS} participants — ` +
        `each person uploads one video stream per other person. This meeting has ` +
        `${expectedParticipants}. Switch it to automatic so it can use the media server.`,
      );
    }
    return { transport: 'mesh', reason: 'requested' };
  }

  /* auto — prefer the media server whenever there is one.
   *
   * An SFU is strictly better at any size: a publisher uploads once instead of
   * once per peer. Mesh survives only as the no-media-server fallback, and
   * only small. */
  if (cloudflare) return { transport: 'cloudflare', reason: 'Cloudflare Realtime available' };

  if (expectedParticipants > MESH_MAX_PARTICIPANTS) {
    throw new Error(
      `This meeting has ${expectedParticipants} participants, which needs a media ` +
      `server, but none is configured. Peer-to-peer meetings are limited to ` +
      `${MESH_MAX_PARTICIPANTS}. Set CLOUDFLARE_REALTIME_APP_ID and ` +
      `CLOUDFLARE_REALTIME_APP_SECRET to lift that.`,
    );
  }
  return { transport: 'mesh', reason: 'no media server configured' };
}

/* ------------------------------------------------------------------ *
 * Admission
 * ------------------------------------------------------------------ */

export interface AdmissionDecision {
  state: ParticipantState;
  role: MeetRole;
  reason: string;
}

/**
 * Decide where a joiner lands: straight in, in the lobby, or refused.
 *
 * Order matters and is deliberate. The host is checked before the lock, so a
 * host can never lock themselves out of their own meeting — the failure mode
 * that turns a support ticket into a cancelled lesson.
 */
export function decideAdmission(params: {
  meeting: MeetingRow;
  settings: MeetSettings;
  userId: string | null;
  isInvited: boolean;
  isConversationMember: boolean;
  hasHostControls: boolean;
  /** Whether the caller holds MEET_JOIN. Guests never do. */
  hasJoinPermission?: boolean;
}): AdmissionDecision {
  const {
    meeting, settings, userId, isInvited, isConversationMember, hasHostControls,
  } = params;
  const hasJoinPermission = params.hasJoinPermission ?? true;
  const policy = settings.admissionPolicy;

  if (userId && userId === meeting.host_id) {
    return { state: 'active', role: 'host', reason: 'host' };
  }

  if (settings.locked) {
    return { state: 'denied', role: 'attendee', reason: 'This meeting is locked.' };
  }

  /* ---- eligibility, before anything about timing ---- */

  // Only a public meeting admits someone with no account.
  if (!userId && policy !== 'public') {
    return {
      state: 'denied', role: 'attendee',
      reason: 'This meeting is only open to members of the institution. Please sign in.',
    };
  }

  if (policy === 'invited' && !isInvited && !isConversationMember) {
    return {
      state: 'denied', role: 'attendee',
      reason: 'This meeting is for invited people only.',
    };
  }

  // 'authenticated' and 'public' deliberately do NOT require MEET_JOIN — the
  // point of both is to admit people the role model would otherwise exclude,
  // which is exactly what an assembly or a parents' evening needs.
  if (policy === 'permission' && !hasJoinPermission) {
    return {
      state: 'denied', role: 'attendee',
      reason: 'Your account does not have permission to join meetings.',
    };
  }

  // Someone who can run meetings and was invited is a co-host, not an attendee:
  // a lesson with two teachers should not need the first one to promote the
  // second every single time.
  const role: MeetRole = hasHostControls && isInvited ? 'cohost' : 'attendee';

  if (meeting.status === 'scheduled' && settings.waitForHost) {
    return { state: 'lobby', role, reason: 'The meeting has not started yet.' };
  }

  // A guest ALWAYS knocks. Checked before the lobby-disabled shortcut below,
  // because otherwise a public meeting with the waiting room switched off would
  // admit anonymous strangers with no host ever seeing them — and "public" and
  // "no waiting room" are two settings a host could easily combine by accident.
  if (!userId) return { state: 'knocking', role, reason: 'guest' };

  if (!settings.lobbyEnabled) return { state: 'active', role, reason: 'lobby disabled' };

  if (settings.trustConversationMembers && isConversationMember) {
    return { state: 'active', role, reason: 'conversation member' };
  }
  if (isInvited) return { state: 'active', role, reason: 'invited' };

  // Under 'invited' we would already have refused; reaching here means the
  // policy is broader than the invite list, so an uninvited but eligible
  // person knocks rather than being turned away.
  return { state: 'knocking', role, reason: 'not invited' };
}

/**
 * Capacity, enforced here rather than trusted to the client.
 *
 * A function of the transport, because the constraint is different in kind.
 * Peer-to-peer is bounded by every publisher's *uplink*, which grows with the
 * room. Through an SFU each publisher uploads once however large the audience,
 * and the bound moves to each subscriber's downlink — which is already handled
 * by rendering at most MAX_VIDEO_TILES and subscribing to nothing else. That is
 * what makes a several-hundred-person assembly possible rather than theoretical.
 */
export function assertCapacity(
  settings: MeetSettings, currentCount: number, transport: MeetTransport = 'cloudflare',
): void {
  const cap = capacityFor(transport, settings.audioOnly);
  if (currentCount < cap) return;

  // On mesh, "full at 4" is technically true and useless. The reason the cap is
  // four is that there is no media server, and that is the thing someone can
  // actually do something about.
  if (transport === 'mesh') {
    throw new Error(
      `This meeting is peer-to-peer and limited to ${cap} people, because no media ` +
      `server is configured. Set CLOUDFLARE_REALTIME_APP_ID and ` +
      `CLOUDFLARE_REALTIME_APP_SECRET to hold meetings of any size.`,
    );
  }
  throw new Error(`This meeting is full (${cap} participants).`);
}

/* ------------------------------------------------------------------ *
 * Participants
 * ------------------------------------------------------------------ */

export interface UpsertParticipantParams {
  meetingId: string;
  userId: string | null;
  displayName: string;
  isGuest: boolean;
  role: MeetRole;
  state: ParticipantState;
  deviceLabel?: string;
  ipAddress?: string;
  settings: MeetSettings;
}

/**
 * Create or resume a participant row.
 *
 * Resuming matters: a reconnect inside the same meeting must reuse the existing
 * row so the attendance record shows one attendance with an accumulated
 * duration, not two half-attendances — which is exactly what a lesson-delivery
 * export would otherwise report for anyone whose wifi hiccupped.
 */
export async function upsertParticipant(p: UpsertParticipantParams): Promise<ParticipantRow> {
  const pool = getPool();

  if (p.userId) {
    const { rows: existing } = await pool.query<ParticipantRow>(
      `SELECT * FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 LIMIT 1`,
      [p.meetingId, p.userId],
    );
    if (existing[0]) {
      const prior = existing[0];
      // Never demote on rejoin. Someone promoted to co-host who then reconnects
      // must come back as a co-host.
      const role = rankRole(prior.role) > rankRole(p.role) ? prior.role : p.role;
      const { rows } = await pool.query<ParticipantRow>(
        `UPDATE meeting_participants
            SET state = $3, role = $4, display_name = $5, device_label = COALESCE($6, device_label),
                joined_at = COALESCE(joined_at, CASE WHEN $3 = 'active' THEN now() END),
                left_at = NULL
          WHERE id = $1 AND meeting_id = $2
          RETURNING *`,
        [prior.id, p.meetingId, p.state, role, p.displayName, p.deviceLabel ?? null],
      );
      return rows[0]!;
    }
  }

  const id = snowflake();
  const { rows } = await pool.query<ParticipantRow>(
    `INSERT INTO meeting_participants
       (id, meeting_id, user_id, display_name, is_guest, role, state,
        audio_enabled, video_enabled, device_label, ip_address, knocked_at, joined_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      id, p.meetingId, p.userId, p.displayName, p.isGuest, p.role, p.state,
      // FR-MEET-4: the join-muted default is a setting, and it is on by default
      // because a room where everyone arrives live is a room nobody can use.
      !p.settings.joinMuted,
      !p.settings.joinCameraOff && !p.settings.audioOnly,
      p.deviceLabel ?? null, p.ipAddress ?? null,
      p.state === 'knocking' || p.state === 'lobby' ? new Date() : null,
      p.state === 'active' ? new Date() : null,
    ],
  );

  await pool.query('UPDATE meetings SET total_participants = total_participants + 1 WHERE id = $1',
    [p.meetingId]);

  return rows[0]!;
}

const rankRole = (role: string): number =>
  ['attendee', 'presenter', 'cohost', 'host'].indexOf(role);

/** The roster the room renders. Joins users for avatars in one query, not N. */
export async function listParticipants(
  meetingId: string,
  states: ParticipantState[] = ['connecting', 'active', 'reconnecting'],
): Promise<MeetParticipant[]> {
  const { rows } = await getPool().query<ParticipantRow>(
    `SELECT p.*, u.avatar_url
       FROM meeting_participants p
       LEFT JOIN users u ON u.id = p.user_id
      WHERE p.meeting_id = $1 AND p.state = ANY($2::text[])
      ORDER BY p.created_at`,
    [meetingId, states],
  );
  return rows.map(toWireParticipant);
}

export function toWireParticipant(r: ParticipantRow): MeetParticipant {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.display_name,
    avatarUrl: r.avatar_url ?? null,
    role: r.role,
    state: r.state,
    isGuest: r.is_guest,
    audioEnabled: r.audio_enabled,
    videoEnabled: r.video_enabled,
    screenSharing: r.screen_sharing,
    handRaised: !!r.hand_raised_at,
    handRaisedAt: r.hand_raised_at ? r.hand_raised_at.toISOString() : null,
    speaking: false,
    connectionQuality: (r.connection_quality as MeetParticipant['connectionQuality']) ?? 'good',
    joinedAt: (r.joined_at ?? new Date()).toISOString(),
  };
}

/**
 * Close a participant's leg and bank the time.
 *
 * `duration_seconds` accumulates rather than being overwritten, which is what
 * makes the attendance export correct across reconnects. GREATEST(...,0) guards
 * against a clock that moved backwards mid-call.
 */
export async function markParticipantLeft(participantId: string, state: ParticipantState = 'left'): Promise<void> {
  await getPool().query(
    `UPDATE meeting_participants
        SET state = $2,
            left_at = now(),
            duration_seconds = duration_seconds + GREATEST(
              EXTRACT(EPOCH FROM (now() - COALESCE(joined_at, now())))::int, 0)
      WHERE id = $1 AND left_at IS NULL`,
    [participantId, state],
  );
}

/* ------------------------------------------------------------------ *
 * Audience
 * ------------------------------------------------------------------ */

/**
 * Everyone who may join this meeting, for notifying them that it has started.
 *
 * This deliberately mirrors `decideAdmission` rather than reimplementing it:
 * whoever would be let in is whoever should be told. The three categories map
 * cleanly —
 *
 *   private     the people actually invited
 *   loggedIn    every active account
 *   public      also every active account; anonymous guests have no inbox, so
 *               there is nobody else to reach
 *
 * `loggedIn` and `public` are capped. Notifying an entire institution about
 * one meeting is how a notification system trains people to ignore it, and a
 * fan-out of thousands of rows per meeting start is a real cost. Above the cap
 * nobody is notified and the meeting is found the ordinary way — which is the
 * honest outcome, and is why the cap is named rather than silent.
 */
export const NOTIFY_BROADCAST_CAP = 500;

export async function audienceFor(
  meetingId: string, settings: MeetSettings,
): Promise<{ userIds: string[]; truncated: boolean }> {
  const pool = getPool();

  if (settings.admissionPolicy === 'invited') {
    const { rows } = await pool.query<{ user_id: string }>(
      `SELECT i.user_id
         FROM meeting_invites i
         JOIN users u ON u.id = i.user_id AND u.status = 'active'
        WHERE i.meeting_id = $1`,
      [meetingId],
    );
    return { userIds: rows.map((r) => r.user_id), truncated: false };
  }

  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE status = 'active' LIMIT $1`,
    [NOTIFY_BROADCAST_CAP + 1],
  );
  if (rows.length > NOTIFY_BROADCAST_CAP) return { userIds: [], truncated: true };
  return { userIds: rows.map((r) => r.id), truncated: false };
}

/* ------------------------------------------------------------------ *
 * Lifecycle transitions
 * ------------------------------------------------------------------ */

export async function startMeeting(meetingId: string, actorId: string): Promise<void> {
  const { rowCount } = await getPool().query(
    `UPDATE meetings SET status = 'live', started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = $1 AND status IN ('scheduled','live')`,
    [meetingId],
  );
  if (rowCount) await logMeetEvent(meetingId, 'meeting.started', { actorId });
}

export async function endMeeting(meetingId: string, actorId: string): Promise<void> {
  const pool = getPool();
  // Close every open leg before the meeting itself, so nobody is left with a
  // NULL left_at that the attendance export would have to guess about.
  await pool.query(
    `UPDATE meeting_participants
        SET state = 'left', left_at = now(),
            duration_seconds = duration_seconds + GREATEST(
              EXTRACT(EPOCH FROM (now() - COALESCE(joined_at, now())))::int, 0)
      WHERE meeting_id = $1 AND left_at IS NULL`,
    [meetingId],
  );
  await pool.query(
    `UPDATE meetings SET status = 'ended', ended_at = now(), updated_at = now() WHERE id = $1`,
    [meetingId],
  );
  await logMeetEvent(meetingId, 'meeting.ended', { actorId });
}

export async function updateSettings(
  meetingId: string, patch: Partial<MeetSettings>,
): Promise<MeetSettings> {
  const pool = getPool();
  const { rows } = await pool.query<{ settings: unknown }>(
    'SELECT settings FROM meetings WHERE id = $1', [meetingId],
  );
  const merged = { ...parseMeetSettings(rows[0]?.settings), ...patch };
  await pool.query('UPDATE meetings SET settings = $2, updated_at = now() WHERE id = $1',
    [meetingId, JSON.stringify(merged)]);
  return merged;
}

/** Peak concurrency, recorded as it happens because it cannot be recovered later. */
export async function recordPeak(meetingId: string, current: number): Promise<void> {
  await getPool().query(
    'UPDATE meetings SET peak_participants = GREATEST(peak_participants, $2) WHERE id = $1',
    [meetingId, current],
  );
}

/* ------------------------------------------------------------------ *
 * Wire shape
 * ------------------------------------------------------------------ */

export function toSummaryPayload(m: MeetingRow, transport: MeetTransport): MeetSummaryPayload {
  return {
    meetingId: m.id,
    title: m.title,
    status: m.status,
    transport,
    settings: parseMeetSettings(m.settings),
    joinCode: m.join_code,
    roomName: m.room_name,
    hostId: m.host_id,
    startedAt: m.started_at ? m.started_at.toISOString() : null,
    endedAt: m.ended_at ? m.ended_at.toISOString() : null,
  };
}
