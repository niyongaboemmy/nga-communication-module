-- Keep what a deleted message said — for oversight, and only for oversight.
--
-- Deleting a message clears `body` and `attachments` so the tombstone that
-- stays behind carries nothing (see chat.deleteMessage). That is the right
-- default for every ordinary reader. But Tupo is a school's communication
-- tool, and a message deleted a second after it was sent is exactly the one a
-- safeguarding review needs to be able to read.
--
-- So the delete now *moves* the content into these two columns rather than
-- destroying it. They are never selected by any ordinary message read — only
-- the oversight path (OVERSIGHT_VIEW_ALL) reads them, and every such read is
-- audit-logged. A disappearing message that is swept for retention is still
-- hard-DELETEd, row and all, so this is not a way to keep expired content.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deleted_body        TEXT,
  ADD COLUMN IF NOT EXISTS deleted_attachments JSONB;
