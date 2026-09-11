-- Each user's academic placement, mirrored from the NGA Central MIS.
--
-- Tupo has never needed to know which programme or grade a person belongs to —
-- a channel is a channel. The admin dashboard changes that: a programme lead
-- must see *their* programme's activity and a class teacher *their* class
-- group's, so every monitored user has to carry the MIS scope they were placed
-- in.
--
-- Populated at SSO login from `GET /users/me` (assignedPrograms / assignedGrades
-- / roles), so it is always as fresh as the person's last visit — which is the
-- only visit the dashboard counts anyway. Ids and names are stored side by side
-- so a dashboard row needs no second lookup and no live MIS call.
--
-- `academic_level` is the derived admin tier:
--   super_admin  — MIS SUPER_ADMIN, or forced admin, or Tupo 'Admin' role
--   program_lead — has UserProgramLead rows this year
--   class_teacher— has UserGrade rows this year
--   staff / student / parent — from the profile's user_type
--   none         — no placement and no admin role
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mis_program_ids        TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS mis_grade_ids          TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS mis_class_group_ids    TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS mis_program_names      TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS mis_grade_names        TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS mis_class_group_names  TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS academic_level         TEXT,
  ADD COLUMN IF NOT EXISTS academic_synced_at     TIMESTAMPTZ;

-- The dashboard's two scope filters: "users in programme P" and "users in grade
-- G / class group C". GIN over the array answers both with an && overlap test.
CREATE INDEX IF NOT EXISTS users_mis_program_ids_idx     ON users USING gin (mis_program_ids);
CREATE INDEX IF NOT EXISTS users_mis_grade_ids_idx       ON users USING gin (mis_grade_ids);
CREATE INDEX IF NOT EXISTS users_mis_class_group_ids_idx ON users USING gin (mis_class_group_ids);
CREATE INDEX IF NOT EXISTS users_academic_level_idx      ON users (academic_level);
