-- Row-level security on the partitions of messages and meeting_events
-- (school isolation audit 2026-11-25, TP-ISO-3; defence in depth).
--
-- 0046 put FORCE RLS and the tenant policy on the two partitioned PARENTS.
-- Every query the apps make goes through the parent, and PostgreSQL applies
-- the parent's policies there, so no school ever saw another's rows. But a
-- partition is a table of its own: a statement that names `messages_2026_11`
-- or `messages_default` directly skipped RLS altogether. This gives every
-- partition the parent's two policies:
--
--   tenant_isolation  tenant_id = tupo_tenant_id()  (USING + WITH CHECK)
--   platform_access   TO tupo_platform, true        (runAsPlatform)
--
-- and makes tupo_ensure_partitions (the worker's daily partitions:ensure)
-- apply them to every partition it creates from now on. Queries through the
-- parent are unchanged (the parent's policies still decide there).

CREATE OR REPLACE FUNCTION tupo_secure_partition(part TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', part);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', part);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = tupo_tenant_id()) WITH CHECK (tenant_id = tupo_tenant_id())', part);
  EXECUTE format('DROP POLICY IF EXISTS platform_access ON %I', part);
  EXECUTE format('CREATE POLICY platform_access ON %I TO tupo_platform USING (true) WITH CHECK (true)', part);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO tupo_platform', part);
END $$;

-- Every existing partition, the DEFAULT ones included.
DO $$
DECLARE part TEXT;
BEGIN
  FOR part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname IN ('messages', 'meeting_events')
  LOOP
    PERFORM tupo_secure_partition(part);
  END LOOP;
END $$;

-- Same function as 0031, plus: each new partition is secured, and moving
-- stragglers out of the DEFAULT partition (now under FORCE RLS, which would
-- hide every row from the app role running outside any tenant) lifts FORCE on
-- the default for the length of the move only -- inside this transaction, so
-- it is back before anyone else can see the table.
CREATE OR REPLACE FUNCTION tupo_ensure_partitions(months_ahead INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent     TEXT;
  start_month DATE := date_trunc('month', now())::date;
  i          INTEGER;
  from_date  DATE;
  to_date    DATE;
  part_name  TEXT;
  default_name TEXT;
  created    INTEGER := 0;
BEGIN
  FOREACH parent IN ARRAY ARRAY['messages', 'meeting_events'] LOOP
    default_name := parent || '_default';

    FOR i IN 0..GREATEST(months_ahead, 0) LOOP
      from_date := (start_month + (i || ' month')::interval)::date;
      to_date   := (start_month + ((i + 1) || ' month')::interval)::date;
      part_name := parent || '_' || to_char(from_date, 'YYYY_MM');

      CONTINUE WHEN EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name);

      IF EXISTS (SELECT 1 FROM pg_class WHERE relname = default_name) THEN
        -- Standalone first, then move any stragglers out of the default, then
        -- attach: the only order PostgreSQL accepts once a default exists.
        EXECUTE format('CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS INCLUDING CONSTRAINTS)',
                       part_name, parent);
        EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', default_name);
        EXECUTE format(
          'WITH moved AS (DELETE FROM %I WHERE created_at >= %L AND created_at < %L RETURNING *)
           INSERT INTO %I SELECT * FROM moved',
          default_name, from_date, to_date, part_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', default_name);
        EXECUTE format('ALTER TABLE %I ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',
                       parent, part_name, from_date, to_date);
      ELSE
        EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                       part_name, parent, from_date, to_date);
      END IF;
      PERFORM tupo_secure_partition(part_name);
      created := created + 1;
    END LOOP;
  END LOOP;
  RETURN created;
END $$;
