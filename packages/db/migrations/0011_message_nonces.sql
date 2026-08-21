-- Idempotent send, actually enforced.
--
-- FR-MSG-23 says a retry with the same nonce must never create a duplicate, and
-- 0001_init added `messages_nonce_idx` on (conversation_id, sender_id, nonce,
-- created_at) intending to be that guarantee. It is not one.
--
-- `messages` is RANGE-partitioned on created_at, and PostgreSQL requires a
-- unique index on a partitioned table to contain the partition key. So
-- created_at is in the tuple — and a retry one millisecond later has a
-- different created_at, does not collide, and inserts a second copy. The index
-- forbids only the exact case of two rows at the identical timestamp, which is
-- the one case a retry never produces.
--
-- The fix is a small unpartitioned claim table. A sender claims
-- (conversation, sender, nonce) before the message is written; the claim is
-- what is unique, and it hands back the id of the message the first attempt
-- produced. Retrying resolves to the original row instead of writing a new one.

CREATE TABLE IF NOT EXISTS message_nonces (
  conversation_id TEXT        NOT NULL,
  sender_id       TEXT        NOT NULL,
  nonce           TEXT        NOT NULL,
  message_id      TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, sender_id, nonce)
);

-- Nonces are only interesting for as long as a client might still retry.
-- A periodic sweep keeps this table proportional to recent traffic rather than
-- to all history; this index is what makes that sweep cheap.
CREATE INDEX IF NOT EXISTS message_nonces_created_idx ON message_nonces (created_at);

-- The old index stays. It is harmless, it still catches the exact-duplicate
-- case, and dropping a unique index from a live messages table buys nothing.
