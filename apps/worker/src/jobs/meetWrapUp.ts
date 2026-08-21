import { getPool } from '@tupo/db';
import { parseMeetSettings } from '@tupo/shared';

/**
 * Post-meeting wrap-up.
 *
 * Runs once when a meeting ends, and does the work that is too slow to do while
 * people are waiting to leave: closing any participant leg the gateway missed,
 * then generating the minutes, action items, chapters and — for a lesson — the
 * follow-up material.
 *
 * The generation itself is delegated to the API rather than duplicated here.
 * The prompts, the schemas and the four-provider fallback chain all live in
 * `apps/api/src/services/meetAiService.ts`; a second copy in the worker would
 * drift from the first within a month. The worker calls the API's own endpoints
 * with a service token, so there is exactly one implementation of "generate the
 * minutes" in the system.
 */

export interface MeetWrapUpData {
  meetingId: string;
  /** The host, on whose authority the AI artifacts are generated. */
  actorId: string;
  /** A short-lived session token for that host, minted by the API on end. */
  token: string;
  apiBaseUrl?: string;
}

const API_BASE = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:5190';

interface ArtifactOutcome { kind: string; ok: boolean; providerUsed?: string; error?: string }

async function generate(
  base: string, token: string, meetingId: string, kind: string, path: string,
): Promise<ArtifactOutcome> {
  try {
    const res = await fetch(`${base}/api/meet/${meetingId}/ai/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = await res.json().catch(() => ({})) as {
      success?: boolean; message?: string; data?: { providerUsed?: string };
    };
    if (!res.ok || body.success === false) {
      return { kind, ok: false, error: body.message ?? `HTTP ${res.status}` };
    }
    return { kind, ok: true, providerUsed: body.data?.providerUsed };
  } catch (err) {
    return { kind, ok: false, error: err instanceof Error ? err.message : 'request failed' };
  }
}

export async function runMeetWrapUp(data: MeetWrapUpData) {
  const { meetingId, token } = data;
  const base = data.apiBaseUrl ?? API_BASE;
  const pool = getPool();

  /* 1. Close the books. The gateway closes each leg as its socket goes, but a
   *    gateway that crashed leaves rows open, and an attendance export with a
   *    NULL left_at is a row nobody can interpret. */
  await pool.query(
    `UPDATE meeting_participants
        SET state = 'left', left_at = now(),
            duration_seconds = duration_seconds + GREATEST(
              EXTRACT(EPOCH FROM (now() - COALESCE(joined_at, now())))::int, 0)
      WHERE meeting_id = $1 AND left_at IS NULL`,
    [meetingId],
  );
  await pool.query(
    `UPDATE meetings SET status = 'ended', ended_at = COALESCE(ended_at, now()) WHERE id = $1`,
    [meetingId],
  );

  /* 2. Decide what to generate. */
  const { rows } = await pool.query<{ settings: unknown; title: string }>(
    'SELECT settings, title FROM meetings WHERE id = $1', [meetingId]);
  if (!rows[0]) return { skipped: 'meeting not found' };

  const settings = parseMeetSettings(rows[0].settings);
  if (!settings.aiAssistantEnabled) return { skipped: 'AI not enabled for this meeting' };

  const { rows: seg } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM meeting_transcript_segments
      WHERE meeting_id = $1 AND is_final = true`, [meetingId]);
  // A meeting with almost no transcript produces a summary of nothing, which is
  // worse than no summary — it reads as authoritative and says nothing true.
  if (Number(seg[0]?.count ?? 0) < 5) return { skipped: 'not enough transcript' };

  /* 3. Generate. Sequentially and deliberately: four parallel requests to the
   *    same provider is the fastest way to trip a rate limit and have every one
   *    of them fall through to the slowest provider in the chain. */
  const outcomes: ArtifactOutcome[] = [];

  if (settings.aiPostMeetingMinutes) {
    outcomes.push(await generate(base, token, meetingId, 'minutes', 'minutes'));
    outcomes.push(await generate(base, token, meetingId, 'chapters', 'chapters'));
  }
  if (settings.aiActionItems) {
    outcomes.push(await generate(base, token, meetingId, 'action_items', 'action-items'));
    outcomes.push(await generate(base, token, meetingId, 'decisions', 'decisions'));
  }
  if (settings.aiEngagementReport) {
    outcomes.push(await generate(base, token, meetingId, 'engagement', 'engagement'));
  }
  if (settings.aiLessonFollowUp) {
    outcomes.push(await generate(base, token, meetingId, 'lesson_followup', 'lesson-followup'));
  }

  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length) {
    console.warn(`[worker] meet wrap-up ${meetingId}: ${failed.length}/${outcomes.length} artifacts failed —`,
      failed.map((f) => `${f.kind}: ${f.error}`).join('; '));
  }

  return {
    meetingId,
    generated: outcomes.filter((o) => o.ok).map((o) => o.kind),
    failed: failed.map((f) => ({ kind: f.kind, error: f.error })),
  };
}
