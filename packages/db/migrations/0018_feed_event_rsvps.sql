-- Feed event RSVPs (FR-FEED-2, event posts).
--
-- A "going" marker on an event post. Kept in its own table rather than folded
-- into reactions so the counts never entangle: reacting 🎉 to an event is not
-- the same as saying you will be there.

CREATE TABLE IF NOT EXISTS feed_event_rsvps (
  post_id    TEXT        NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT        NOT NULL DEFAULT 'going',   -- going | interested
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS feed_event_rsvps_post_idx ON feed_event_rsvps (post_id, status);
