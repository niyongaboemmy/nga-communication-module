/**
 * Meeting attendance legs (E-03), shared by the API and the realtime gateway.
 *
 * A participant's time is the sum of their legs: a leg opens when they become
 * active (`segment_started_at`) and closes when they leave, banking the elapsed
 * time into `duration_seconds` and keeping the leg as a row in
 * `meeting_attendance_segments`.
 */
import type { Pool, PoolClient } from 'pg';

/** SQL fragment for an UPDATE that makes a participant active: opens a leg if none is open. */
export const OPEN_ATTENDANCE_LEG = 'segment_started_at = COALESCE(segment_started_at, now())';

/**
 * Close the open legs of one participant, or of everyone in a meeting, setting
 * their state (left, removed, denied…). Rows with no open leg are only marked.
 */
export async function closeAttendanceLegs(
  db: Pool | PoolClient,
  target: { participantId: string } | { meetingId: string },
  state = 'left',
): Promise<void> {
  const [where, id] = 'participantId' in target
    ? ['p.id = $1', target.participantId]
    : ['p.meeting_id = $1', target.meetingId];
  await db.query(
    `WITH closed AS (
       UPDATE meeting_participants p
          SET state = $2, left_at = now(),
              duration_seconds = p.duration_seconds
                + COALESCE(GREATEST(EXTRACT(EPOCH FROM (now() - o.segment_started_at))::int, 0), 0),
              segment_started_at = NULL
         FROM meeting_participants o
        WHERE o.id = p.id AND ${where} AND p.left_at IS NULL
       RETURNING p.id, p.meeting_id, o.segment_started_at AS started
     )
     INSERT INTO meeting_attendance_segments (meeting_id, participant_id, started_at, ended_at)
     SELECT meeting_id, id, started, now() FROM closed WHERE started IS NOT NULL`,
    [id, state],
  );
}
