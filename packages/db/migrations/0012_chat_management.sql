-- Chat management: custom status, and the columns channel administration needs.
--
-- Idempotent, like every migration here.

/* ──────────────────────────────────────────────────────────────────────────
 * Custom status  (FR-USR-4)
 * ────────────────────────────────────────────────────────────────────────── */

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS status_emoji     TEXT,
  ADD COLUMN IF NOT EXISTS status_text      TEXT,
  -- "Back at 14:00" is only useful if it stops being true at 14:00. A status
  -- with no expiry is the one people set once and forget for a year, and it
  -- then actively misinforms everyone who reads it.
  ADD COLUMN IF NOT EXISTS status_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pronouns          TEXT,
  ADD COLUMN IF NOT EXISTS title             TEXT,
  ADD COLUMN IF NOT EXISTS timezone          TEXT;

-- The sweep that clears expired ones.
CREATE INDEX IF NOT EXISTS users_status_expiry_idx
  ON users (status_expires_at) WHERE status_expires_at IS NOT NULL;

/* ──────────────────────────────────────────────────────────────────────────
 * Channel discovery
 * ────────────────────────────────────────────────────────────────────────── */

-- Browsing public channels is a scan of "public, not archived, in my space",
-- ordered by how busy they are. Without this it is a sequential scan of every
-- conversation in the institution each time someone opens the directory.
CREATE INDEX IF NOT EXISTS conversations_discoverable_idx
  ON conversations (space_id, member_count DESC)
  WHERE type IN ('channel', 'announcement')
    AND is_private = false
    AND is_archived = false
    AND deleted_at IS NULL;

-- Name search in the same directory.
CREATE INDEX IF NOT EXISTS conversations_name_trgm_idx
  ON conversations (space_id, lower(name))
  WHERE deleted_at IS NULL;

/* ──────────────────────────────────────────────────────────────────────────
 * Disappearing messages  (FR-MSG-19)
 * ────────────────────────────────────────────────────────────────────────── */

-- `conversations.retention_days` and `messages.expires_at` already exist from
-- 0010. What was missing is a record of *who* set the policy and when, which a
-- school needs to be able to answer: "this conversation deletes itself after a
-- week" is a decision somebody made, not a property of the universe.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS retention_set_by TEXT,
  ADD COLUMN IF NOT EXISTS retention_set_at TIMESTAMPTZ;
