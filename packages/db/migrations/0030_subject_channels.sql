-- Subject channels: a Slack-style home for each subject, separate from Chat.
--
-- Tupo knew programmes, grades and class groups (0023) but not subjects. A
-- subject's channels are for everyone who teaches or is enrolled in it, so the
-- subjects a person has are mirrored from the NGA Central MIS at sign-in
-- (teachers: /academics/my-assigned-subjects; students: their current-year
-- enrolments) and kept in user_subjects, replaced wholesale on each sync.
--
-- A subject channel is an ordinary conversation (type 'channel') with
-- subject_id set, so messages, files, threads, pins and reactions all come
-- from the existing chat engine. They live in their own 'subjects' space so
-- they never show up in Chat's channel directory, and their slug is prefixed
-- with the subject id so every subject can have its own #general.
CREATE TABLE IF NOT EXISTS subjects (
  id          TEXT PRIMARY KEY,               -- the MIS subject id
  name        TEXT NOT NULL,
  code        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_subjects (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id  TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, subject_id)
);
CREATE INDEX IF NOT EXISTS user_subjects_subject_idx ON user_subjects (subject_id);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS subject_id TEXT REFERENCES subjects(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS conversations_subject_idx
  ON conversations (subject_id) WHERE subject_id IS NOT NULL;

INSERT INTO spaces (id, slug, name, description)
VALUES ('subjects', 'subjects', 'NGA Subjects', 'Subject channels, one set per subject.')
ON CONFLICT DO NOTHING;
