-- migrate:no-transaction
-- D-11 / FEED-P3: removing or unpublishing a post deletes its timeline rows
-- by post_id, which had no index and scanned every timeline. Built
-- CONCURRENTLY so feeds keep loading while it builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS feed_timeline_post_idx ON feed_timeline (post_id);
