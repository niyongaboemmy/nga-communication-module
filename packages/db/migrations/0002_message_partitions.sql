-- Create the current and next two monthly partitions for `messages`.
-- In production a scheduled job re-runs this logic ahead of time (SRS §7.3);
-- here it guarantees a freshly migrated database can accept a write today.
DO $$
DECLARE
  start_month DATE := date_trunc('month', now())::date;
  i INTEGER;
  from_date DATE;
  to_date   DATE;
  part_name TEXT;
BEGIN
  FOR i IN 0..2 LOOP
    from_date := (start_month + (i || ' month')::interval)::date;
    to_date   := (start_month + ((i + 1) || ' month')::interval)::date;
    part_name := 'messages_' || to_char(from_date, 'YYYY_MM');

    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF messages FOR VALUES FROM (%L) TO (%L)',
        part_name, from_date, to_date
      );
    END IF;
  END LOOP;
END $$;
