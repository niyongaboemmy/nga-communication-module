-- Inline translation (FR-MSG-25).
--
-- Cached per message per language. A class channel where one message is read
-- by forty people must not be forty model calls, and a translation of a message
-- that has not changed is the same translation every time.

CREATE TABLE IF NOT EXISTS message_translations (
  message_id   TEXT        NOT NULL,
  language     TEXT        NOT NULL,
  translated   TEXT        NOT NULL,
  -- The body it was made from. An edited message must not keep serving a
  -- translation of what it used to say.
  source_hash  TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, language)
);
