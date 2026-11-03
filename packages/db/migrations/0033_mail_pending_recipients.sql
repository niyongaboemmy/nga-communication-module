-- Mail that has not been sent is invisible to its recipients (C-03).
--
-- Drafts and scheduled messages create their recipient rows up front (the
-- composer autosaves them; the scheduler needs them at send time), and every
-- mailbox query read those rows — so a half-written subject or an embargoed
-- message showed up in the recipient's inbox immediately. A row is now
-- `pending` until its message is actually sent, and nothing a recipient sees
-- reads pending rows.

ALTER TABLE mail_recipients ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT false;

UPDATE mail_recipients r
   SET pending = true
  FROM mail_messages m
 WHERE m.id = r.message_id
   AND m.campaign_id IS NULL
   AND (m.is_draft OR m.sent_at IS NULL);

-- Thread summaries were also written at compose time; rebuild them from sent
-- messages only, so an unsent subject or snippet stops showing.
UPDATE mail_threads t
   SET last_message_at = s.sent_at,
       last_sender_id = s.from_user_id,
       last_sender_name = s.from_name,
       last_snippet = s.snippet,
       message_count = s.n
  FROM (
    SELECT DISTINCT ON (m.thread_id)
           m.thread_id, m.sent_at, m.from_user_id, m.from_name, m.snippet,
           count(*) OVER (PARTITION BY m.thread_id) AS n
      FROM mail_messages m
     WHERE NOT m.is_draft AND m.sent_at IS NOT NULL
     ORDER BY m.thread_id, m.sent_at DESC
  ) s
 WHERE t.id = s.thread_id
   AND (t.last_message_at IS DISTINCT FROM s.sent_at OR t.message_count IS DISTINCT FROM s.n);

CREATE INDEX IF NOT EXISTS mail_recipients_pending_idx ON mail_recipients (message_id) WHERE pending;
