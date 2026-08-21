-- Chat.
--
-- Phase 0 laid down `conversations`, `conversation_members` and a partitioned
-- `messages` table and stopped there — enough to prove the shape, nothing that
-- could carry a product. This migration adds everything the chat module needs:
-- threads, reactions, receipts, mentions, saves, edit history, attachments,
-- scheduling, polls, invites, contact policy and per-user preferences.
--
-- Idempotent throughout, like every migration here.
--
-- ── A note on foreign keys to `messages` ────────────────────────────────────
-- `messages` is RANGE-partitioned on created_at, so its primary key must
-- include the partition key: (conversation_id, seq, created_at). PostgreSQL
-- will not let a child table reference a partitioned parent on a subset of that
-- key, and dragging created_at into every child row purely to satisfy a
-- constraint would be a worse table for a constraint we can enforce in one
-- place. Child tables therefore carry `message_id` as a plain TEXT column, with
-- `conversation_id` alongside it so a conversation's rows can be swept in one
-- statement and so every read is already scoped to something we authorise.
-- Cleanup on message deletion is done by the delete path in chatService, which
-- is the only thing that deletes a message.

/* ──────────────────────────────────────────────────────────────────────────
 * Existing tables — new columns
 * ────────────────────────────────────────────────────────────────────────── */

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS description          TEXT,
  ADD COLUMN IF NOT EXISTS purpose              TEXT,
  ADD COLUMN IF NOT EXISTS avatar_color         TEXT,
  ADD COLUMN IF NOT EXISTS icon_emoji           TEXT,
  ADD COLUMN IF NOT EXISTS retention_days       INTEGER,
  -- Denormalised so the sidebar renders from one query instead of a
  -- lateral join per conversation. Written on every send; authoritative
  -- history stays in `messages`.
  ADD COLUMN IF NOT EXISTS last_message_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_message_preview TEXT,
  ADD COLUMN IF NOT EXISTS last_message_sender  TEXT,
  ADD COLUMN IF NOT EXISTS archived_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by          TEXT;

ALTER TABLE conversation_members
  ADD COLUMN IF NOT EXISTS is_starred       BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS unread_mentions  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS muted_until      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_read_at     TIMESTAMPTZ,
  -- Drafts live server-side so they follow you between phone and laptop
  -- (FR-MSG-17). A draft is not history; it is overwritten, never appended.
  ADD COLUMN IF NOT EXISTS draft            TEXT,
  ADD COLUMN IF NOT EXISTS draft_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_hidden        BOOLEAN     NOT NULL DEFAULT false;

ALTER TABLE messages
  -- The thread axis. NULL means the message is in the main channel flow;
  -- otherwise it points at the message that anchors the thread.
  ADD COLUMN IF NOT EXISTS thread_root_id  TEXT,
  ADD COLUMN IF NOT EXISTS reply_count     INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS thread_last_at  TIMESTAMPTZ,
  -- Quote-reply is a different thing from a thread: it points at one message
  -- and renders a quote block, without creating a sub-conversation.
  ADD COLUMN IF NOT EXISTS reply_to_id     TEXT,
  ADD COLUMN IF NOT EXISTS pinned_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pinned_by       TEXT,
  ADD COLUMN IF NOT EXISTS edited_count    INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deleted_by      TEXT,
  -- Forwarding keeps attribution (FR-MSG-10): who wrote it originally and
  -- where, so a forwarded message can never be passed off as your own.
  ADD COLUMN IF NOT EXISTS forwarded_from  JSONB,
  ADD COLUMN IF NOT EXISTS metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Attachments are denormalised onto the row for the read path; the
  -- message_attachments table stays authoritative for writes and joins.
  ADD COLUMN IF NOT EXISTS attachments     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS expires_at      TIMESTAMPTZ;

/* The scrollback query: newest-first within a conversation. Everything else
 * about reading a channel is a variation on this one index. */
CREATE INDEX IF NOT EXISTS messages_conv_seq_idx
  ON messages (conversation_id, seq DESC);

CREATE INDEX IF NOT EXISTS messages_thread_idx
  ON messages (thread_root_id, seq) WHERE thread_root_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_pinned_idx
  ON messages (conversation_id, pinned_at DESC) WHERE pinned_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_sender_idx
  ON messages (sender_id, created_at DESC);

/* Full-text search (FR-SRCH). An expression index rather than a stored tsvector
 * column: the body is short, the index is cheap to maintain, and it keeps the
 * table free of a generated column that would have to be kept in step. */
CREATE INDEX IF NOT EXISTS messages_body_fts_idx
  ON messages USING GIN (to_tsvector('english', coalesce(body, '')));

/* Retention / disappearing messages sweep. */
CREATE INDEX IF NOT EXISTS messages_expires_idx
  ON messages (expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS conversations_recent_idx
  ON conversations (space_id, last_message_at DESC NULLS LAST);

/* ──────────────────────────────────────────────────────────────────────────
 * Reactions
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id      TEXT        NOT NULL,
  conversation_id TEXT        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji           TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One person, one of each emoji, per message. Clicking again removes it.
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS message_reactions_message_idx ON message_reactions (message_id);
CREATE INDEX IF NOT EXISTS message_reactions_conv_idx    ON message_reactions (conversation_id);

/* ──────────────────────────────────────────────────────────────────────────
 * Delivery receipts  (FR-MSG-13)
 * ────────────────────────────────────────────────────────────────────────── */

-- Only two states are stored: 'delivered' and 'read'. 'sent' is implied by the
-- row existing in `messages` at all, and storing it would mean writing one row
-- per recipient per message for information nobody reads.
CREATE TABLE IF NOT EXISTS message_receipts (
  message_id      TEXT        NOT NULL,
  conversation_id TEXT        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state           TEXT        NOT NULL,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS message_receipts_conv_user_idx
  ON message_receipts (conversation_id, user_id);

/* ──────────────────────────────────────────────────────────────────────────
 * Mentions  (FR-MSG-4)
 * ────────────────────────────────────────────────────────────────────────── */

-- Materialised at send time rather than parsed at read time: the unread-mention
-- count on the sidebar has to be a cheap number, and a notification rule has to
-- be able to ask "was I mentioned" without re-parsing message bodies.
CREATE TABLE IF NOT EXISTS message_mentions (
  message_id      TEXT        NOT NULL,
  conversation_id TEXT        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'user' | 'channel' | 'here'  — kept so "@channel me" can be reported on and
  -- rate-limited separately from a direct @mention.
  kind            TEXT        NOT NULL DEFAULT 'user',
  seq             BIGINT      NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS message_mentions_user_idx
  ON message_mentions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS message_mentions_conv_user_idx
  ON message_mentions (conversation_id, user_id, seq);

/* ──────────────────────────────────────────────────────────────────────────
 * Saved items  (FR-MSG-12)
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS message_saves (
  user_id         TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id      TEXT        NOT NULL,
  conversation_id TEXT        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS message_saves_user_idx ON message_saves (user_id, created_at DESC);

/* ──────────────────────────────────────────────────────────────────────────
 * Edit history  (FR-MSG-8)
 * ────────────────────────────────────────────────────────────────────────── */

-- The *previous* body is archived on each edit, so the chain plus the current
-- row reconstructs every version. Required for moderation: "what did it say
-- before they edited it" is a question a school will be asked.
CREATE TABLE IF NOT EXISTS message_edits (
  id           TEXT PRIMARY KEY,
  message_id   TEXT        NOT NULL,
  editor_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  previous_body TEXT,
  edited_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_edits_message_idx ON message_edits (message_id, edited_at DESC);

/* ──────────────────────────────────────────────────────────────────────────
 * Attachments  (FR-FILE)
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS message_attachments (
  message_id      TEXT        NOT NULL,
  file_id         TEXT        NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  conversation_id TEXT        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ordinal         INTEGER     NOT NULL DEFAULT 0,
  kind            TEXT        NOT NULL DEFAULT 'file',
  meta            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, file_id)
);
-- The files service authorises a download by asking "is this file attached to a
-- conversation the caller belongs to". That question is this index.
CREATE INDEX IF NOT EXISTS message_attachments_file_idx ON message_attachments (file_id);
CREATE INDEX IF NOT EXISTS message_attachments_conv_idx
  ON message_attachments (conversation_id, created_at DESC);

/* ──────────────────────────────────────────────────────────────────────────
 * Scheduled messages  (FR-MSG-18)
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT        NOT NULL,
  attachments     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  thread_root_id  TEXT,
  send_at         TIMESTAMPTZ NOT NULL,
  -- 'pending' | 'sent' | 'cancelled' | 'failed'
  state           TEXT        NOT NULL DEFAULT 'pending',
  sent_message_id TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The worker's only query: what is due now.
CREATE INDEX IF NOT EXISTS scheduled_messages_due_idx
  ON scheduled_messages (send_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS scheduled_messages_sender_idx
  ON scheduled_messages (sender_id, send_at);

/* ──────────────────────────────────────────────────────────────────────────
 * Polls  (FR-MSG-21)
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS polls (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      TEXT        NOT NULL,
  created_by      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question        TEXT        NOT NULL,
  -- [{ id, text }] — kept as JSON because options are never queried
  -- individually, only rendered as a set.
  options         JSONB       NOT NULL,
  multi_choice    BOOLEAN     NOT NULL DEFAULT false,
  anonymous       BOOLEAN     NOT NULL DEFAULT false,
  closes_at       TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS polls_message_idx ON polls (message_id);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id    TEXT        NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id  TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, user_id, option_id)
);

/* ──────────────────────────────────────────────────────────────────────────
 * Invite links  (FR-CHN-6)
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS conversation_invites (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  code            TEXT        NOT NULL,
  created_by      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at      TIMESTAMPTZ,
  max_uses        INTEGER,
  uses            INTEGER     NOT NULL DEFAULT 0,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_invites_code_idx ON conversation_invites (code);

/* ──────────────────────────────────────────────────────────────────────────
 * Contact policy  (FR-USR-6)
 * ────────────────────────────────────────────────────────────────────────── */

-- Who may open a DM with whom, by role. Absence of a row means "not allowed":
-- a school platform fails closed on contact, because the cost of a wrong
-- permissive default is a safeguarding incident, not an inconvenience.
CREATE TABLE IF NOT EXISTS contact_policies (
  id         TEXT PRIMARY KEY,
  from_role  TEXT    NOT NULL,
  to_role    TEXT    NOT NULL,
  allow      BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS contact_policies_pair_idx
  ON contact_policies (lower(from_role), lower(to_role));

-- Blocking (FR-USR-7).
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);

/* ──────────────────────────────────────────────────────────────────────────
 * Per-user chat preferences  (FR-USR-8)
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS user_chat_prefs (
  user_id               TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Reciprocal by design: switching this off also stops you seeing others'.
  read_receipts         BOOLEAN NOT NULL DEFAULT true,
  enter_to_send         BOOLEAN NOT NULL DEFAULT true,
  desktop_notifications BOOLEAN NOT NULL DEFAULT true,
  sound                 BOOLEAN NOT NULL DEFAULT true,
  -- 'all' | 'mentions' | 'none' — the default for conversations that have not
  -- been given a setting of their own.
  default_level         TEXT    NOT NULL DEFAULT 'all',
  -- Quiet hours as local minutes-from-midnight, so a timezone change does not
  -- silently move someone's evening.
  quiet_from_minute     INTEGER,
  quiet_to_minute       INTEGER,
  timezone              TEXT,
  show_presence         BOOLEAN NOT NULL DEFAULT true,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* ──────────────────────────────────────────────────────────────────────────
 * Typing state is Redis-only, on purpose.
 * A typing indicator is worthless three seconds after it was written; writing
 * it to Postgres would be a durable record of something with a 6-second life.
 * ────────────────────────────────────────────────────────────────────────── */
