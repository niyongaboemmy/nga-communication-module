-- Tupo RBAC: roles, permissions and the link between them.
--
-- Mirrors the model already proven in nga-discipline-attendance so the three
-- NGA apps are administered the same way: a role carries a permission set, a
-- user points at one role, and the permission set is resolved fresh on every
-- request rather than baked into the session token.

CREATE TABLE IF NOT EXISTS permissions (
  id          SERIAL PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  category    TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS permissions_category_idx ON permissions (category);

CREATE TABLE IF NOT EXISTS roles (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  level       TEXT NOT NULL,            -- STUDENT | PARENT | STAFF | ADMIN
  description TEXT,
  -- System roles are seeded and cannot be deleted; custom roles can.
  is_system   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- A user's permission set comes from this link. NULL means 'unassigned':
-- the user exists but holds no permissions until an administrator acts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS users_role_id_idx ON users (role_id);
