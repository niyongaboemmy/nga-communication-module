-- The wide profile cover chosen in NGA MIS (nga_central_mis migration 118), next to
-- avatar_url. NULL = none: the profile card shows the system blue. Kept current by
-- sign-in, the /verify-mis poll and the worker's avatars:sync job. Idempotent.

ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_url TEXT;
