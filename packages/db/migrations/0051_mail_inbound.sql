-- Receiving outside email (docs/MAIL_INBOUND_PLAN_2026-11.md).
--
-- Until now every mail_messages row was written by a Tupo user. Mail that
-- arrives from outside (a connected school mailbox, or a reply caught in the
-- relay's mailbox) has no Tupo sender, so `from_user_id` becomes optional and
-- the row says where it came from.

ALTER TABLE mail_messages ALTER COLUMN from_user_id DROP NOT NULL;
-- tupo  : written in Tupo
-- imap  : imported from a person's connected mailbox
-- reply : an outside reply caught in the relay's mailbox (MAIL_REPLY_CAPTURE)
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'tupo';
-- The email's own Message-ID, so a later reply that names it threads here.
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS external_message_id TEXT;
CREATE INDEX IF NOT EXISTS mail_messages_external_id_idx
  ON mail_messages (external_message_id) WHERE external_message_id IS NOT NULL;

/* A person's connected mailbox. One per person. The password is AES-256-GCM
 * ciphertext (key: MAIL_ACCOUNT_KEY on the server, never in the database). */
CREATE TABLE IF NOT EXISTS mail_accounts (
  tenant_id      BIGINT      NOT NULL DEFAULT tupo_tenant_id(),
  id             TEXT        PRIMARY KEY,
  user_id        TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address        TEXT        NOT NULL,
  username       TEXT        NOT NULL,
  secret_enc     TEXT        NOT NULL,
  imap_host      TEXT        NOT NULL,
  imap_port      INTEGER     NOT NULL DEFAULT 993,
  imap_secure    BOOLEAN     NOT NULL DEFAULT true,
  smtp_host      TEXT,
  smtp_port      INTEGER,
  smtp_secure    BOOLEAN     NOT NULL DEFAULT true,
  -- Send replies through this account, as this address.
  send_as        BOOLEAN     NOT NULL DEFAULT false,
  status         TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'paused')),
  last_error     TEXT,
  last_sync_at   TIMESTAMPTZ,
  -- IMAP position: UIDs are only meaningful under one UIDVALIDITY.
  uid_validity   BIGINT,
  last_uid       BIGINT      NOT NULL DEFAULT 0,
  imported_count INTEGER     NOT NULL DEFAULT 0,
  -- Held while one worker syncs, so two never import the same message.
  sync_claimed_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_accounts_user_idx ON mail_accounts (tenant_id, user_id);

/* What has been imported for whom: an email reaches a person once, however
 * many times it is seen (two syncs, the same reply in two mailboxes). */
CREATE TABLE IF NOT EXISTS mail_inbound_seen (
  tenant_id        BIGINT      NOT NULL DEFAULT tupo_tenant_id(),
  user_id          TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_message_id TEXT        NOT NULL,
  mail_message_id  TEXT        REFERENCES mail_messages(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, email_message_id)
);

/* The relay mailbox's position, for shared reply capture (one per school). */
CREATE TABLE IF NOT EXISTS mail_reply_capture_state (
  tenant_id    BIGINT      PRIMARY KEY DEFAULT tupo_tenant_id(),
  uid_validity BIGINT,
  last_uid     BIGINT      NOT NULL DEFAULT 0,
  last_sync_at TIMESTAMPTZ,
  last_error   TEXT,
  matched      INTEGER     NOT NULL DEFAULT 0,
  bounces      INTEGER     NOT NULL DEFAULT 0
);

-- Tenant isolation, as every table since 0046.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['mail_accounts', 'mail_inbound_seen', 'mail_reply_capture_state'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = tupo_tenant_id()) WITH CHECK (tenant_id = tupo_tenant_id())', t);
    EXECUTE format('DROP POLICY IF EXISTS platform_access ON %I', t);
    EXECUTE format('CREATE POLICY platform_access ON %I TO tupo_platform USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO tupo_platform', t);
  END LOOP;
END $$;
