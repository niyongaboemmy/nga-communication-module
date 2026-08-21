/**
 * Tear down the users a gate created, and everything hanging off them.
 *
 * This exists because the obvious version is wrong in a way that is invisible
 * until you look at the users table weeks later. Cleanup used to run
 *
 *   DELETE FROM conversations WHERE ...;
 *   DELETE FROM users WHERE ...;
 *
 * inside a `finally`. If any of those conversations still had messages, the
 * first statement failed on the foreign key, the `finally` threw, and the
 * second statement never ran — so every interrupted gate run leaked its whole
 * cast of users. Six accounts all called "Aline Uwase" in the people picker is
 * what that looks like from the outside.
 *
 * So: delete in dependency order, and run each step in its own try/catch. A
 * cleanup step that fails must never prevent the remaining steps, and must
 * never mask the real error the test was reporting.
 */
export async function purgeUsers(pool, ids, { quiet = false } = {}) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return;

  const { rows } = await pool.query(
    `SELECT DISTINCT c.id FROM conversations c
      WHERE c.created_by = ANY($1::text[])
         OR c.id IN (SELECT conversation_id FROM conversation_members WHERE user_id = ANY($1::text[]))`,
    [list],
  ).catch(() => ({ rows: [] }));
  const convs = rows.map((r) => r.id);

  const steps = [
    // Children of messages first, then messages, then the conversation.
    ['message_reactions', 'DELETE FROM message_reactions WHERE conversation_id = ANY($1::text[])', convs],
    ['message_mentions', 'DELETE FROM message_mentions WHERE conversation_id = ANY($1::text[])', convs],
    ['message_receipts', 'DELETE FROM message_receipts WHERE conversation_id = ANY($1::text[])', convs],
    ['message_saves', 'DELETE FROM message_saves WHERE conversation_id = ANY($1::text[])', convs],
    // message_edits is keyed on the message alone, not the conversation.
    ['message_edits', `DELETE FROM message_edits WHERE message_id IN (
         SELECT id FROM messages WHERE conversation_id = ANY($1::text[]))`, convs],
    ['message_attachments', 'DELETE FROM message_attachments WHERE conversation_id = ANY($1::text[])', convs],
    ['message_links', 'DELETE FROM message_links WHERE conversation_id = ANY($1::text[])', convs],
    ['message_translations',
      `DELETE FROM message_translations WHERE message_id IN (
         SELECT id FROM messages WHERE conversation_id = ANY($1::text[]))`, convs],
    ['poll_votes', `DELETE FROM poll_votes WHERE poll_id IN (
         SELECT id FROM polls WHERE conversation_id = ANY($1::text[]))`, convs],
    ['polls', 'DELETE FROM polls WHERE conversation_id = ANY($1::text[])', convs],
    ['scheduled_messages', 'DELETE FROM scheduled_messages WHERE conversation_id = ANY($1::text[])', convs],
    ['message_nonces', 'DELETE FROM message_nonces WHERE conversation_id = ANY($1::text[])', convs],
    ['messages', 'DELETE FROM messages WHERE conversation_id = ANY($1::text[])', convs],
    ['conversation_invites', 'DELETE FROM conversation_invites WHERE conversation_id = ANY($1::text[])', convs],
    ['conversation_members', 'DELETE FROM conversation_members WHERE conversation_id = ANY($1::text[])', convs],
    ['conversations', 'DELETE FROM conversations WHERE id = ANY($1::text[])', convs],
    // Anything keyed on the user rather than a conversation.
    ['conversation_members (by user)', 'DELETE FROM conversation_members WHERE user_id = ANY($1::text[])', list],
    ['user_blocks', 'DELETE FROM user_blocks WHERE blocker_id = ANY($1::text[]) OR blocked_id = ANY($1::text[])', list],
    ['user_chat_prefs', 'DELETE FROM user_chat_prefs WHERE user_id = ANY($1::text[])', list],
    ['notifications', 'DELETE FROM notifications WHERE user_id = ANY($1::text[])', list],
    ['users', 'DELETE FROM users WHERE id = ANY($1::text[])', list],
  ];

  for (const [label, sql, params] of steps) {
    if (!params.length) continue;
    try {
      await pool.query(sql, [params]);
    } catch (err) {
      // Report and carry on. A missing table or a stray reference must not
      // stop the users themselves from being removed.
      if (!quiet) console.error(`  · cleanup: ${label} — ${err.message.split('\n')[0]}`);
    }
  }
}
