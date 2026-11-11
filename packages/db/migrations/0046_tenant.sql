-- Multi-tenancy, Phase 6 (MULTI_TENANCY_GAP_FIX_PLAN.md ADR-1/ADR-2, gap
-- analysis TP-1/TP-2): every tenant-owned row carries `tenant_id`, and
-- PostgreSQL row-level security keeps each school to its own rows.
--
-- How it fits together
--  * The app sets the session setting `app.tenant_id` on every pooled
--    connection before a statement runs (packages/db/src/pool.ts). The policy
--    compares against it, so a query that forgets a tenant filter still only
--    sees its own school, and a connection with no tenant sees nothing.
--  * `tenant_id` defaults to tupo_tenant_id(): an INSERT with no tenant in
--    context gets NULL and fails NOT NULL -- it can never land in tenant 1 by
--    accident.
--  * FORCE ROW LEVEL SECURITY: production's app role `tupo` OWNS these tables,
--    and owners skip RLS unless forced. (Superusers always skip it -- never run
--    the app as one.)
--  * Cross-tenant work (runAsPlatform) switches to the NOLOGIN role
--    `tupo_platform` with SET ROLE; its own permissive policy sees every row.
--    The app role is a member WITH INHERIT FALSE, so the platform policy never
--    applies to it implicitly. A separate role, rather than an OR-ed
--    `current_setting('app.platform')` clause, keeps the tenant policy a plain
--    `tenant_id = <stable expr>` that the planner turns into an index condition
--    (an OR-ed clause demotes it to a filter and the tenant indexes go unused).
--  * Existing rows become tenant 1 (NGA, the primary tenant -- ADR-2) through
--    the constant column default: PostgreSQL 11+ stores it in the catalog, so
--    ADD COLUMN ... NOT NULL DEFAULT 1 rewrites no table, partitioned
--    messages/meeting_events included. Only the new indexes scan data.
--
-- Global (no tenant_id, no RLS): permissions (the catalog), link_previews (a
-- cache keyed by URL hash), metric_samples, error_events, alert_state
-- (process observability), _migrations, and the new `tenants` registry mirror.
--
-- Data migrations after this one run under FORCE RLS too: the runner gives
-- them no tenant, so a cross-tenant UPDATE must `SET LOCAL ROLE tupo_platform`
-- first (and `RESET ROLE` before any DDL -- the platform role owns nothing).

-- 1. Prerequisites -------------------------------------------------------------

DO $$
DECLARE
  m record;
BEGIN
  IF current_setting('server_version_num')::int < 160000 THEN
    RAISE EXCEPTION 'Tupo tenancy needs PostgreSQL 16+ (GRANT ... WITH INHERIT FALSE); this is %', current_setting('server_version');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tupo_platform') THEN
    BEGIN
      CREATE ROLE tupo_platform NOLOGIN NOINHERIT;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION USING
        MESSAGE = 'role tupo_platform is missing and ' || current_user || ' may not create roles',
        HINT = format('As a superuser run: CREATE ROLE tupo_platform NOLOGIN NOINHERIT; GRANT tupo_platform TO %I WITH INHERIT FALSE, SET TRUE;', current_user);
    END;
  END IF;

  SELECT am.inherit_option, am.set_option INTO m
    FROM pg_auth_members am
   WHERE am.roleid = 'tupo_platform'::regrole AND am.member = (SELECT oid FROM pg_roles WHERE rolname = current_user);

  IF NOT FOUND THEN
    BEGIN
      EXECUTE format('GRANT tupo_platform TO %I WITH INHERIT FALSE, SET TRUE', current_user);
    EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation THEN
      RAISE EXCEPTION USING
        MESSAGE = current_user || ' is not a member of tupo_platform',
        HINT = format('As a superuser run: GRANT tupo_platform TO %I WITH INHERIT FALSE, SET TRUE;', current_user);
    END;
  ELSIF m.inherit_option THEN
    -- Inheriting the platform role would apply its see-everything policy to
    -- every ordinary query: refuse rather than silently disable isolation.
    RAISE EXCEPTION USING
      MESSAGE = current_user || ' inherits tupo_platform; tenant isolation would be off',
      HINT = format('As a superuser run: REVOKE tupo_platform FROM %1$I; GRANT tupo_platform TO %1$I WITH INHERIT FALSE, SET TRUE;', current_user);
  ELSIF NOT m.set_option THEN
    RAISE EXCEPTION USING
      MESSAGE = current_user || ' may not SET ROLE tupo_platform',
      HINT = format('As a superuser run: GRANT tupo_platform TO %I WITH INHERIT FALSE, SET TRUE;', current_user);
  END IF;
END $$;

-- 2. The tenant registry mirror -------------------------------------------------
-- MIS is the control plane (GET /platform/tenants/active); this table records
-- which tenants this Tupo has provisioned (POST /api/integration/tenants/:tid/
-- provision) and is the registry fallback when MIS cannot be reached.

CREATE TABLE IF NOT EXISTS tenants (
  tid          BIGINT      PRIMARY KEY CHECK (tid > 0),
  slug         TEXT        NOT NULL UNIQUE,
  name         TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('PENDING', 'ACTIVE', 'GRACE', 'SUSPENDED', 'ARCHIVED')),
  is_primary   BOOLEAN     NOT NULL DEFAULT false,
  timezone     TEXT        NOT NULL DEFAULT 'Africa/Kigali',
  pkg          TEXT        NOT NULL DEFAULT 'starter',
  provisioned_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tenants (tid, slug, name, status, is_primary, pkg, provisioned_at)
VALUES (1, 'nga', 'NGA', 'ACTIVE', true, 'max', now())
ON CONFLICT (tid) DO NOTHING;

-- 3. The tenant of the current session -------------------------------------------
-- A one-expression SQL function, so the planner inlines it and the policy
-- below becomes `tenant_id = (NULLIF(current_setting(...), ''))::bigint`: a
-- stable value usable as an index condition, evaluated once per scan.

CREATE OR REPLACE FUNCTION tupo_tenant_id() RETURNS BIGINT
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::bigint $$;

-- 4. tenant_id + RLS on every tenant-owned table ---------------------------------

DO $$
DECLARE
  t TEXT;
  tenant_tables TEXT[] := ARRAY[
    'access_shadow_diffs', 'audit_log', 'contact_policies', 'conversation_invites',
    'conversation_members', 'conversations', 'feed_bookmarks', 'feed_comment_reactions',
    'feed_comments', 'feed_event_rsvps', 'feed_page_editors', 'feed_page_followers',
    'feed_pages', 'feed_poll_votes', 'feed_post_edits', 'feed_post_views',
    'feed_posts', 'feed_reactions', 'feed_reel_comments', 'feed_reel_likes',
    'feed_reel_views', 'feed_reels', 'feed_reports', 'feed_stories',
    'feed_story_views', 'feed_timeline', 'files', 'mail_attachments',
    'mail_campaigns', 'mail_delivery_events', 'mail_distribution_lists', 'mail_labels',
    'mail_list_members', 'mail_messages', 'mail_prefs', 'mail_recipients',
    'mail_suppressions', 'mail_templates', 'mail_threads', 'meeting_ai_artifacts',
    'meeting_attendance_segments', 'meeting_breakout_members', 'meeting_breakouts', 'meeting_chat_messages',
    'meeting_events', 'meeting_invites', 'meeting_notes', 'meeting_participants',
    'meeting_poll_votes', 'meeting_polls', 'meeting_question_upvotes', 'meeting_questions',
    'meeting_recordings', 'meeting_transcript_segments', 'meetings', 'message_attachments',
    'message_edits', 'message_links', 'message_mentions', 'message_nonces',
    'message_reactions', 'message_receipts', 'message_saves', 'message_translations',
    'messages', 'notifications', 'poll_votes', 'polls',
    'push_subscriptions', 'role_permissions', 'roles', 'scheduled_messages',
    'session_revocations', 'space_members', 'spaces', 'subjects',
    'thread_reads', 'user_blocks', 'user_chat_prefs', 'user_devices',
    'user_reports', 'user_subjects', 'users'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    -- Constant default first: existing rows read as tenant 1 with no rewrite.
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 1', t);
    -- From now on a row's tenant comes from the session, or the insert fails.
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT tupo_tenant_id()', t);

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = tupo_tenant_id()) WITH CHECK (tenant_id = tupo_tenant_id())', t);
    EXECUTE format('DROP POLICY IF EXISTS platform_access ON %I', t);
    EXECUTE format('CREATE POLICY platform_access ON %I TO tupo_platform USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- The platform role reads and writes through the same tables (never DDL).
GRANT USAGE ON SCHEMA public TO tupo_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tupo_platform;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO tupo_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tupo_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO tupo_platform;

-- 5. Natural keys become unique per tenant (TP-2) ---------------------------------
-- ON CONFLICT targets in code name the new column lists.

DROP INDEX IF EXISTS users_mis_user_id_idx;
CREATE UNIQUE INDEX users_tenant_mis_user_id_idx ON users (tenant_id, mis_user_id);

DROP INDEX IF EXISTS spaces_slug_idx;
CREATE UNIQUE INDEX spaces_tenant_slug_idx ON spaces (tenant_id, slug);

DROP INDEX IF EXISTS feed_pages_slug_idx;
CREATE UNIQUE INDEX feed_pages_tenant_slug_idx ON feed_pages (tenant_id, lower(slug)) WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS mail_distribution_lists_slug_idx;
CREATE UNIQUE INDEX mail_distribution_lists_tenant_slug_idx ON mail_distribution_lists (tenant_id, lower(slug));

ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_name_key;
ALTER TABLE roles ADD CONSTRAINT roles_tenant_name_key UNIQUE (tenant_id, name);

DROP INDEX IF EXISTS contact_policies_pair_idx;
CREATE UNIQUE INDEX contact_policies_tenant_pair_idx ON contact_policies (tenant_id, lower(from_role), lower(to_role));

DROP INDEX IF EXISTS mail_labels_owner_name_idx;
CREATE UNIQUE INDEX mail_labels_tenant_owner_name_idx ON mail_labels (tenant_id, COALESCE(owner_id, ''), lower(name));

ALTER TABLE mail_suppressions DROP CONSTRAINT IF EXISTS mail_suppressions_pkey;
ALTER TABLE mail_suppressions ADD CONSTRAINT mail_suppressions_pkey PRIMARY KEY (tenant_id, address);

-- One browser push endpoint may serve accounts in two schools.
ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_endpoint_key;
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_tenant_endpoint_key UNIQUE (tenant_id, endpoint);

-- subjects.id is the MIS subject id, and MIS ids repeat across tenant DBs
-- (ADR-7): the key is (tenant_id, id), and so are the references to it.
ALTER TABLE user_subjects DROP CONSTRAINT IF EXISTS user_subjects_subject_id_fkey;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_subject_id_fkey;
ALTER TABLE subjects DROP CONSTRAINT IF EXISTS subjects_pkey;
ALTER TABLE subjects ADD CONSTRAINT subjects_pkey PRIMARY KEY (tenant_id, id);
ALTER TABLE user_subjects ADD CONSTRAINT user_subjects_subject_fkey
  FOREIGN KEY (tenant_id, subject_id) REFERENCES subjects (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE conversations ADD CONSTRAINT conversations_subject_fkey
  FOREIGN KEY (tenant_id, subject_id) REFERENCES subjects (tenant_id, id) ON DELETE CASCADE;

-- 6. Tenant-wide hot paths --------------------------------------------------------
-- Most hot lookups are already keyed by a snowflake id (conversation, user,
-- post) and keep their indexes, with the tenant check as a cheap filter.
-- These serve the queries that range over a whole school.

CREATE INDEX IF NOT EXISTS users_tenant_level_idx ON users (tenant_id, academic_level);
CREATE INDEX IF NOT EXISTS users_tenant_email_idx ON users (tenant_id, lower(email));
CREATE INDEX IF NOT EXISTS conversations_tenant_recent_idx
  ON conversations (tenant_id, last_message_at DESC NULLS LAST) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS messages_tenant_created_idx ON messages (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feed_posts_tenant_published_idx
  ON feed_posts (tenant_id, published_at DESC, id DESC) WHERE deleted_at IS NULL AND status = 'published';
CREATE INDEX IF NOT EXISTS feed_reels_tenant_recent_idx
  ON feed_reels (tenant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS audit_log_tenant_created_idx ON audit_log (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS meetings_tenant_scheduled_idx ON meetings (tenant_id, scheduled_start);
CREATE INDEX IF NOT EXISTS files_tenant_owner_idx ON files (tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS notifications_tenant_digest_idx
  ON notifications (tenant_id, created_at) WHERE read_at IS NULL AND emailed_at IS NULL;
