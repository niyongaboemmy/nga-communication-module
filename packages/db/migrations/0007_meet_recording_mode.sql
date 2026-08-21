-- Recordings: where they were produced, and how large the result is.
--
-- `mode` matters because the two paths have genuinely different guarantees.
-- A server recording is composited by the media server and does not depend on
-- anyone's laptop; a client recording is made by the host's browser and stops
-- if they leave. Anyone reading a recording back needs to know which they have.
ALTER TABLE meeting_recordings
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'server';

ALTER TABLE meeting_recordings
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT;

-- Every recording for a meeting lands under one prefix in the file store, so a
-- meeting's media can be listed, exported or purged as a unit.
ALTER TABLE meeting_recordings
  ADD COLUMN IF NOT EXISTS folder TEXT;

CREATE INDEX IF NOT EXISTS meeting_recordings_status_idx
  ON meeting_recordings (meeting_id, status);
