-- Tupo Phase 0 — core schema.
-- Idempotent: safe to re-run. Applied by src/migrate.ts, which records each
-- file in _migrations so a second run is a no-op.

CREATE TABLE IF NOT EXISTS users (
  id                      TEXT PRIMARY KEY,
  mis_user_id             TEXT        NOT NULL,
  name                    TEXT        NOT NULL,
  email                   TEXT        NOT NULL DEFAULT '',
  avatar_url              TEXT,
  role                    TEXT        NOT NULL DEFAULT 'unassigned',
  role_assigned_by_admin  BOOLEAN     NOT NULL DEFAULT false,
  preferred_theme         TEXT,
  status                  TEXT        NOT NULL DEFAULT 'active',
  last_login_at           TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_mis_user_id_idx ON users (mis_user_id);
CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);

CREATE TABLE IF NOT EXISTS user_devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT,
  user_agent   TEXT,
  ip_address   TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_devices_user_id_idx ON user_devices (user_id);

CREATE TABLE IF NOT EXISTS spaces (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  retention_days INTEGER,
  settings       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS spaces_slug_idx ON spaces (slug);

CREATE TABLE IF NOT EXISTS space_members (
  space_id  TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, user_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  slug         TEXT,
  name         TEXT,
  topic        TEXT,
  is_private   BOOLEAN NOT NULL DEFAULT false,
  is_archived  BOOLEAN NOT NULL DEFAULT false,
  origin       TEXT NOT NULL DEFAULT 'manual',
  last_seq     BIGINT NOT NULL DEFAULT 0,
  member_count INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS conversations_space_idx ON conversations (space_id);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_space_slug_idx
  ON conversations (space_id, lower(slug)) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member',
  last_read_seq   BIGINT NOT NULL DEFAULT 0,
  unread_count    INTEGER NOT NULL DEFAULT 0,
  notification    TEXT NOT NULL DEFAULT 'all',
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at         TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS conversation_members_user_idx ON conversation_members (user_id);

-- Partitioned by month from day one (SRS §7.3): the hot partition stays small
-- and old months detach cheaply. Retrofitting partitioning onto a large live
-- table is painful, which is why it is here in Phase 0 rather than later.
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT        NOT NULL,
  conversation_id TEXT        NOT NULL,
  seq             BIGINT      NOT NULL,
  sender_id       TEXT        NOT NULL,
  type            TEXT        NOT NULL DEFAULT 'text',
  body            TEXT,
  content         JSONB,
  nonce           TEXT        NOT NULL,
  edited_at       TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq, created_at)
) PARTITION BY RANGE (created_at);

-- Idempotency: a retried send with the same nonce resolves to the original row.
CREATE UNIQUE INDEX IF NOT EXISTS messages_nonce_idx
  ON messages (conversation_id, sender_id, nonce, created_at);

CREATE TABLE IF NOT EXISTS files (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES users(id),
  storage_driver TEXT NOT NULL,
  storage_key    TEXT NOT NULL,
  original_name  TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  size_bytes     BIGINT NOT NULL,
  checksum       TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS files_owner_idx ON files (owner_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx  ON audit_log (actor_id);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action);
