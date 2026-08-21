-- Cloudflare Realtime SFU: which media session publishes a participant's tracks.
--
-- Cloudflare's SFU has no concept of a room. It is a pub/sub of sessions and
-- tracks, and the application decides how a subscriber finds what to play —
-- which suits Tupo, because tupo-realtime already owns the roster. Track names
-- are derived from the participant id (see `sfuTrackName`), so this session id
-- is the only thing that has to be exchanged: with it, everyone can work out
-- what to subscribe to without another round of signalling.
--
-- Stored rather than kept in memory so someone joining late learns about
-- everybody already publishing, in the same payload that carries the roster.
ALTER TABLE meeting_participants
  ADD COLUMN IF NOT EXISTS sfu_session_id TEXT;
