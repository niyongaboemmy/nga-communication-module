-- Access control v2 adoption (nga_central_mis/ACCESS_LEVELS_RBAC_IMPLEMENTATION_PLAN.md,
-- Phase 7). Additive only: nothing existing is altered or dropped.

-- 1. Shadow-mode disagreements. With ACCESS_V2_MODE=shadow the local RBAC
--    decides and the MIS snapshot decides too; every (user, capability, route,
--    outcome) disagreement is one row whose `hits` counts repeats. Reviewed by
--    leadership before switching to enforce.
CREATE TABLE IF NOT EXISTS access_shadow_diffs (
  id              BIGSERIAL   PRIMARY KEY,
  user_id         TEXT        NOT NULL,          -- Tupo user id
  mis_user_id     TEXT,
  capability      TEXT        NOT NULL,          -- key(s), "A|B" for any-of, "A&B" for all-of
  route           TEXT        NOT NULL,          -- "GET /api/..." or a named check ("contact:dm")
  legacy_allowed  BOOLEAN     NOT NULL,
  v2_allowed      BOOLEAN     NOT NULL,
  v2_depth        TEXT,
  sample_target   JSONB,
  hits            INTEGER     NOT NULL DEFAULT 1,
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS access_shadow_diffs_key_idx
  ON access_shadow_diffs (user_id, capability, route, legacy_allowed, v2_allowed);
CREATE INDEX IF NOT EXISTS access_shadow_diffs_last_seen_idx ON access_shadow_diffs (last_seen DESC);

-- 2. The programmes a person LEADS, as opposed to the programmes they belong
--    to. `mis_program_ids` is membership (a class teacher carries the programme
--    of their grade, so a programme lead's dashboard counts them); using it as
--    the viewer's *scope* let a class teacher see their whole programme.
--    NULL = not yet re-synced since this migration (falls back to
--    mis_program_ids for a programme lead only).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mis_lead_program_ids TEXT[];

-- 3. Contact-policy inputs (SRS FR-USR-6), refreshed at login from the MIS
--    snapshot when one is available:
--      access_persona              MIS UserProfile.user_type (STUDENT, PARENT, TEACHER, ...)
--      access_teach_class_group_ids class groups the person teaches / leads
--                                  (CLASS_GROUP grants, SUBJECT_CLASS pairs, expanded
--                                  PROGRAM / GRADE grants)
--      access_student_ids          MIS ids of mentees (MENTEES) and children (CHILDREN)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS access_persona               TEXT,
  ADD COLUMN IF NOT EXISTS access_teach_class_group_ids TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS access_student_ids           TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS access_synced_at             TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS users_access_teach_class_group_ids_idx
  ON users USING gin (access_teach_class_group_ids);
CREATE INDEX IF NOT EXISTS users_access_student_ids_idx
  ON users USING gin (access_student_ids);
