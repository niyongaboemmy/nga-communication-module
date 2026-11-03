-- CHAT-M7 / Q-01: get, edit, delete, react, pin and context all find a message
-- by (conversation_id, id). The primary key is (conversation_id, seq,
-- created_at), so each of those walked the whole conversation in every
-- partition and filtered on id.
--
-- Not CONCURRENTLY: PostgreSQL cannot build a partitioned table's index that
-- way. At school scale the build takes seconds; partitions created later by
-- the maintenance job inherit it.
CREATE INDEX IF NOT EXISTS messages_conv_id_idx ON messages (conversation_id, id);
