-- Indexes for the cross-module search (/api/search).
--
-- Only the two corpora big enough to matter get a real index. Everything else
-- the palette searches — channel names, page names, meeting titles, filenames,
-- people — is bounded by a school's size (hundreds of rows, not millions), so
-- an ILIKE scan is genuinely cheaper than the write cost of maintaining a
-- trigram index on each. No pg_trgm here for the same reason, and because
-- CREATE EXTENSION needs rights the migration role is not guaranteed to have:
-- a deploy that cannot run is worse than a scan that takes a millisecond.

-- Feed posts, matching the query in routes/search.ts exactly ('english', over
-- coalesce(body, '')) — an expression index is only used when the expression
-- is identical, so these two must be changed together.
CREATE INDEX IF NOT EXISTS feed_posts_body_fts_idx
  ON feed_posts USING GIN (to_tsvector('english', coalesce(body, '')));

-- Mail already has mail_messages_fts_idx from 0015, on the 'simple' config.
-- It has never been used: the mailbox list searches with ILIKE. The global
-- search now queries it with websearch_to_tsquery('simple', …), which matches
-- that index expression, so it finally earns its keep — no new index needed.

-- Supports the "conversations I am in, by name" section, which filters on
-- membership first and then matches the name.
CREATE INDEX IF NOT EXISTS conversation_members_user_active_idx
  ON conversation_members (user_id)
  WHERE left_at IS NULL;
