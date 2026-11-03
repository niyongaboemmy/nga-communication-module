-- E-03: attendance is measured in legs. Idempotent.
--
-- duration_seconds used to add "now - joined_at" on every leave, but joined_at
-- is the *first* join, so a rejoin counted the first leg again (10 + 10
-- minutes recorded as ~50). Each leg now has its own start; on leave the leg
-- is banked and also kept as a row, the evidence behind the total.

ALTER TABLE meeting_participants ADD COLUMN IF NOT EXISTS segment_started_at TIMESTAMPTZ;

-- Open legs right now: best estimate is their join time.
UPDATE meeting_participants
   SET segment_started_at = COALESCE(joined_at, now())
 WHERE state = 'active' AND left_at IS NULL AND segment_started_at IS NULL;

CREATE TABLE IF NOT EXISTS meeting_attendance_segments (
  id             BIGSERIAL PRIMARY KEY,
  meeting_id     TEXT        NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id TEXT        NOT NULL REFERENCES meeting_participants(id) ON DELETE CASCADE,
  started_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS meeting_attendance_segments_meeting_idx
  ON meeting_attendance_segments (meeting_id, participant_id);

-- One participant row per signed-in person per meeting (MEET-BUG2). Created
-- only when the data already satisfies it; the API also serialises joins.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM meeting_participants WHERE user_id IS NOT NULL
     GROUP BY meeting_id, user_id HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS meeting_participants_one_per_user
      ON meeting_participants (meeting_id, user_id) WHERE user_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'meeting_participants has duplicate (meeting_id, user_id) rows; unique index skipped';
  END IF;
END $$;
