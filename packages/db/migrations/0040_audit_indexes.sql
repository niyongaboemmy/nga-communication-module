-- migrate:no-transaction
-- F-13: the audit screen pages newest-first and filters by target. Built
-- CONCURRENTLY so writes (every sign-in, every moderation action) carry on
-- while the index builds on a large production table.

CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC, id DESC);
-- statement-break
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_target_idx ON audit_log (target_type, target_id, created_at DESC);
