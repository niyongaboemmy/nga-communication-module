-- A connected mailbox brings in its whole history, not only the last two
-- weeks (docs/MAIL_INBOUND_PLAN_2026-11.md). New mail keeps coming in above
-- `last_uid`; older mail is read downward from `history_next_uid`, a page per
-- sync, newest first, until the start of the mailbox (or MAIL_HISTORY_MAX).
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS history_next_uid BIGINT;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS history_done BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS history_seen INTEGER NOT NULL DEFAULT 0;
-- How many messages the mailbox held when the import began, for "x of y".
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS mailbox_total INTEGER;
