/**
 * Runs in every test worker before its file. Tags the worker's database
 * connections with its OS pid (pg reads PGAPPNAME), so pg_stat_activity and
 * the Postgres log can tell which test process ran a statement — the tool for
 * chasing a failure that only shows up in a full run.
 */
process.env.PGAPPNAME = `vt-${process.pid}`;

// Tests clear the audit log between cases. The database refuses that from the
// app (0039, append-only); a test worker is a maintenance session.
process.env.PGOPTIONS = `${process.env.PGOPTIONS ?? ''} -c tupo.audit_maintenance=on`.trim();
