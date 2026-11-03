-- Snooze (U-10): a conversation leaves the Inbox for the 'snoozed' folder
-- until snoozed_until, when the mail sweep puts it back, unread. Reusing the
-- folder column keeps every mailbox query as it is.
ALTER TABLE mail_recipients ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS mail_recipients_snoozed_idx
  ON mail_recipients (snoozed_until) WHERE folder = 'snoozed';
