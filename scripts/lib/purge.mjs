import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES_APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/files');

/** The files service's local storage root, read from its own .env. */
function localStorageRoot() {
  try {
    const line = readFileSync(`${FILES_APP}/.env`, 'utf8').split('\n').find((l) => l.startsWith('LOCAL_STORAGE_PATH='));
    return resolve(FILES_APP, (line?.slice('LOCAL_STORAGE_PATH='.length).trim() || './storage').replace(/^["']|["']$/g, ''));
  } catch {
    return resolve(FILES_APP, './storage');
  }
}

/** Delete the bytes behind a gate's uploads (local driver), never outside the root. */
async function removeBlobs(files, quiet) {
  const root = localStorageRoot();
  for (const f of files) {
    if (f.storage_driver !== 'local' || !f.storage_key) continue;
    const path = resolve(root, f.storage_key);
    if (!path.startsWith(root + sep)) continue;
    await rm(path, { force: true }).catch((err) => { if (!quiet) console.error(`  · cleanup: blob ${f.storage_key} — ${err.message}`); });
  }
}

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

  // Feed pages a gate created are not removed with their creator (the key is
  // SET NULL so real pages outlive staff who leave) — so they are named here.
  const pages = (await pool.query(
    'SELECT id FROM feed_pages WHERE created_by = ANY($1::text[])', [list],
  ).catch(() => ({ rows: [] }))).rows.map((r) => r.id);
  // Same for mail threads, lists, templates and campaigns.
  const threads = (await pool.query(
    'SELECT id FROM mail_threads WHERE created_by = ANY($1::text[])', [list],
  ).catch(() => ({ rows: [] }))).rows.map((r) => r.id);
  // Uploaded files block deleting their owner (files.owner_id has no cascade).
  const files = (await pool.query(
    'SELECT id, storage_driver, storage_key FROM files WHERE owner_id = ANY($1::text[])', [list],
  ).catch(() => ({ rows: [] }))).rows;

  const postsOf = `SELECT id FROM feed_posts WHERE page_id = ANY($1::text[])`;
  const steps = [
    // ── Feed pages the gate created, with everything on them.
    ['feed_comment_reactions', `DELETE FROM feed_comment_reactions WHERE comment_id IN (
         SELECT id FROM feed_comments WHERE post_id IN (${postsOf}))`, pages],
    ...['feed_reactions', 'feed_poll_votes', 'feed_event_rsvps', 'feed_post_views',
      'feed_bookmarks', 'feed_timeline', 'feed_post_edits', 'feed_reports'].map((t) =>
      [t, `DELETE FROM ${t} WHERE post_id IN (${postsOf})`, pages]),
    ['feed_comments', `DELETE FROM feed_comments WHERE post_id IN (${postsOf})`, pages],
    ['feed_posts', 'DELETE FROM feed_posts WHERE page_id = ANY($1::text[])', pages],
    ['feed_page_editors', 'DELETE FROM feed_page_editors WHERE page_id = ANY($1::text[])', pages],
    ['feed_page_followers', 'DELETE FROM feed_page_followers WHERE page_id = ANY($1::text[])', pages],
    ['feed_pages', 'DELETE FROM feed_pages WHERE id = ANY($1::text[])', pages],
    // ── Mail the gate wrote.
    ['mail_threads', 'DELETE FROM mail_threads WHERE id = ANY($1::text[])', threads],
    ['mail_campaigns', 'DELETE FROM mail_campaigns WHERE created_by = ANY($1::text[])', list],
    ['mail_distribution_lists', 'DELETE FROM mail_distribution_lists WHERE created_by = ANY($1::text[])', list],
    ['mail_templates', 'DELETE FROM mail_templates WHERE created_by = ANY($1::text[])', list],
    // ── Their seats in other people's meetings (SET NULL would leave ghosts).
    ['meeting_participants', 'DELETE FROM meeting_participants WHERE user_id = ANY($1::text[])', list],
    // ── Reports and session state.
    ['user_reports', 'DELETE FROM user_reports WHERE reporter_id = ANY($1::text[]) OR reported_user_id = ANY($1::text[])', list],
    ['session_revocations', 'DELETE FROM session_revocations WHERE user_id = ANY($1::text[])', list],
    ['files', 'DELETE FROM files WHERE id = ANY($1::text[])', files.map((f) => f.id)],
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

  await removeBlobs(files, quiet);

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

/** Purge every user whose id starts with `prefix` — for gates that tag their cast. */
export async function purgeUsersLike(pool, prefix, opts) {
  const { rows } = await pool.query('SELECT id FROM users WHERE id LIKE $1', [`${prefix.replace(/[%_]/g, '\\$&')}%`])
    .catch(() => ({ rows: [] }));
  await purgeUsers(pool, rows.map((r) => r.id), opts);
  return rows.length;
}

/** Every id prefix a gate or probe uses, for the clean-up sweep. */
export const TEST_USER_PREFIXES = [
  'chatadm-', 'chatfile-', 'chatlive-', 'chatnot-', 'chatpow-', 'chattest-', 'chatthr-', 'chatui-',
  'feedmedia-', 'feedtest-', 'feedui-', 'mailtest-', 'mailui-', 'meetverify-', 'uiverify-', 'ntest-',
  'oversight-', 'pj-', 'pres-', 'v3-', 'vcl-', 'vcs-', 'vcu-', 'vcv-', 'vfa-', 'vmr-', 'vrr-',
  'vnc-', 'vnv-', 'vlf-', 'vmo-', 'vmd-', 'vop-', 'vsy-', 'vpu-', 'vle-', 'vax-', 'vss-', 'vst-', 'vad-', 'gap2-', 'gapc-', 'gapp-', 'gapr-', 'gaps-', 'gapu-', 'gapx-', 'suix-',
];
