-- Bring the coarse `users.role` label and `academic_level` back in line with
-- the role an administrator pinned.
--
-- Until now `PUT /api/users/:id/role` only changed `role_id`, so a demoted
-- administrator kept `role = 'admin'` and `academic_level = 'super_admin'` —
-- both read directly by the dashboard scope, chat's contact rules and the feed.
-- The route now keeps them in step; this repairs rows changed before that.
--
-- Only admin-pinned rows with a role row are touched, and only where the label
-- actually disagrees with the role's level. Idempotent and data-only.

UPDATE users u
   SET role = CASE r.level
                WHEN 'ADMIN'   THEN 'admin'
                WHEN 'STAFF'   THEN 'staff'
                WHEN 'STUDENT' THEN 'student'
                WHEN 'PARENT'  THEN 'parent'
                ELSE 'unassigned'
              END,
       updated_at = now()
  FROM roles r
 WHERE r.id = u.role_id
   AND u.role_assigned_by_admin
   AND u.role IS DISTINCT FROM CASE r.level
                WHEN 'ADMIN'   THEN 'admin'
                WHEN 'STAFF'   THEN 'staff'
                WHEN 'STUDENT' THEN 'student'
                WHEN 'PARENT'  THEN 'parent'
                ELSE 'unassigned'
              END;

-- A pinned non-admin must not keep an unrestricted dashboard scope. Mirrors
-- academicLevelFromPlacement() in apps/api/src/services/userService.ts: grades
-- (or class groups) → class_teacher, else programmes → program_lead, else the
-- coarse role, else none. The next MIS login refines it from the live payload.
UPDATE users u
   SET academic_level = CASE
         WHEN cardinality(u.mis_grade_ids) > 0 OR cardinality(u.mis_class_group_ids) > 0 THEN 'class_teacher'
         WHEN cardinality(u.mis_program_ids) > 0 THEN 'program_lead'
         WHEN u.role IN ('staff', 'student', 'parent') THEN u.role
         ELSE 'none'
       END,
       updated_at = now()
 WHERE u.role_assigned_by_admin
   AND u.role <> 'admin'
   AND u.academic_level = 'super_admin';
