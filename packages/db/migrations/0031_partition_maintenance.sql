-- Partition maintenance for the two range-partitioned logs (SRS §7.3).
--
-- 0002 and 0004 created the current month and the next two at migration time
-- and nothing ever made more, so the first insert past the last month failed
-- with "no partition of relation ... found for row". This adds:
--
--   * tupo_ensure_partitions(months_ahead) — idempotent; the worker calls it
--     daily (`partitions:ensure`) so there are always months in hand;
--   * a DEFAULT partition per table, so a missed run degrades to "rows land in
--     the default" (and the worker warns) instead of "every write fails".
--
-- With a DEFAULT partition in place PostgreSQL refuses to create a new range
-- partition whose range already has rows in the default. The function handles
-- that by building the partition standalone, moving those rows into it, and
-- only then attaching it.

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
        EXECUTE format(
          'WITH moved AS (DELETE FROM %I WHERE created_at >= %L AND created_at < %L RETURNING *)
           INSERT INTO %I SELECT * FROM moved',
          default_name, from_date, to_date, part_name);
        EXECUTE format('ALTER TABLE %I ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',
                       parent, part_name, from_date, to_date);
      ELSE
        EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                       part_name, parent, from_date, to_date);
      END IF;
      created := created + 1;
    END LOOP;
  END LOOP;
  RETURN created;
END $$;

-- Months in hand first, so the defaults below start empty.
SELECT tupo_ensure_partitions(4);

CREATE TABLE IF NOT EXISTS messages_default PARTITION OF messages DEFAULT;
CREATE TABLE IF NOT EXISTS meeting_events_default PARTITION OF meeting_events DEFAULT;

/**
 * How many whole months ahead of the current one both logs can accept writes
 * for — the worker's health endpoint reports it, and anything under 2 means
 * the daily job has stopped running.
 */
CREATE OR REPLACE FUNCTION tupo_partitions_ahead()
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  parent TEXT;
  n      INTEGER;
  best   INTEGER := NULL;
  start_month DATE := date_trunc('month', now())::date;
BEGIN
  FOREACH parent IN ARRAY ARRAY['messages', 'meeting_events'] LOOP
    n := 0;
    WHILE EXISTS (
      SELECT 1 FROM pg_class
       WHERE relname = parent || '_' || to_char(start_month + ((n + 1) || ' month')::interval, 'YYYY_MM')
    ) LOOP
      n := n + 1;
    END LOOP;
    best := LEAST(COALESCE(best, n), n);
  END LOOP;
  RETURN COALESCE(best, 0);
END $$;
