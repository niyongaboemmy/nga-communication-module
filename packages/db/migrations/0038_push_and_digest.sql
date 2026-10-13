-- F-04: web push and the email digest. Idempotent.

-- One row per browser/device a person allowed notifications on.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        TEXT        NOT NULL UNIQUE,
  p256dh          TEXT        NOT NULL,
  auth            TEXT        NOT NULL,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  failures        INTEGER     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);

-- A notification goes into at most one digest email.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS notifications_digest_idx
  ON notifications (created_at) WHERE read_at IS NULL AND emailed_at IS NULL;

-- Opt-out for the digest (on by default: it is what reaches someone who has
-- not opened the app in hours).
ALTER TABLE user_chat_prefs ADD COLUMN IF NOT EXISTS email_digest BOOLEAN NOT NULL DEFAULT true;
