-- One person, several schools (TENANT_SWITCHING_PLAN.md §4.2, Appendix A.3).
--
-- Switching school in MIS ends the old school's sessions of THIS browser only:
-- MIS's back-channel logout then carries `sid`, the MIS browser session id that
-- is also inside the MIS token nested in each Tupo session. Tupo records it
-- here, and a session is over when its sid -- or '' for a session whose MIS
-- token has no sid, which cannot be told apart -- was revoked after it was
-- issued. A logout without sid still uses session_revocations (every session
-- of the person in that school), exactly as before.
--
-- Rows only matter for a session's life (24 h); the back-channel handler
-- deletes a person's rows older than two days whenever it writes.

CREATE TABLE IF NOT EXISTS session_sid_revocations (
  tenant_id   BIGINT      NOT NULL DEFAULT tupo_tenant_id(),
  user_id     TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sid         TEXT        NOT NULL,
  revoked_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, sid)
);

-- The browser session a push subscription was made in, so a school switch
-- stops this device's old-school pushes and leaves the person's other devices
-- alone. NULL = made before sids (removed by any sid-scoped logout of the person).
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS mis_sid TEXT;

-- Tenant isolation, as every table since 0046.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['session_sid_revocations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = tupo_tenant_id()) WITH CHECK (tenant_id = tupo_tenant_id())', t);
    EXECUTE format('DROP POLICY IF EXISTS platform_access ON %I', t);
    EXECUTE format('CREATE POLICY platform_access ON %I TO tupo_platform USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO tupo_platform', t);
  END LOOP;
END $$;
