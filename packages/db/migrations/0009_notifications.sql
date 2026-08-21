-- Notifications
--
-- Tupo had no notification store: the socket layer could tell you about things
-- happening in a room you were already in, and nothing could tell you about
-- something that started while you were reading your mail. A meeting you are
-- allowed to join is exactly that case — it is worth knowing about at the
-- moment it starts, not the next time you happen to open Meet.
--
-- Deliberately generic. `kind` and `link` mean the feed, mail and chat modules
-- can use the same table rather than each growing their own.

CREATE TABLE IF NOT EXISTS notifications (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT,
  -- Where clicking it goes. An in-app path, never an absolute URL: this is
  -- rendered as a link and must not become an open-redirect.
  link          TEXT,
  -- The thing it is about, so a notification can be revoked when its subject
  -- goes away (a meeting that ends should not keep inviting people in).
  subject_type  TEXT,
  subject_id    TEXT,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only read path that matters: this user's unread, newest first.
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS notifications_user_recent_idx
  ON notifications (user_id, created_at DESC);

-- Used to revoke every notification about a subject at once.
CREATE INDEX IF NOT EXISTS notifications_subject_idx
  ON notifications (subject_type, subject_id);

-- One notification per person per subject per kind. A meeting that is started,
-- ended and restarted should not stack up three "join now" rows.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_unique_subject_idx
  ON notifications (user_id, kind, subject_type, subject_id)
  WHERE subject_id IS NOT NULL;
