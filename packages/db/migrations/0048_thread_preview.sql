-- Thread previews (chat experience plan, Phase 4: R-02, R-03).
--
-- Under a message with replies the channel shows who replied and the latest
-- reply ("Didier and 2 others replied · 5 replies"), without opening the
-- thread. Both are kept on the root row, recomputed from the replies whenever
-- one is sent, edited or deleted (refreshThreadPreview), so a page of messages
-- needs no extra query and a deleted reply never lingers in a preview.
--
--   thread_participants  the last 3 distinct repliers, newest first:
--                        [{ "id", "name", "avatarUrl" }]
--   thread_latest        the newest live reply:
--                        { "senderId", "senderName", "body" (≤140), "hasAttachment", "at" }
--
-- PostgreSQL 16 (required since 0046): a constant default is metadata-only, so
-- adding the columns does not rewrite the message partitions.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_participants JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_latest JSONB;

-- Backfill every existing thread root, across schools (a data fix that spans
-- tenants says so; see migrate.ts).
SET LOCAL ROLE tupo_platform;

WITH roots AS (
  SELECT DISTINCT r.conversation_id, r.thread_root_id AS root_id
    FROM messages r
   WHERE r.thread_root_id IS NOT NULL AND r.deleted_at IS NULL
)
UPDATE messages root
   SET thread_participants = COALESCE((
         SELECT jsonb_agg(jsonb_build_object('id', k.sender_id, 'name', COALESCE(u.name, 'Someone'), 'avatarUrl', u.avatar_url)
                          ORDER BY k.last_seq DESC)
           FROM (SELECT r.sender_id, max(r.seq) AS last_seq
                   FROM messages r
                  WHERE r.thread_root_id = root.id AND r.conversation_id = root.conversation_id
                    AND r.deleted_at IS NULL
                  GROUP BY r.sender_id
                  ORDER BY max(r.seq) DESC
                  LIMIT 3) k
           LEFT JOIN users u ON u.id = k.sender_id
       ), '[]'::jsonb),
       thread_latest = (
         SELECT jsonb_build_object(
                  'senderId', r.sender_id, 'senderName', COALESCE(u.name, 'Someone'),
                  'body', left(COALESCE(r.body, ''), 140),
                  'hasAttachment', jsonb_array_length(COALESCE(r.attachments, '[]'::jsonb)) > 0,
                  'at', r.created_at)
           FROM messages r
           LEFT JOIN users u ON u.id = r.sender_id
          WHERE r.thread_root_id = root.id AND r.conversation_id = root.conversation_id
            AND r.deleted_at IS NULL
          ORDER BY r.seq DESC
          LIMIT 1)
  FROM roots
 WHERE root.conversation_id = roots.conversation_id AND root.id = roots.root_id;

RESET ROLE;
