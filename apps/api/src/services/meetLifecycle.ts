import { getPool } from '@tupo/db';
import type { SessionClaims } from '@tupo/shared';
import * as notifications from '@tupo/notify';
import { reminders } from '@tupo/notify';
import * as meet from './meetService.js';
import { enqueueMeetWrapUp } from './queue.js';
import { publishMeetEnded } from './chatRealtime.js';

/**
 * Ending a meeting, one way for every path (E-04): the host's End button, the
 * REST call from the pre-join page, and the auto-close sweep.
 *
 *  - the attendance legs and the meeting row close (idempotent);
 *  - everyone still connected is told and dropped, on every gateway node —
 *    ending from outside the room used to leave people sitting in it;
 *  - the wrap-up job is claimed exactly once (`wrapup_queued_at`).
 */
export async function endMeetingEverywhere(meetingId: string, actorId: string | null): Promise<{ wrapUpQueued: boolean }> {
  await meet.endMeeting(meetingId, actorId ?? 'system');
  void notifications.revokeSubject('meeting', meetingId).catch(() => {});
  reminders.queueMeetingReminderCancel(meetingId);
  publishMeetEnded(meetingId, actorId);
  return { wrapUpQueued: await claimWrapUp(meetingId) };
}

/** Enqueue the wrap-up if nobody has yet, as the meeting's host. */
export async function claimWrapUp(meetingId: string): Promise<boolean> {
  const { rows } = await getPool().query<{
    id: string; mis_user_id: string; name: string; email: string; role: string; avatar_url: string | null;
  }>(
    `WITH claimed AS (
       UPDATE meetings SET wrapup_queued_at = now()
        WHERE id = $1 AND wrapup_queued_at IS NULL AND started_at IS NOT NULL
        RETURNING host_id
     )
     SELECT u.id, u.mis_user_id, u.name, u.email, u.role, u.avatar_url
       FROM claimed c JOIN users u ON u.id = c.host_id`,
    [meetingId],
  );
  const host = rows[0];
  if (!host) return false;
  const claims = {
    id: host.id, misUserId: host.mis_user_id, name: host.name, email: host.email,
    role: host.role, avatarUrl: host.avatar_url,
  } as SessionClaims;
  const queued = await enqueueMeetWrapUp(meetingId, claims);
  // Could not queue (Redis down): release the claim so the sweep retries.
  if (!queued) await getPool().query('UPDATE meetings SET wrapup_queued_at = NULL WHERE id = $1', [meetingId]);
  return queued;
}

/** How long an empty live meeting stays open, and the hard cap on any meeting. */
export const EMPTY_CLOSE_MINUTES = 10;
export const MAX_LIVE_HOURS = 12;

/**
 * The auto-close sweep (MEET-RT2), once a minute from the API process; an
 * advisory lock keeps it to one runner across instances.
 *
 *  - a live meeting nobody has been in for 10 minutes is ended (and wrapped up);
 *  - any meeting live for 12 hours is ended — a ghost left by a crash;
 *  - a one-off scheduled meeting that never started is closed an hour after
 *    its slot, so it stops sitting in "upcoming";
 *  - an ended meeting whose wrap-up was never queued (its End request died)
 *    gets it now.
 */
export async function sweepMeetings(): Promise<{ ended: string[]; expired: number; wrapped: number }> {
  const client = await getPool().connect();
  try {
    const { rows: lock } = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('tupo:meet-sweep')) AS ok`);
    if (!lock[0]?.ok) return { ended: [], expired: 0, wrapped: 0 };
    try {
      const { rows: idle } = await client.query<{ id: string }>(
        `SELECT m.id FROM meetings m
          WHERE m.status = 'live'
            AND (m.started_at < now() - make_interval(hours => $2)
                 OR (NOT EXISTS (SELECT 1 FROM meeting_participants p
                                  WHERE p.meeting_id = m.id
                                    AND p.state IN ('active', 'connecting', 'reconnecting', 'knocking', 'lobby'))
                     AND COALESCE((SELECT max(p.left_at) FROM meeting_participants p WHERE p.meeting_id = m.id),
                                  m.started_at, m.created_at) < now() - make_interval(mins => $1)))
          LIMIT 50`,
        [EMPTY_CLOSE_MINUTES, MAX_LIVE_HOURS],
      );
      const ended: string[] = [];
      for (const { id } of idle) {
        try { await endMeetingEverywhere(id, null); ended.push(id); }
        catch (e) { console.error(`[meet] auto-close ${id} failed:`, e); }
      }

      const { rowCount: expired } = await client.query(
        `UPDATE meetings SET status = 'ended', ended_at = now(), updated_at = now()
          WHERE status = 'scheduled' AND started_at IS NULL AND recurrence_rule IS NULL
            AND COALESCE(scheduled_end, scheduled_start + interval '2 hours') < now() - interval '1 hour'`,
      );

      const { rows: unwrapped } = await client.query<{ id: string }>(
        `SELECT id FROM meetings
          WHERE status = 'ended' AND started_at IS NOT NULL AND wrapup_queued_at IS NULL
            AND ended_at BETWEEN now() - interval '1 day' AND now() - interval '2 minutes'
          LIMIT 20`,
      );
      let wrapped = 0;
      for (const { id } of unwrapped) if (await claimWrapUp(id).catch(() => false)) wrapped++;
      return { ended, expired: expired ?? 0, wrapped };
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('tupo:meet-sweep'))`).catch(() => {});
    }
  } finally {
    client.release();
  }
}

export function startMeetSweep(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void sweepMeetings()
      .then((r) => { if (r.ended.length || r.expired || r.wrapped) console.log('[meet] sweep:', JSON.stringify(r)); })
      .catch((e) => console.error('[meet] sweep failed:', e instanceof Error ? e.message : e));
  }, 60_000);
  timer.unref();
  return timer;
}
