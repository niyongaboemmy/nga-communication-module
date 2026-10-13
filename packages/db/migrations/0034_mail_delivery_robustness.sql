-- C-06: mail delivery robustness. Idempotent.
--
-- * SMTP recipient rows are claimed atomically (claimed_at) and retried on a
--   backoff (next_attempt_at); a row left in 'sending' by a crashed worker is
--   reclaimed once its claim is stale.
-- * A campaign run holds a lease, so overlapping sweeps never run it twice and
--   a run that died mid-way is resumed.
-- * The recipient list is frozen when the campaign is submitted, so what the
--   approver reviewed is exactly who receives it.

ALTER TABLE mail_recipients ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE mail_recipients ADD COLUMN IF NOT EXISTS claimed_at      TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS mail_recipients_smtp_due_idx
  ON mail_recipients (message_id, next_attempt_at)
  WHERE channel = 'smtp' AND delivery_status IN ('queued', 'failed', 'sending');

ALTER TABLE mail_campaigns ADD COLUMN IF NOT EXISTS lease_until        TIMESTAMPTZ;
ALTER TABLE mail_campaigns ADD COLUMN IF NOT EXISTS recipient_snapshot JSONB;
