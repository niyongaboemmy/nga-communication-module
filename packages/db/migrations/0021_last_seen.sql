-- When someone was last connected.
--
-- Presence itself stays in Redis: it is a live, per-second fact with a TTL, and
-- putting it in Postgres would mean a write on every heartbeat from every
-- signed-in person in the school. "Last seen" is the opposite — written rarely,
-- read whenever a dot is grey, and worthless if it does not survive a restart
-- of the gateway or of Redis. So it lives here, with Redis in front of it as a
-- cache (see lastSeenKey in @tupo/shared).
--
-- Distinct from `last_login_at`, which records the SSO exchange and therefore
-- does not move for someone who has stayed signed in for a fortnight.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
