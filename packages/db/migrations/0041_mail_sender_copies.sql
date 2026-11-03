-- C-08: the sender's own copy of each message they sent, as a 'self' row in
-- Sent, so a conversation the person only wrote in can be starred, labelled,
-- trashed and restored like any other. Backfilled for mail already sent;
-- someone who wrote to themselves already has a received copy and gets none.
INSERT INTO mail_recipients
  (id, message_id, thread_id, kind, user_id, address, name, merge_vars, channel, delivery_status,
   folder, is_read, read_at, pending, created_at)
SELECT 's' || m.id, m.id, m.thread_id, 'self', m.from_user_id, COALESCE(m.from_address, ''), COALESCE(m.from_name, ''),
       '{}'::jsonb, 'self', 'none', 'sent', true, COALESCE(m.sent_at, m.created_at), false, COALESCE(m.sent_at, m.created_at)
  FROM mail_messages m
 WHERE m.from_user_id IS NOT NULL
   AND NOT m.is_draft
   AND m.sent_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id AND r.user_id = m.from_user_id)
ON CONFLICT (id) DO NOTHING;
