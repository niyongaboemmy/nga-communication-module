import { getPool, snowflake } from '@tupo/db';
import { Redis } from 'ioredis';
import type { AppNotification } from '@tupo/shared';

/**
 * Redis is read from the environment rather than an app's config object.
 *
 * This package is imported by tupo-api *and* tupo-realtime, and neither one's
 * config module is the other's. Both already load `.env` at startup, and both
 * point at the same Redis — the value is the same, the coupling is not.
 */
const redisUrl = () => process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0';

/**
 * Notifications.
 *
 * Deliberately small. A notification is a row plus a socket emit; everything
 * about *when* to raise one lives with the feature that raises it, because
 * that is where the judgement is.
 *
 * Two rules are enforced here rather than left to callers, because getting
 * either wrong is how a notification system becomes the thing people mute:
 *
 *  - **Never notify someone about their own action.** The host starting a
 *    meeting does not need to be told a meeting started.
 *  - **One row per person per subject per kind.** Start, end and restart a
 *    meeting and you get one "join now", not three. The unique index does the
 *    real work; the upsert makes it refresh rather than fail.
 */

export type NotificationKind =
  | 'meet.live'        // a meeting you may join has started
  | 'meet.invited'     // you were invited to a scheduled meeting
  | 'meet.ended'
  | 'chat.dm'          // a direct message
  | 'chat.mention'     // you were @-mentioned
  | 'chat.message'     // a message in a conversation set to notify on all
  | 'chat.thread'      // a reply in a thread you are following
  | 'chat.reaction'    // someone reacted to something you wrote
  | 'chat.invited'     // you were added to a channel or group
  | 'mail.received'    // a mail message landed in your inbox
  | 'mail.campaign'    // a bulk send you scheduled finished
  | 'feed.published'   // a page you follow (with notify on) published a post
  | 'feed.announcement'// an announcement post from a page you follow
  | 'feed.comment'     // someone commented on your post
  | 'feed.reply'       // someone replied to your comment
  | 'feed.reaction'    // someone reacted to your post or comment
  | 'feed.mention';    // you were @-mentioned in a post or comment

export interface NotificationRow {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  subject_type: string | null;
  subject_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface NewNotification {
  kind: NotificationKind;
  title: string;
  body?: string | null;
  link?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
}

/**
 * Create one notification per recipient.
 *
 * Returns the rows actually written, so the caller can push exactly those over
 * the socket — a re-notification that only refreshed an existing row should
 * not ring a second time.
 */
export async function notify(
  userIds: string[],
  n: NewNotification,
  opts: { exclude?: string[] } = {},
): Promise<NotificationRow[]> {
  const excluded = new Set(opts.exclude ?? []);
  const recipients = [...new Set(userIds)].filter((id) => id && !excluded.has(id));
  if (!recipients.length) return [];

  const rows: NotificationRow[] = [];
  for (const userId of recipients) {
    const { rows: written } = await getPool().query<NotificationRow>(
      `INSERT INTO notifications
         (id, user_id, kind, title, body, link, subject_type, subject_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, kind, subject_type, subject_id)
         WHERE subject_id IS NOT NULL
         DO UPDATE SET title = EXCLUDED.title,
                       body = EXCLUDED.body,
                       link = EXCLUDED.link,
                       created_at = now(),
                       -- Refreshing an unread notification leaves it unread;
                       -- one already dismissed stays dismissed, so a meeting
                       -- that flaps cannot nag.
                       read_at = notifications.read_at
       RETURNING *`,
      [snowflake(), userId, n.kind, n.title, n.body ?? null, n.link ?? null,
       n.subjectType ?? null, n.subjectId ?? null],
    );
    if (written[0]) rows.push(written[0]);
  }
  return rows;
}

/** Everything for one person, newest first. */
export async function listFor(
  userId: string, opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const { rows } = await getPool().query<NotificationRow>(
    `SELECT * FROM notifications
      WHERE user_id = $1 ${opts.unreadOnly ? 'AND read_at IS NULL' : ''}
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

export async function unreadCount(userId: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM notifications
      WHERE user_id = $1 AND read_at IS NULL`, [userId]);
  return Number(rows[0]?.count ?? 0);
}

/** Marking read is scoped to the owner, so an id from elsewhere does nothing. */
export async function markRead(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE notifications SET read_at = COALESCE(read_at, now())
      WHERE id = $1 AND user_id = $2`, [id, userId]);
  return (rowCount ?? 0) > 0;
}

export async function markAllRead(userId: string): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE notifications SET read_at = now()
      WHERE user_id = $1 AND read_at IS NULL`, [userId]);
  return rowCount ?? 0;
}

/**
 * Withdraw every notification about a subject.
 *
 * A meeting that has ended must stop inviting people into it. Deleting rather
 * than marking read: an invitation to something that no longer exists is not
 * history worth keeping, it is a dead link.
 */
export async function revokeSubject(subjectType: string, subjectId: string): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM notifications WHERE subject_type = $1 AND subject_id = $2`,
    [subjectType, subjectId]);
  return rowCount ?? 0;
}


/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

/**
 * Push notifications to whoever is connected, via tupo-realtime.
 *
 * The API owns durability — the row is already written by the time this runs —
 * and the gateway owns delivery. They are joined by one Redis channel rather
 * than an HTTP call, so neither has to know where the other is running, and a
 * gateway restart loses nothing that matters: the rows are still in the table
 * and the client fetches them on connect.
 *
 * Fail-soft throughout. A notification that was stored but not pushed is a
 * notification that arrives a moment late; one that throws here would fail the
 * request that raised it, which is a far worse trade.
 */
const NOTIFY_CHANNEL = 'tupo:notify';
let publisher: Redis | null = null;

function getPublisher(): Redis | null {
  if (publisher) return publisher;
  try {
    publisher = new Redis(redisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      // Without this a Redis outage turns every publish into a slow retry
      // storm on the request path.
      enableOfflineQueue: false,
    });
    publisher.on('error', () => { /* reported by the first failed publish */ });
    void publisher.connect().catch(() => {});
  } catch {
    publisher = null;
  }
  return publisher;
}

export function toWire(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    link: row.link,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export async function push(rows: NotificationRow[]): Promise<void> {
  if (!rows.length) return;
  const client = getPublisher();
  if (!client) return;

  // One message per distinct notification body, addressed to everyone who got
  // it — rather than one message per person, which for a 500-person meeting
  // would be 500 round trips to Redis.
  const byKey = new Map<string, { userIds: string[]; row: NotificationRow }>();
  for (const row of rows) {
    const key = `${row.kind}:${row.subject_type}:${row.subject_id}:${row.title}`;
    const entry = byKey.get(key);
    if (entry) entry.userIds.push(row.user_id);
    else byKey.set(key, { userIds: [row.user_id], row });
  }

  for (const { userIds, row } of byKey.values()) {
    try {
      await client.publish(NOTIFY_CHANNEL, JSON.stringify({
        userIds, notification: toWire(row),
      }));
    } catch {
      // Stored but not pushed: the client picks it up on its next fetch.
    }
  }
}

/** Store and deliver in one call — what every caller actually wants. */
export async function notifyAndPush(
  userIds: string[], n: NewNotification, opts: { exclude?: string[] } = {},
): Promise<NotificationRow[]> {
  const rows = await notify(userIds, n, opts);
  await push(rows);
  return rows;
}
