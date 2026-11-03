-- E-04: a meeting's wrap-up (minutes, chapters, action items) runs exactly
-- once, however the meeting ended — the host's End button, the REST call, the
-- auto-close sweep. Whoever first sets this column enqueues the job. Idempotent.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS wrapup_queued_at TIMESTAMPTZ;

-- Meetings that ended before this existed have had their chance.
UPDATE meetings SET wrapup_queued_at = COALESCE(ended_at, now())
 WHERE status IN ('ended', 'cancelled') AND wrapup_queued_at IS NULL;
