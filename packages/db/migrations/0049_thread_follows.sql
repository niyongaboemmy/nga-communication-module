-- Thread follow / mute (chat experience plan, Phase 5: R-11).
--
-- Following a thread used to be implicit only: you followed it by writing in
-- it or opening it. Nobody could follow without replying, and nobody could
-- silence a noisy thread they had answered once. This row is the explicit
-- choice, and it wins over the implicit rule:
--
--   followers = (participants ∪ openers ∪ @mentioned in the thread
--                ∪ owners/moderators of a room of ≤ 50 ∪ 'following')
--               − 'muted'
--
-- No row means "the implicit rule decides".

CREATE TABLE IF NOT EXISTS thread_follows (
  tenant_id       BIGINT      NOT NULL DEFAULT tupo_tenant_id(),
  conversation_id TEXT        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  root_id         TEXT        NOT NULL,
  user_id         TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state           TEXT        NOT NULL CHECK (state IN ('following', 'muted')),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (root_id, user_id)
);

CREATE INDEX IF NOT EXISTS thread_follows_user_idx ON thread_follows (user_id, state);

-- Tenant isolation, as every chat table since 0046.
ALTER TABLE thread_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_follows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON thread_follows;
CREATE POLICY tenant_isolation ON thread_follows
  USING (tenant_id = tupo_tenant_id()) WITH CHECK (tenant_id = tupo_tenant_id());
DROP POLICY IF EXISTS platform_access ON thread_follows;
CREATE POLICY platform_access ON thread_follows TO tupo_platform USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON thread_follows TO tupo_platform;
