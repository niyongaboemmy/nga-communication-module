-- Meet, round two: personal notes, an explicit admission policy, and guests.

-- ── Notes ───────────────────────────────────────────────────────────────────
--
-- Deliberately separate from `meeting_ai_artifacts`. Those are what the model
-- produced; these are what a *person* decided was worth keeping. Conflating
-- them would mean a teacher's own note could be overwritten by the next
-- regeneration, which is the one thing a notebook must never do.
--
-- A note is a timestamped entry rather than one long document, so every note
-- lines up with a point in the transcript and the recording.
CREATE TABLE IF NOT EXISTS meeting_notes (
  id             TEXT PRIMARY KEY,
  meeting_id     TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  -- The participant is the author of record: it is the only identity a guest
  -- has. user_id is filled in as well for signed-in authors so their notes
  -- survive being looked up by account.
  participant_id TEXT NOT NULL REFERENCES meeting_participants(id) ON DELETE CASCADE,
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name    TEXT NOT NULL,

  body           TEXT NOT NULL,
  -- manual   — typed by hand
  -- capture  — lifted from the transcript with one tap
  -- ai       — generated, then kept by a person
  -- tidied   — typed by hand, then cleaned up by the AI
  source         TEXT NOT NULL DEFAULT 'manual',
  -- What the note said before the AI touched it. Keeping it is what makes
  -- "tidy this up" safe to press: the original is never lost.
  original_body  TEXT,
  provider_used  TEXT,

  -- Offset from meeting start, so a note can be replayed against the
  -- transcript or seeked to in the recording.
  offset_seconds INTEGER,
  -- Private to the author unless deliberately shared with the room.
  is_shared      BOOLEAN NOT NULL DEFAULT false,
  pinned         BOOLEAN NOT NULL DEFAULT false,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS meeting_notes_meeting_idx
  ON meeting_notes (meeting_id, created_at);
-- The two reads the notes panel makes: "my notes" and "notes shared with me".
CREATE INDEX IF NOT EXISTS meeting_notes_author_idx
  ON meeting_notes (meeting_id, participant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS meeting_notes_shared_idx
  ON meeting_notes (meeting_id) WHERE is_shared AND deleted_at IS NULL;


-- ── Guests ──────────────────────────────────────────────────────────────────
--
-- A public meeting admits people with no NGA account at all. They are never
-- given a `users` row — Tupo mints identities for nobody (see the note at the
-- top of packages/db/src/schema.ts). Their whole identity is the participant
-- row plus the name they typed, and it dies with the meeting.
ALTER TABLE meeting_participants
  ADD COLUMN IF NOT EXISTS guest_token_id TEXT;

-- Used to bind a guest's session token to exactly one participant row.
CREATE UNIQUE INDEX IF NOT EXISTS meeting_participants_guest_token_idx
  ON meeting_participants (guest_token_id) WHERE guest_token_id IS NOT NULL;
