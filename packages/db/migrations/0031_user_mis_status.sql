-- The person's account status in NGA MIS (User.status: ACTIVE | INACTIVE |
-- SUSPENDED, or REMOVED when MIS no longer knows the id). MIS is the source of
-- truth for who is active; this is Tupo's local copy so every list of people
-- (pickers, search, recipients, fan-out, dashboard counts) can drop inactive
-- people without a call to MIS. NULL = not synced yet, which counts as active.
--
-- Kept current by the SSO exchange, the worker's avatars:sync sweep (the MIS
-- profile-media lookup carries status) and a re-check on back-channel logout.
-- The one rule lives in packages/db/src/activeUsers.ts. Idempotent.

ALTER TABLE users ADD COLUMN IF NOT EXISTS mis_status TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mis_status_synced_at TIMESTAMPTZ;

