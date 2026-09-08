-- A real uploaded logo for a group or channel.
--
-- `avatar_color` + `icon_emoji` (0010_chat.sql) already give a conversation a
-- cheap identity, but a school's channels are the same handful of emoji over
-- and over — a class needs its own picture the way a page does (0017_feed.sql
-- gives feed_pages the same column, for the same reason).
--
-- ON DELETE SET NULL rather than CASCADE: a deleted file should cost the
-- channel its picture, never the channel itself.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS avatar_file_id TEXT REFERENCES files(id) ON DELETE SET NULL;

-- The files service resolves "may this person see this conversation's logo?"
-- by looking the id up here (see apps/files/src/access.ts), so it is read once
-- per avatar render for every member of the conversation.
CREATE INDEX IF NOT EXISTS conversations_avatar_file_idx
  ON conversations (avatar_file_id)
  WHERE avatar_file_id IS NOT NULL;
