-- F-13 / ADM-01: the audit log is append-only.
--
-- Nothing in Tupo updates or deletes audit rows, and the screen has always
-- said so; now the database holds the application to it. An UPDATE, DELETE
-- or TRUNCATE is refused unless the session has deliberately switched on
-- maintenance (SET tupo.audit_maintenance = 'on'), which is what a retention
-- job or the test suite does — never the running app. It guards against a
-- bug or a compromised code path rewriting history, not against someone who
-- already holds the database owner's password.

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('tupo.audit_maintenance', true), '') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'SET tupo.audit_maintenance = ''on'' in a maintenance session to prune.';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_no_rewrite ON audit_log;
CREATE TRIGGER audit_log_no_rewrite
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
