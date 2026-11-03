-- Per-thread read state, and a corrected conversation unread count.
--
-- Until now a thread reply added one to every member's conversation badge,
-- but the client only ever marked read up to the newest *main-flow* message —
-- so a thread reply left the conversation showing "1" that no amount of
-- reading cleared. The rule is now the one Slack and Teams use:
--
--   * a conversation's badge counts main-flow messages only;
--   * a thread reply is new *for the people following that thread* — its
--     author, anyone who has replied, and anyone who has opened it — and is
--     tracked here, per person per thread;
--   * a reply also sent to the channel arrives as a main-flow message and
--     badges like one.

CREATE TABLE IF NOT EXISTS thread_reads (
  user_id         TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT        NOT NULL,
  root_id         TEXT        NOT NULL,
  last_read_seq   BIGINT      NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, root_id)
);

CREATE INDEX IF NOT EXISTS thread_reads_conversation_idx
  ON thread_reads (conversation_id, user_id);

-- Everyone who has already replied in a thread follows it, and has read it up
-- to their own latest reply.
INSERT INTO thread_reads (user_id, conversation_id, root_id, last_read_seq)
SELECT m.sender_id, m.conversation_id, m.thread_root_id, max(m.seq)
  FROM messages m
 WHERE m.thread_root_id IS NOT NULL AND m.deleted_at IS NULL AND m.type <> 'system'
   AND EXISTS (SELECT 1 FROM users u WHERE u.id = m.sender_id)
 GROUP BY m.sender_id, m.conversation_id, m.thread_root_id
ON CONFLICT (user_id, root_id) DO NOTHING;

-- Recount every member under the new rule. This is what clears the badges
-- that were stuck on "1" because of a thread reply.
UPDATE conversation_members m
   SET unread_count = (
         SELECT count(*) FROM messages x
          WHERE x.conversation_id = m.conversation_id
            AND x.seq > m.last_read_seq
            AND x.sender_id <> m.user_id
            AND x.deleted_at IS NULL
            AND x.type <> 'system'
            AND x.thread_root_id IS NULL),
       unread_mentions = (
         SELECT count(*) FROM message_mentions mm
          WHERE mm.conversation_id = m.conversation_id
            AND mm.user_id = m.user_id
            AND mm.seq > m.last_read_seq
            AND NOT EXISTS (
              SELECT 1 FROM messages t
               WHERE t.conversation_id = mm.conversation_id
                 AND t.seq = mm.seq AND t.thread_root_id IS NOT NULL))
 WHERE m.left_at IS NULL;

-- The sidebar preview belongs to the main flow too.
UPDATE conversations c
   SET last_message_at = latest.created_at,
       last_message_preview = latest.preview,
       last_message_sender = latest.sender_id
  FROM (
    SELECT DISTINCT ON (m.conversation_id)
           m.conversation_id, m.created_at, m.sender_id,
           CASE WHEN m.body IS NOT NULL THEN left(m.body, 200)
                WHEN jsonb_array_length(m.attachments) > 0 THEN '📎 Attachment'
                ELSE '' END AS preview
      FROM messages m
     WHERE m.deleted_at IS NULL AND m.thread_root_id IS NULL
     ORDER BY m.conversation_id, m.seq DESC
  ) latest
 WHERE c.id = latest.conversation_id
   -- Only rows whose preview is currently a thread reply; everything else
   -- keeps its stored (name-resolved) preview untouched.
   AND c.last_message_at IS DISTINCT FROM latest.created_at;
