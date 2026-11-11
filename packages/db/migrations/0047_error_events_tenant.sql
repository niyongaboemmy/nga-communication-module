-- Multi-tenancy security review: error_events per tenant.
--
-- 0046 left error_events global (process observability), but the System page
-- that reads it is behind SYSTEM_HEALTH_VIEW, which every tenant's default
-- Admin role holds -- so one school's admin could read (and resolve) another
-- school's crash reports, stack traces and routes.
--
-- From here on an error row belongs to the tenant whose request (or job)
-- raised it; `tenant_id IS NULL` marks a process-level error (unhandled
-- rejection, boot failure, a job with no tenant) that no tenant owns.
--  * A tenant connection sees only its own rows (tenant_isolation).
--  * A connection with no tenant (runWithoutTenant) sees only the
--    process-level rows (process_level).
--  * tupo_platform sees everything (platform_access); recordError writes
--    through it, naming tenant_id explicitly, and the System routes read the
--    process-level rows through it for the primary tenant only.
-- alert_state and metric_samples stay global: they describe the shared
-- processes and host, and the API serves them to the primary tenant only.
--
-- Append-only: 0046 is never edited.

ALTER TABLE error_events ADD COLUMN IF NOT EXISTS tenant_id BIGINT;
-- No default: a tenant-scoped insert must name its tenant (recordError does),
-- and a forgotten one is caught by WITH CHECK rather than silently global.

-- The same crash in two schools is two rows: the key is (tenant, fingerprint).
-- NULLS NOT DISTINCT (PostgreSQL 15+; 0046 already requires 16) keeps the
-- process-level rows unique per fingerprint too, so ON CONFLICT still groups.
ALTER TABLE error_events DROP CONSTRAINT IF EXISTS error_events_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS error_events_tenant_fingerprint_idx
  ON error_events (tenant_id, fingerprint) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS error_events_tenant_last_at_idx ON error_events (tenant_id, last_at DESC);

ALTER TABLE error_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON error_events;
CREATE POLICY tenant_isolation ON error_events
  USING (tenant_id = tupo_tenant_id()) WITH CHECK (tenant_id = tupo_tenant_id());

DROP POLICY IF EXISTS process_level ON error_events;
CREATE POLICY process_level ON error_events
  USING (tenant_id IS NULL AND tupo_tenant_id() IS NULL)
  WITH CHECK (tenant_id IS NULL AND tupo_tenant_id() IS NULL);

DROP POLICY IF EXISTS platform_access ON error_events;
CREATE POLICY platform_access ON error_events TO tupo_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON error_events TO tupo_platform;
