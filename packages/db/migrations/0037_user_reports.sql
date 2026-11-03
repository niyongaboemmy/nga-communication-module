-- B-05: reporting people and messages (FR-USR-7). Blocking already has its
-- table (user_blocks, 0010); this adds the reports moderators work through.
-- Idempotent.
CREATE TABLE IF NOT EXISTS user_reports (
  id               TEXT PRIMARY KEY,
  reporter_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id TEXT        REFERENCES users(id) ON DELETE SET NULL,
  conversation_id  TEXT,
  message_id       TEXT,
  -- What the message said when it was reported, so a later edit or delete
  -- cannot erase the evidence a moderator needs.
  message_excerpt  TEXT,
  reason           TEXT        NOT NULL,   -- harassment | spam | inappropriate | safety | other
  details          TEXT,
  status           TEXT        NOT NULL DEFAULT 'open',   -- open | resolved | dismissed
  resolved_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
  resolution_note  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS user_reports_status_idx ON user_reports (status, created_at DESC);
-- One open report per reporter per target: a second tap is not a second report.
CREATE UNIQUE INDEX IF NOT EXISTS user_reports_one_open_idx
  ON user_reports (reporter_id, COALESCE(message_id, ''), COALESCE(reported_user_id, ''))
  WHERE status = 'open';
