import pg from 'pg';
import { config } from '../config.js';

/**
 * The realtime gateway's own database handle.
 *
 * It is deliberately NOT `@tupo/db`: the gateway needs a handful of narrow
 * writes on the hot path (a caption every second or two, a chat line, a
 * participant state change) and pulling in Drizzle for that would add a
 * dependency it otherwise does not have. A small pool and hand-written SQL is
 * the honest shape here.
 *
 * Every function in this file is written to fail soft. The gateway's job is to
 * keep a meeting running; a failed insert should cost a caption, not the call.
 */

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on('error', (err) => console.error('[meet/db] idle client error:', err.message));
  }
  return pool;
}

export async function ping(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Snowflake ids, duplicated from @tupo/db for the same reason as the pool. */
const EPOCH = 1_735_689_600_000;
let lastMs = 0n;
let sequence = 0n;
const nodeId = BigInt((Number(process.env.NODE_ID ?? 1) & 0x3ff));

export function snowflake(): string {
  let now = BigInt(Date.now() - EPOCH);
  if (now === lastMs) {
    sequence = (sequence + 1n) & 0xfffn;
    if (sequence === 0n) {
      while (BigInt(Date.now() - EPOCH) <= lastMs) { /* spin to the next ms */ }
      now = BigInt(Date.now() - EPOCH);
    }
  } else {
    sequence = 0n;
  }
  lastMs = now;
  return ((now << 22n) | (nodeId << 12n) | sequence).toString();
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export interface MeetingRecord {
  id: string;
  host_id: string;
  title: string;
  room_name: string;
  join_code: string;
  status: string;
  transport: string | null;
  settings: Record<string, unknown>;
  started_at: Date | null;
  conversation_id: string | null;
}

export async function loadMeeting(meetingId: string): Promise<MeetingRecord | null> {
  const { rows } = await getPool().query<MeetingRecord>(
    `SELECT id, host_id, title, room_name, join_code, status, transport, settings,
            started_at, conversation_id
       FROM meetings WHERE id = $1`,
    [meetingId],
  );
  return rows[0] ?? null;
}

export interface ParticipantRecord {
  id: string;
  meeting_id: string;
  user_id: string | null;
  display_name: string;
  is_guest: boolean;
  role: string;
  state: string;
  audio_enabled: boolean;
  video_enabled: boolean;
  screen_sharing: boolean;
  hand_raised_at: Date | null;
  connection_quality: string;
  joined_at: Date | null;
  avatar_url: string | null;
  sfu_session_id: string | null;
}

/**
 * Load a participant, but only when the socket's user actually owns that row.
 * This is the gateway's authorization boundary: the join handshake verified a
 * session JWT, and this verifies that the `participantId` the client claims is
 * one the API issued to *them*.
 */
export async function loadParticipant(
  meetingId: string, participantId: string, userId: string,
): Promise<ParticipantRecord | null> {
  const { rows } = await getPool().query<ParticipantRecord>(
    `SELECT p.*, u.avatar_url FROM meeting_participants p
       LEFT JOIN users u ON u.id = p.user_id
      WHERE p.id = $1 AND p.meeting_id = $2 AND p.user_id = $3`,
    [participantId, meetingId, userId],
  );
  return rows[0] ?? null;
}

/** A guest's row, looked up by the binding in their ticket rather than a user id. */
export async function loadGuestParticipant(
  meetingId: string, participantId: string,
): Promise<ParticipantRecord | null> {
  const { rows } = await getPool().query<ParticipantRecord>(
    `SELECT p.*, NULL::text AS avatar_url FROM meeting_participants p
      WHERE p.id = $1 AND p.meeting_id = $2 AND p.is_guest = true
        AND p.state NOT IN ('removed','denied')`,
    [participantId, meetingId],
  );
  return rows[0] ?? null;
}

export async function loadRoster(meetingId: string): Promise<ParticipantRecord[]> {
  const { rows } = await getPool().query<ParticipantRecord>(
    `SELECT p.*, u.avatar_url FROM meeting_participants p
       LEFT JOIN users u ON u.id = p.user_id
      WHERE p.meeting_id = $1 AND p.state IN ('active','connecting','reconnecting','lobby','knocking')
      ORDER BY p.created_at`,
    [meetingId],
  );
  return rows;
}

export async function recentChat(meetingId: string, participantId: string, limit = 200) {
  // Private messages are visible only to their two ends — filtered in SQL, not
  // in the client, so an inspected socket frame cannot leak someone else's DM.
  const { rows } = await getPool().query(
    `SELECT c.id, c.meeting_id, c.participant_id, c.sender_name, c.body,
            c.to_participant_id, c.created_at
       FROM meeting_chat_messages c
      WHERE c.meeting_id = $1
        AND (c.to_participant_id IS NULL
             OR c.to_participant_id = $2 OR c.participant_id = $2)
      ORDER BY c.created_at DESC LIMIT $3`,
    [meetingId, participantId, limit],
  );
  return rows.reverse();
}

export async function loadPolls(meetingId: string, participantId: string) {
  const { rows } = await getPool().query(
    `SELECT p.id, p.meeting_id, p.kind, p.question, p.options, p.correct_option_index,
            p.anonymous, p.multiple_choice, p.status, p.created_at,
            COALESCE(v.tally, '[]'::jsonb) AS tally,
            (SELECT option_indexes FROM meeting_poll_votes
              WHERE poll_id = p.id AND participant_id = $2) AS my_vote
       FROM meeting_polls p
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(option_indexes) AS tally
           FROM meeting_poll_votes WHERE poll_id = p.id
       ) v ON true
      WHERE p.meeting_id = $1 ORDER BY p.created_at`,
    [meetingId, participantId],
  );
  return rows;
}

export async function loadQuestions(meetingId: string) {
  const { rows } = await getPool().query(
    `SELECT id, meeting_id, participant_id, asked_by, text, upvotes, answered,
            answer_text, created_at
       FROM meeting_questions WHERE meeting_id = $1
      ORDER BY answered, upvotes DESC, created_at`,
    [meetingId],
  );
  return rows;
}

export async function loadBreakouts(meetingId: string) {
  const { rows } = await getPool().query(
    `SELECT b.id, b.meeting_id, b.name, b.status, b.closes_at,
            COALESCE(
              (SELECT jsonb_agg(m.participant_id) FROM meeting_breakout_members m
                WHERE m.breakout_id = b.id), '[]'::jsonb) AS participant_ids
       FROM meeting_breakouts b
      WHERE b.meeting_id = $1 AND b.status = 'open' ORDER BY b.created_at`,
    [meetingId],
  );
  return rows;
}

/* ------------------------------------------------------------------ *
 * Writes — all fail-soft
 * ------------------------------------------------------------------ */

const soft = (label: string) => (err: unknown) =>
  console.error(`[meet/db] ${label} failed:`, err instanceof Error ? err.message : err);

export function logEvent(
  meetingId: string, type: string, severity: string,
  opts: { participantId?: string | null; actorId?: string | null; payload?: unknown } = {},
): void {
  getPool().query(
    `INSERT INTO meeting_events (id, meeting_id, participant_id, actor_id, type, severity, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [snowflake(), meetingId, opts.participantId ?? null, opts.actorId ?? null,
      type, severity, JSON.stringify(opts.payload ?? {})],
  ).catch(soft('event log'));
}

export function setParticipantState(participantId: string, state: string): void {
  getPool().query(
    `UPDATE meeting_participants
        SET state = $2,
            joined_at = COALESCE(joined_at, CASE WHEN $2 = 'active' THEN now() END)
      WHERE id = $1`,
    [participantId, state],
  ).catch(soft('participant state'));
}

/**
 * Close a participant's leg and bank the elapsed time.
 *
 * Additive rather than overwriting, so someone whose wifi dropped and who
 * rejoined shows one attendance with the right total, not two partial ones.
 */
export function closeParticipant(participantId: string, state = 'left'): void {
  getPool().query(
    `UPDATE meeting_participants
        SET state = $2, left_at = now(),
            duration_seconds = duration_seconds + GREATEST(
              EXTRACT(EPOCH FROM (now() - COALESCE(joined_at, now())))::int, 0)
      WHERE id = $1 AND left_at IS NULL`,
    [participantId, state],
  ).catch(soft('close participant'));
}

export function setMediaState(
  participantId: string,
  changes: { audioEnabled?: boolean; videoEnabled?: boolean; screenSharing?: boolean },
): void {
  getPool().query(
    `UPDATE meeting_participants SET
       audio_enabled  = COALESCE($2, audio_enabled),
       video_enabled  = COALESCE($3, video_enabled),
       screen_sharing = COALESCE($4, screen_sharing)
     WHERE id = $1`,
    [participantId, changes.audioEnabled ?? null, changes.videoEnabled ?? null,
      changes.screenSharing ?? null],
  ).catch(soft('media state'));
}

export function setHand(participantId: string, raised: boolean, at: Date | null): void {
  getPool().query('UPDATE meeting_participants SET hand_raised_at = $2 WHERE id = $1',
    [participantId, raised ? at : null]).catch(soft('hand'));
}

export function setRole(participantId: string, role: string): void {
  getPool().query('UPDATE meeting_participants SET role = $2 WHERE id = $1',
    [participantId, role]).catch(soft('role'));
}

export function setSfuSession(participantId: string, sessionId: string): void {
  getPool().query('UPDATE meeting_participants SET sfu_session_id = $2 WHERE id = $1',
    [participantId, sessionId]).catch(soft('sfu session'));
}

export function setQuality(participantId: string, quality: string): void {
  getPool().query('UPDATE meeting_participants SET connection_quality = $2 WHERE id = $1',
    [participantId, quality]).catch(soft('quality'));
}

export function admit(participantId: string, byUserId: string | null): void {
  getPool().query(
    `UPDATE meeting_participants
        SET state = 'active', admitted_at = now(), admitted_by = $2, joined_at = COALESCE(joined_at, now())
      WHERE id = $1`,
    [participantId, byUserId],
  ).catch(soft('admit'));
}

/** Bank speaking seconds for the engagement report. Batched, never per-utterance. */
export function addSpeakingSeconds(rows: Array<{ participantId: string; seconds: number }>): void {
  if (!rows.length) return;
  getPool().query(
    `UPDATE meeting_participants AS p
        SET speaking_seconds = p.speaking_seconds + v.seconds
       FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS seconds) AS v
      WHERE p.id = v.id`,
    [rows.map((r) => r.participantId), rows.map((r) => r.seconds)],
  ).catch(soft('speaking seconds'));
}

export async function insertChat(p: {
  meetingId: string; participantId: string; senderName: string; body: string;
  toParticipantId?: string | null;
}) {
  const id = snowflake();
  const { rows } = await getPool().query<{ created_at: Date }>(
    `INSERT INTO meeting_chat_messages
       (id, meeting_id, participant_id, sender_name, body, to_participant_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING created_at`,
    [id, p.meetingId, p.participantId, p.senderName, p.body, p.toParticipantId ?? null],
  );
  return { id, createdAt: rows[0]!.created_at.toISOString() };
}

export async function insertTranscript(p: {
  meetingId: string; participantId: string; speakerName: string; text: string;
  lang: string; isFinal: boolean; confidence?: number; offsetSeconds: number | null;
}) {
  const id = snowflake();
  const { rows } = await getPool().query<{ started_at: Date }>(
    `INSERT INTO meeting_transcript_segments
       (id, meeting_id, participant_id, speaker_name, text, lang, is_final, confidence, offset_seconds)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING started_at`,
    [id, p.meetingId, p.participantId, p.speakerName, p.text, p.lang, p.isFinal,
      p.confidence ?? null, p.offsetSeconds],
  );
  return { id, startedAt: rows[0]!.started_at.toISOString() };
}

export async function insertPoll(p: {
  meetingId: string; participantId: string; kind: string; question: string;
  options: string[]; correctOptionIndex?: number | null; anonymous: boolean; multipleChoice: boolean;
}) {
  const id = snowflake();
  const { rows } = await getPool().query<{ created_at: Date }>(
    `INSERT INTO meeting_polls
       (id, meeting_id, created_by, kind, question, options, correct_option_index,
        anonymous, multiple_choice)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING created_at`,
    [id, p.meetingId, p.participantId, p.kind, p.question, JSON.stringify(p.options),
      p.correctOptionIndex ?? null, p.anonymous, p.multipleChoice],
  );
  return { id, createdAt: rows[0]!.created_at.toISOString() };
}

/** Upsert, so changing your mind replaces your vote instead of adding one. */
export async function castVote(pollId: string, participantId: string, optionIndexes: number[]) {
  await getPool().query(
    `INSERT INTO meeting_poll_votes (poll_id, participant_id, option_indexes)
     VALUES ($1,$2,$3)
     ON CONFLICT (poll_id, participant_id) DO UPDATE SET option_indexes = EXCLUDED.option_indexes`,
    [pollId, participantId, JSON.stringify(optionIndexes)],
  );
}

export async function pollWithTally(pollId: string, participantId: string) {
  const { rows } = await getPool().query(
    `SELECT p.id, p.meeting_id, p.kind, p.question, p.options, p.correct_option_index,
            p.anonymous, p.multiple_choice, p.status, p.created_at,
            COALESCE((SELECT jsonb_agg(option_indexes) FROM meeting_poll_votes
                       WHERE poll_id = p.id), '[]'::jsonb) AS tally,
            (SELECT option_indexes FROM meeting_poll_votes
              WHERE poll_id = p.id AND participant_id = $2) AS my_vote
       FROM meeting_polls p WHERE p.id = $1`,
    [pollId, participantId],
  );
  return rows[0] ?? null;
}

export async function closePoll(pollId: string) {
  await getPool().query(
    `UPDATE meeting_polls SET status = 'closed', closed_at = now() WHERE id = $1`, [pollId]);
}

export async function insertQuestion(p: {
  meetingId: string; participantId: string; askedBy: string; text: string;
}) {
  const id = snowflake();
  const { rows } = await getPool().query<{ created_at: Date }>(
    `INSERT INTO meeting_questions (id, meeting_id, participant_id, asked_by, text)
     VALUES ($1,$2,$3,$4,$5) RETURNING created_at`,
    [id, p.meetingId, p.participantId, p.askedBy, p.text],
  );
  return { id, createdAt: rows[0]!.created_at.toISOString() };
}

/**
 * Upvote once per participant. The junction table is what enforces it — a
 * counter alone would let anyone hold the key down and win the queue.
 */
export async function upvoteQuestion(questionId: string, participantId: string) {
  const { rowCount } = await getPool().query(
    `INSERT INTO meeting_question_upvotes (question_id, participant_id)
     VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [questionId, participantId],
  );
  if (!rowCount) return null;
  const { rows } = await getPool().query(
    `UPDATE meeting_questions SET upvotes = upvotes + 1 WHERE id = $1
      RETURNING id, meeting_id, participant_id, asked_by, text, upvotes, answered, answer_text, created_at`,
    [questionId],
  );
  return rows[0] ?? null;
}

export async function answerQuestion(questionId: string, answerText: string | null) {
  const { rows } = await getPool().query(
    `UPDATE meeting_questions SET answered = true, answer_text = $2 WHERE id = $1
      RETURNING id, meeting_id, participant_id, asked_by, text, upvotes, answered, answer_text, created_at`,
    [questionId, answerText],
  );
  return rows[0] ?? null;
}

export async function createBreakouts(
  meetingId: string,
  plan: Array<{ name: string; participantIds: string[] }>,
  closesAt: Date | null,
) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Replacing a plan closes the previous rooms rather than layering a second
    // set on top — otherwise a re-plan silently doubles the room list.
    await client.query(
      `UPDATE meeting_breakouts SET status = 'closed', closed_at = now()
        WHERE meeting_id = $1 AND status = 'open'`, [meetingId]);

    const created: Array<{ id: string; name: string; participantIds: string[] }> = [];
    for (const room of plan) {
      const id = snowflake();
      await client.query(
        `INSERT INTO meeting_breakouts (id, meeting_id, name, room_name, closes_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, meetingId, room.name, `tupo-${meetingId}-b${id}`, closesAt],
      );
      if (room.participantIds.length) {
        await client.query(
          `INSERT INTO meeting_breakout_members (breakout_id, participant_id)
           SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
          [id, room.participantIds],
        );
      }
      created.push({ id, name: room.name, participantIds: room.participantIds });
    }
    await client.query('COMMIT');
    return created;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closeBreakouts(meetingId: string) {
  await getPool().query(
    `UPDATE meeting_breakouts SET status = 'closed', closed_at = now()
      WHERE meeting_id = $1 AND status = 'open'`, [meetingId]);
}

export function setMeetingSettings(meetingId: string, settings: unknown): void {
  getPool().query('UPDATE meetings SET settings = $2, updated_at = now() WHERE id = $1',
    [meetingId, JSON.stringify(settings)]).catch(soft('settings'));
}

export function startMeeting(meetingId: string): void {
  getPool().query(
    `UPDATE meetings SET status = 'live', started_at = COALESCE(started_at, now())
      WHERE id = $1 AND status = 'scheduled'`, [meetingId]).catch(soft('start meeting'));
}

export async function endMeeting(meetingId: string) {
  const pool = getPool();
  await pool.query(
    `UPDATE meeting_participants
        SET state = 'left', left_at = now(),
            duration_seconds = duration_seconds + GREATEST(
              EXTRACT(EPOCH FROM (now() - COALESCE(joined_at, now())))::int, 0)
      WHERE meeting_id = $1 AND left_at IS NULL`, [meetingId]);
  await pool.query(
    `UPDATE meetings SET status = 'ended', ended_at = now() WHERE id = $1 AND status <> 'ended'`,
    [meetingId]);
}

export async function countFinalSegments(meetingId: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM meeting_transcript_segments
      WHERE meeting_id = $1 AND is_final = true`, [meetingId]);
  return Number(rows[0]?.count ?? 0);
}
