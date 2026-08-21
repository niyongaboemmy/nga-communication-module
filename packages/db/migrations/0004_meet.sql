-- Tupo Meet (SRS §6.5, §10; docs/MEET_IMPLEMENTATION_PLAN.md §3).
--
-- The session model is lifted from TaskMentor's proctoring module, which
-- already proved this shape in production: a session row keyed by an opaque
-- token, participants with connection state, and a severity-tagged event
-- stream that both the live host console and the after-the-fact analytics
-- read from. `meetings` ≙ proctoring_sessions, `meeting_events` ≙
-- proctoring_events.

CREATE TABLE IF NOT EXISTS meetings (
  id               TEXT PRIMARY KEY,
  -- NULL for a standalone meeting; set when the meeting was started from a
  -- conversation, which is also what lets in-meeting chat be folded back in.
  conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  space_id         TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  host_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  title            TEXT NOT NULL DEFAULT 'Meeting',
  description      TEXT,

  -- The media-server room identifier. Unique and unguessable; the join code is
  -- the human-facing handle and is rotatable without moving the room.
  room_name        TEXT NOT NULL UNIQUE,
  join_code        TEXT NOT NULL UNIQUE,

  status           TEXT NOT NULL DEFAULT 'scheduled',   -- scheduled|live|ended|cancelled
  -- What the host asked for; `transport` is what the server actually chose.
  media_mode       TEXT NOT NULL DEFAULT 'auto',        -- auto|mesh|sfu
  transport        TEXT,                                -- mesh|sfu, set on first join

  scheduled_start  TIMESTAMPTZ,
  scheduled_end    TIMESTAMPTZ,
  recurrence_rule  TEXT,
  started_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,

  settings         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Denormalised so the meetings list does not need a count(*) per row.
  peak_participants INTEGER NOT NULL DEFAULT 0,
  total_participants INTEGER NOT NULL DEFAULT 0,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meetings_host_idx         ON meetings (host_id);
CREATE INDEX IF NOT EXISTS meetings_conversation_idx ON meetings (conversation_id);
CREATE INDEX IF NOT EXISTS meetings_status_idx       ON meetings (status);
CREATE INDEX IF NOT EXISTS meetings_scheduled_idx    ON meetings (scheduled_start);


-- The attendance record. One row per participant per meeting; `left_at` NULL
-- means still in the room. This is what FR-MEET-15 exports as lesson-delivery
-- evidence, so it is written on every state change rather than reconstructed
-- from the event stream afterwards.
CREATE TABLE IF NOT EXISTS meeting_participants (
  id               TEXT PRIMARY KEY,
  meeting_id       TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  -- NULL for a guest: they authenticated with nothing but the join link, which
  -- the host had to enable. Guests are never given a users row.
  user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  display_name     TEXT NOT NULL,
  is_guest         BOOLEAN NOT NULL DEFAULT false,

  role             TEXT NOT NULL DEFAULT 'attendee',    -- attendee|presenter|cohost|host
  state            TEXT NOT NULL DEFAULT 'lobby',
  connection_quality TEXT NOT NULL DEFAULT 'good',

  audio_enabled    BOOLEAN NOT NULL DEFAULT false,
  video_enabled    BOOLEAN NOT NULL DEFAULT false,
  screen_sharing   BOOLEAN NOT NULL DEFAULT false,
  hand_raised_at   TIMESTAMPTZ,

  device_label     TEXT,
  ip_address       TEXT,

  knocked_at       TIMESTAMPTZ,
  admitted_at      TIMESTAMPTZ,
  admitted_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  joined_at        TIMESTAMPTZ,
  left_at          TIMESTAMPTZ,
  -- Accumulated across reconnects, so a dropped-and-rejoined participant is
  -- credited with the time they were actually present rather than the last leg.
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  -- Seconds this participant was the active speaker. Feeds the engagement report.
  speaking_seconds INTEGER NOT NULL DEFAULT 0,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_participants_meeting_idx ON meeting_participants (meeting_id);
CREATE INDEX IF NOT EXISTS meeting_participants_user_idx    ON meeting_participants (user_id);
CREATE INDEX IF NOT EXISTS meeting_participants_state_idx   ON meeting_participants (meeting_id, state);


-- Range-partitioned by month like `messages` (SRS §7.3) — a busy term produces
-- a lot of these and the retention job needs to detach rather than delete.
CREATE TABLE IF NOT EXISTS meeting_events (
  id           TEXT NOT NULL,
  meeting_id   TEXT NOT NULL,
  participant_id TEXT,
  actor_id     TEXT,
  type         TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'info',   -- info|warn|critical
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS meeting_events_meeting_idx  ON meeting_events (meeting_id, created_at DESC);
CREATE INDEX IF NOT EXISTS meeting_events_severity_idx ON meeting_events (severity) WHERE severity <> 'info';

DO $$
DECLARE
  start_month DATE := date_trunc('month', now())::date;
  i INTEGER; from_date DATE; to_date DATE; part_name TEXT;
BEGIN
  FOR i IN 0..2 LOOP
    from_date := (start_month + (i || ' month')::interval)::date;
    to_date   := (start_month + ((i + 1) || ' month')::interval)::date;
    part_name := 'meeting_events_' || to_char(from_date, 'YYYY_MM');
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF meeting_events FOR VALUES FROM (%L) TO (%L)',
        part_name, from_date, to_date);
    END IF;
  END LOOP;
END $$;


-- In-meeting chat. Persisted rather than socket-only so it survives a reload,
-- can be replayed by someone admitted late, and can be folded into the minutes.
CREATE TABLE IF NOT EXISTS meeting_chat_messages (
  id                  TEXT PRIMARY KEY,
  meeting_id          TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id      TEXT NOT NULL REFERENCES meeting_participants(id) ON DELETE CASCADE,
  sender_name         TEXT NOT NULL,
  body                TEXT NOT NULL,
  -- Set for an in-meeting private message. Those are excluded from the
  -- transcript handed to the AI and from the exported minutes.
  to_participant_id   TEXT REFERENCES meeting_participants(id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_chat_meeting_idx ON meeting_chat_messages (meeting_id, created_at);


-- The speaker-attributed transcript.
--
-- Attribution is free here: each segment arrives from the socket of the person
-- whose microphone produced it, so there is no diarization step to get wrong.
-- Interim (`is_final = false`) segments are shown live and then replaced; only
-- final ones are kept for the AI and the export.
CREATE TABLE IF NOT EXISTS meeting_transcript_segments (
  id             TEXT PRIMARY KEY,
  meeting_id     TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id TEXT REFERENCES meeting_participants(id) ON DELETE SET NULL,
  speaker_name   TEXT NOT NULL,
  text           TEXT NOT NULL,
  lang           TEXT NOT NULL DEFAULT 'en-US',
  is_final       BOOLEAN NOT NULL DEFAULT true,
  confidence     REAL,
  -- Offset from meeting start, so chapters and recording seeks line up without
  -- doing timestamp arithmetic against a clock that may have drifted.
  offset_seconds INTEGER,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_transcript_meeting_idx
  ON meeting_transcript_segments (meeting_id, started_at);


-- One row per generated artifact. `provider_used` is recorded because the
-- fallback chain means the same prompt can be answered by any of four models,
-- and "which model said this" is the first question anyone asks of a summary.
CREATE TABLE IF NOT EXISTS meeting_ai_artifacts (
  id             TEXT PRIMARY KEY,
  meeting_id     TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  content        JSONB NOT NULL,
  provider_used  TEXT,
  -- How much transcript this was generated from, so a rolling summary can tell
  -- whether it is stale without re-reading every segment.
  segment_count  INTEGER NOT NULL DEFAULT 0,
  requested_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_ai_meeting_idx ON meeting_ai_artifacts (meeting_id, kind, created_at DESC);


CREATE TABLE IF NOT EXISTS meeting_polls (
  id                   TEXT PRIMARY KEY,
  meeting_id           TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  created_by           TEXT NOT NULL REFERENCES meeting_participants(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL DEFAULT 'poll',   -- poll|quiz
  question             TEXT NOT NULL,
  options              JSONB NOT NULL,                 -- string[]
  correct_option_index INTEGER,
  anonymous            BOOLEAN NOT NULL DEFAULT false,
  multiple_choice      BOOLEAN NOT NULL DEFAULT false,
  status               TEXT NOT NULL DEFAULT 'open',   -- open|closed
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS meeting_polls_meeting_idx ON meeting_polls (meeting_id, created_at);

CREATE TABLE IF NOT EXISTS meeting_poll_votes (
  poll_id        TEXT NOT NULL REFERENCES meeting_polls(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES meeting_participants(id) ON DELETE CASCADE,
  option_indexes JSONB NOT NULL,                       -- number[]
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One vote per participant per poll. Changing your mind updates this row;
  -- it never adds a second.
  PRIMARY KEY (poll_id, participant_id)
);


CREATE TABLE IF NOT EXISTS meeting_questions (
  id             TEXT PRIMARY KEY,
  meeting_id     TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES meeting_participants(id) ON DELETE CASCADE,
  asked_by       TEXT NOT NULL,
  text           TEXT NOT NULL,
  upvotes        INTEGER NOT NULL DEFAULT 0,
  answered       BOOLEAN NOT NULL DEFAULT false,
  answer_text    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_questions_meeting_idx ON meeting_questions (meeting_id, upvotes DESC);

CREATE TABLE IF NOT EXISTS meeting_question_upvotes (
  question_id    TEXT NOT NULL REFERENCES meeting_questions(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES meeting_participants(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, participant_id)
);


CREATE TABLE IF NOT EXISTS meeting_breakouts (
  id          TEXT PRIMARY KEY,
  meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- Breakout rooms get their own media room; the main room stays open behind
  -- them so returning does not mean renegotiating from scratch.
  room_name   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',            -- open|closed
  closes_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS meeting_breakouts_meeting_idx ON meeting_breakouts (meeting_id);

CREATE TABLE IF NOT EXISTS meeting_breakout_members (
  breakout_id    TEXT NOT NULL REFERENCES meeting_breakouts(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES meeting_participants(id) ON DELETE CASCADE,
  PRIMARY KEY (breakout_id, participant_id)
);


CREATE TABLE IF NOT EXISTS meeting_recordings (
  id             TEXT PRIMARY KEY,
  meeting_id     TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  file_id        TEXT REFERENCES files(id) ON DELETE SET NULL,
  started_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'recording',    -- recording|processing|ready|failed
  -- The media server's own handle for the job, so a stop request can find it.
  egress_id      TEXT,
  duration_seconds INTEGER,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS meeting_recordings_meeting_idx ON meeting_recordings (meeting_id);


CREATE TABLE IF NOT EXISTS meeting_invites (
  meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response    TEXT NOT NULL DEFAULT 'pending',         -- pending|accepted|declined|tentative
  notified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, user_id)
);
CREATE INDEX IF NOT EXISTS meeting_invites_user_idx ON meeting_invites (user_id, response);
