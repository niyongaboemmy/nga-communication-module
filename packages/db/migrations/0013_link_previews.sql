-- Link unfurling (FR-MSG-22).
--
-- Previews are cached by URL rather than fetched per message: a timetable link
-- pasted into six channels is one fetch, and re-rendering a year of history
-- must not re-hit anybody's server.

CREATE TABLE IF NOT EXISTS link_previews (
  -- SHA-256 of the normalised URL. The URL itself can exceed any sane index
  -- key length, and a hash is a stable primary key that cannot.
  url_hash     TEXT PRIMARY KEY,
  url          TEXT        NOT NULL,
  title        TEXT,
  description  TEXT,
  image_url    TEXT,
  site_name    TEXT,
  -- 'ok' | 'blocked' | 'failed'. A refusal is cached too: an internal address
  -- someone pasted must not be re-resolved every time the message renders.
  status       TEXT        NOT NULL DEFAULT 'ok',
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The refresh sweep: anything older than the TTL is refetched on next use.
CREATE INDEX IF NOT EXISTS link_previews_fetched_idx ON link_previews (fetched_at);

-- Which messages carry which links, so a preview arriving late can be pushed
-- to whoever has the conversation open.
CREATE TABLE IF NOT EXISTS message_links (
  message_id      TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  url_hash        TEXT NOT NULL,
  ordinal         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, url_hash)
);
CREATE INDEX IF NOT EXISTS message_links_conv_idx ON message_links (conversation_id);
