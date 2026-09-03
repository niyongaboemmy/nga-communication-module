/**
 * Tupo Mail — the mailbox domain.
 *
 * Lives in a package because both tupo-api (every read and the compose path)
 * and tupo-worker (scheduled sends, campaigns, SMTP dispatch) need it, and the
 * authorisation that decides who may read a thread must not exist in only one
 * of them.
 *
 * The model:
 *   · a `mail_messages` row is the sender's copy (Sent / Drafts / Scheduled)
 *   · a `mail_recipients` row is each recipient's copy AND their delivery record
 *   · a `mail_threads` row groups them by normalised subject (FR-MAIL-2)
 */
import type { PoolClient } from 'pg';
import { getPool, snowflake } from '@tupo/db';
import {
  MAIL_MAX_BODY_HTML, MAIL_MAX_RECIPIENTS, MAIL_MAX_SUBJECT, MAIL_MAX_PAGE_SIZE, MAIL_PAGE_SIZE,
  normalizeSubject,
} from '@tupo/shared';
import type {
  MailComposePayload, MailFolder, MailMessageView, MailPerson, MailPrefs, MailThreadSummary,
  MailThreadView, MailLabel, MailboxCounts, MailRecipientDelivery, MailAttachment,
} from '@tupo/shared';
import { MailError } from './errors.js';
import { internalEmailDelivery } from './config.js';
import { htmlToText, snippetOf, isEmailAddress } from './render.js';
import { deliverInApp, isSuppressed, recordEvent } from './delivery.js';

/* ────────────────────────────────────────────────────────────────────────── *
 * Helpers
 * ────────────────────────────────────────────────────────────────────────── */

function attachmentKind(mime: string): MailAttachment['kind'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (/pdf|word|excel|spreadsheet|presentation|text|document|csv/i.test(mime)) return 'document';
  return 'other';
}

interface ResolvedRecipient {
  kind: 'to' | 'cc' | 'bcc';
  userId: string | null;
  address: string;
  name: string;
  channel: 'in_app' | 'smtp';
}

/**
 * Turn the composer's recipient strings into rows.
 *
 * Each input is either `userId:<snowflake>` (from the people-picker) or a bare
 * email address. A resolved Tupo user is delivered in-app (FR-MAIL-9) unless
 * they opted into email copies, in which case they get an SMTP row too.
 */
async function resolveRecipients(
  db: PoolClient, inputs: string[] | undefined, kind: 'to' | 'cc' | 'bcc',
): Promise<ResolvedRecipient[]> {
  const out: ResolvedRecipient[] = [];
  const seen = new Set<string>();
  const instanceEmailDefault = internalEmailDelivery();

  // An internal recipient gets an SMTP copy when the instance default is on and
  // they have not opted out — or when they have opted in regardless. `copies`
  // is NULL when the user has never touched mail settings.
  const wantsEmail = (copies: boolean | null): boolean =>
    copies === null ? instanceEmailDefault : copies;

  for (const raw of inputs ?? []) {
    const value = raw.trim();
    if (!value) continue;

    if (value.startsWith('userId:')) {
      const id = value.slice(7);
      const { rows } = await db.query<{ id: string; name: string; email: string; copies: boolean | null }>(
        `SELECT u.id, u.name, u.email, p.email_copies AS copies
           FROM users u LEFT JOIN mail_prefs p ON p.user_id = u.id
          WHERE u.id = $1 AND u.status = 'active'`, [id],
      );
      const u = rows[0];
      if (!u) throw new MailError(`Recipient not found: ${id}`, 400);
      const key = `u:${u.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, userId: u.id, address: u.email || `${u.id}@tupo.local`, name: u.name, channel: 'in_app' });
      if (wantsEmail(u.copies) && isEmailAddress(u.email)) {
        out.push({ kind, userId: u.id, address: u.email, name: u.name, channel: 'smtp' });
      }
      continue;
    }

    if (!isEmailAddress(value)) throw new MailError(`Not a valid address: ${value}`, 400);
    const addr = value.toLowerCase();
    // An address that belongs to a Tupo user routes in-app; it also gets a real
    // email when the instance default (or that user's preference) calls for it.
    const { rows } = await db.query<{ id: string; name: string; copies: boolean | null }>(
      `SELECT u.id, u.name, p.email_copies AS copies
         FROM users u LEFT JOIN mail_prefs p ON p.user_id = u.id
        WHERE lower(u.email) = $1 AND u.status = 'active' LIMIT 1`, [addr],
    );
    const key = `a:${addr}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (rows[0]) {
      out.push({ kind, userId: rows[0].id, address: addr, name: rows[0].name, channel: 'in_app' });
      if (wantsEmail(rows[0].copies)) {
        out.push({ kind, userId: rows[0].id, address: addr, name: rows[0].name, channel: 'smtp' });
      }
    } else {
      out.push({ kind, userId: null, address: addr, name: value.split('@')[0] ?? value, channel: 'smtp' });
    }
  }
  return out;
}

async function personById(db: PoolClient, userId: string): Promise<{ name: string; email: string }> {
  const { rows } = await db.query<{ name: string; email: string }>(
    'SELECT name, email FROM users WHERE id = $1', [userId],
  );
  if (!rows[0]) throw new MailError('Sender not found.', 404);
  return rows[0];
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Preferences
 * ────────────────────────────────────────────────────────────────────────── */

export async function getPrefs(userId: string): Promise<MailPrefs> {
  const { rows } = await getPool().query<{
    display_name: string | null; signature_html: string; signature_enabled: boolean; email_copies: boolean;
  }>(
    `SELECT display_name, signature_html, signature_enabled, email_copies
       FROM mail_prefs WHERE user_id = $1`, [userId],
  );
  const p = rows[0];
  const instanceDefault = internalEmailDelivery();
  return {
    displayName: p?.display_name ?? null,
    signatureHtml: p?.signature_html ?? '',
    signatureEnabled: p?.signature_enabled ?? false,
    // The effective value: an explicit preference, or the instance default.
    emailCopies: p?.email_copies ?? instanceDefault,
    // Whether real-email delivery is switched on for this deployment at all —
    // when false, the per-user toggle does nothing and the UI says so.
    emailDeliveryAvailable: instanceDefault,
  };
}

export async function updatePrefs(userId: string, patch: Partial<MailPrefs>): Promise<MailPrefs> {
  const cur = await getPrefs(userId);
  const next = { ...cur, ...patch };
  await getPool().query(
    `INSERT INTO mail_prefs (user_id, display_name, signature_html, signature_enabled, email_copies, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       signature_html = EXCLUDED.signature_html,
       signature_enabled = EXCLUDED.signature_enabled,
       email_copies = EXCLUDED.email_copies,
       updated_at = now()`,
    [userId, next.displayName, next.signatureHtml.slice(0, 20_000), next.signatureEnabled, next.emailCopies],
  );
  return next;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Labels
 * ────────────────────────────────────────────────────────────────────────── */

export async function listLabels(userId: string): Promise<MailLabel[]> {
  const { rows } = await getPool().query<{
    id: string; name: string; color: string; ordinal: number; is_system: boolean; unread: string;
  }>(
    `SELECT l.id, l.name, l.color, l.ordinal, l.is_system,
            COALESCE((
              SELECT count(*) FROM mail_recipients r
               WHERE r.user_id = $1 AND NOT r.is_read AND r.folder = 'inbox' AND NOT r.is_hidden
                 AND r.labels ? l.id
            ), 0)::text AS unread
       FROM mail_labels l
      WHERE l.owner_id IS NULL OR l.owner_id = $1
      ORDER BY l.is_system DESC, l.ordinal, l.name`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, color: r.color, ordinal: r.ordinal,
    isSystem: r.is_system, unread: Number(r.unread),
  }));
}

export async function createLabel(userId: string, name: string, color: string): Promise<MailLabel> {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new MailError('A label needs a name.');
  try {
    const { rows } = await getPool().query<{ id: string; ordinal: number }>(
      `INSERT INTO mail_labels (id, owner_id, name, color, ordinal)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(ordinal), 0) + 1 FROM mail_labels WHERE owner_id = $2))
       RETURNING id, ordinal`,
      [snowflake(), userId, clean, color || '#6366f1'],
    );
    return { id: rows[0]!.id, name: clean, color: color || '#6366f1', ordinal: rows[0]!.ordinal, isSystem: false, unread: 0 };
  } catch {
    throw new MailError('You already have a label with that name.', 409);
  }
}

export async function deleteLabel(userId: string, labelId: string): Promise<void> {
  const { rowCount } = await getPool().query(
    `DELETE FROM mail_labels WHERE id = $1 AND owner_id = $2`, [labelId, userId],
  );
  if (!rowCount) throw new MailError('Label not found.', 404);
  await getPool().query(
    `UPDATE mail_recipients SET labels = labels - $1 WHERE user_id = $2 AND labels ? $1`,
    [labelId, userId],
  );
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Mailbox listing
 * ────────────────────────────────────────────────────────────────────────── */

export async function mailboxCounts(userId: string): Promise<MailboxCounts> {
  const { rows } = await getPool().query<{
    inbox: string; starred: string; drafts: string; scheduled: string;
  }>(
    `SELECT
       (SELECT count(*) FROM mail_recipients r
         WHERE r.user_id = $1 AND NOT r.is_read AND r.folder = 'inbox' AND NOT r.is_hidden)::text AS inbox,
       (SELECT count(*) FROM mail_recipients r
         WHERE r.user_id = $1 AND r.is_starred AND NOT r.is_hidden)::text AS starred,
       (SELECT count(*) FROM mail_messages m
         WHERE m.from_user_id = $1 AND m.is_draft)::text AS drafts,
       (SELECT count(*) FROM mail_messages m
         WHERE m.from_user_id = $1 AND NOT m.is_draft AND m.scheduled_at IS NOT NULL AND m.sent_at IS NULL)::text AS scheduled`,
    [userId],
  );
  const r = rows[0]!;
  return { inbox: Number(r.inbox), starred: Number(r.starred), drafts: Number(r.drafts), scheduled: Number(r.scheduled) };
}

interface ListOpts {
  folder: MailFolder;
  labelId?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

/**
 * A mailbox folder as a list of threads.
 *
 * Inbox/Archive/Trash/Spam/Starred read the viewer's `mail_recipients` rows;
 * Sent/Drafts/Scheduled read the viewer's `mail_messages` rows. Either way the
 * unit is a thread and the newest message in it wins the summary.
 */
export async function listThreads(userId: string, opts: ListOpts): Promise<{
  threads: MailThreadSummary[]; nextCursor: string | null;
}> {
  const limit = Math.min(Math.max(opts.limit ?? MAIL_PAGE_SIZE, 1), MAIL_MAX_PAGE_SIZE);
  const db = getPool();
  const senderFolders: MailFolder[] = ['sent', 'drafts', 'scheduled'];
  const like = opts.q ? `%${opts.q.replace(/[%_]/g, '\\$&')}%` : null;

  let threadIds: Array<{ thread_id: string; sort_at: string }>;

  if (senderFolders.includes(opts.folder)) {
    const cond =
      opts.folder === 'drafts' ? 'm.is_draft'
      : opts.folder === 'scheduled' ? 'NOT m.is_draft AND m.scheduled_at IS NOT NULL AND m.sent_at IS NULL'
      : 'NOT m.is_draft AND (m.scheduled_at IS NULL OR m.sent_at IS NOT NULL)';
    const { rows } = await db.query<{ thread_id: string; sort_at: string }>(
      `SELECT DISTINCT ON (m.thread_id) m.thread_id,
              COALESCE(m.sent_at, m.updated_at) AS sort_at
         FROM mail_messages m
        WHERE m.from_user_id = $1 AND ${cond}
          AND ($2::text IS NULL OR m.subject ILIKE $2 OR m.body_text ILIKE $2)
          AND ($3::timestamptz IS NULL OR COALESCE(m.sent_at, m.updated_at) < $3::timestamptz)
        ORDER BY m.thread_id, sort_at DESC`,
      [userId, like, opts.cursor ?? null],
    );
    threadIds = rows.sort((a, b) => (a.sort_at < b.sort_at ? 1 : -1)).slice(0, limit + 1);
  } else {
    const folderCond =
      opts.folder === 'starred' ? `r.is_starred AND r.folder <> 'trash'`
      : `r.folder = '${opts.folder}'`;
    const { rows } = await db.query<{ thread_id: string; sort_at: string }>(
      `SELECT DISTINCT ON (r.thread_id) r.thread_id, t.last_message_at AS sort_at
         FROM mail_recipients r
         JOIN mail_threads t ON t.id = r.thread_id
        WHERE r.user_id = $1 AND NOT r.is_hidden AND ${folderCond}
          AND ($2::text IS NULL OR $2 = ANY(SELECT jsonb_array_elements_text(r.labels)))
          AND ($3::text IS NULL OR t.subject ILIKE $3 OR t.last_snippet ILIKE $3)
          AND ($4::timestamptz IS NULL OR t.last_message_at < $4::timestamptz)
        ORDER BY r.thread_id, t.last_message_at DESC`,
      [userId, opts.labelId ?? null, like, opts.cursor ?? null],
    );
    threadIds = rows.sort((a, b) => (a.sort_at < b.sort_at ? 1 : -1)).slice(0, limit + 1);
  }

  const hasMore = threadIds.length > limit;
  const page = threadIds.slice(0, limit);
  const nextCursor = hasMore ? page[page.length - 1]!.sort_at : null;
  if (!page.length) return { threads: [], nextCursor: null };

  const ids = page.map((t) => t.thread_id);
  const summaries = await Promise.all(ids.map((id) => threadSummary(userId, id, opts.folder)));
  return { threads: summaries.filter((s): s is MailThreadSummary => s !== null), nextCursor };
}

async function threadSummary(
  userId: string, threadId: string, folder: MailFolder,
): Promise<MailThreadSummary | null> {
  const db = getPool();
  const { rows: tRows } = await db.query<{
    subject: string; last_message_at: string; message_count: number; has_attachments: boolean; last_snippet: string;
  }>(
    `SELECT subject, last_message_at, message_count, has_attachments, last_snippet
       FROM mail_threads WHERE id = $1`, [threadId],
  );
  const t = tRows[0];
  if (!t) return null;

  const { rows: people } = await db.query<{ user_id: string | null; name: string; address: string; avatar_url: string | null }>(
    `SELECT DISTINCT ON (COALESCE(x.user_id, x.address)) x.user_id, x.name, x.address, u.avatar_url
       FROM (
         SELECT m.from_user_id AS user_id, m.from_name AS name, m.from_address AS address, m.created_at
           FROM mail_messages m WHERE m.thread_id = $1
         UNION ALL
         SELECT r.user_id, r.name, r.address, m.created_at
           FROM mail_recipients r JOIN mail_messages m ON m.id = r.message_id
          WHERE r.thread_id = $1 AND r.kind <> 'bcc'
       ) x
       LEFT JOIN users u ON u.id = x.user_id
      ORDER BY COALESCE(x.user_id, x.address), x.created_at DESC`,
    [threadId],
  );

  const participants: MailPerson[] = people.map((p) => ({
    userId: p.user_id, name: p.name || p.address, address: p.address, avatarUrl: p.avatar_url,
  }));

  const senderFolders: MailFolder[] = ['sent', 'drafts', 'scheduled'];
  if (senderFolders.includes(folder)) {
    const { rows: mine } = await db.query<{
      is_draft: boolean; scheduled_at: string | null; delivery: string;
    }>(
      `SELECT m.is_draft, m.scheduled_at,
              COALESCE((
                SELECT CASE
                  WHEN bool_or(rr.delivery_status IN ('failed','bounced')) THEN 'failed'
                  WHEN bool_and(rr.delivery_status = 'delivered') THEN 'delivered'
                  WHEN bool_or(rr.delivery_status = 'sent') THEN 'sent'
                  ELSE 'queued' END
                FROM mail_recipients rr WHERE rr.message_id = m.id
              ), 'queued') AS delivery
         FROM mail_messages m
        WHERE m.thread_id = $1 AND m.from_user_id = $2
        ORDER BY m.created_at DESC LIMIT 1`,
      [threadId, userId],
    );
    const mm = mine[0];
    return {
      threadId, subject: t.subject, snippet: t.last_snippet, lastMessageAt: t.last_message_at,
      messageCount: Number(t.message_count), hasAttachments: t.has_attachments,
      participants, unread: false, starred: false, folder, labels: [],
      delivery: (mm?.delivery ?? 'queued') as MailThreadSummary['delivery'],
      scheduledAt: mm?.scheduled_at ?? null, isDraft: mm?.is_draft ?? false,
    };
  }

  const { rows: rRows } = await db.query<{
    unread: boolean; starred: boolean; folder: MailFolder; labels: string[];
  }>(
    `SELECT bool_or(NOT is_read) AS unread, bool_or(is_starred) AS starred,
            (array_agg(folder ORDER BY created_at DESC))[1] AS folder,
            COALESCE((array_agg(labels ORDER BY created_at DESC))[1], '[]'::jsonb) AS labels
       FROM mail_recipients WHERE thread_id = $1 AND user_id = $2 AND NOT is_hidden`,
    [threadId, userId],
  );
  const rr = rRows[0];
  return {
    threadId, subject: t.subject, snippet: t.last_snippet, lastMessageAt: t.last_message_at,
    messageCount: Number(t.message_count), hasAttachments: t.has_attachments,
    participants,
    unread: rr?.unread ?? false, starred: rr?.starred ?? false,
    folder: rr?.folder ?? 'inbox',
    labels: Array.isArray(rr?.labels) ? rr!.labels : [],
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Reading a thread
 * ────────────────────────────────────────────────────────────────────────── */

async function participates(db: PoolClient | ReturnType<typeof getPool>, userId: string, threadId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM mail_messages WHERE thread_id = $1 AND from_user_id = $2)
                OR EXISTS (SELECT 1 FROM mail_recipients WHERE thread_id = $1 AND user_id = $2 AND NOT is_hidden)`,
    [threadId, userId],
  );
  return rows.length > 0;
}

export async function getThread(userId: string, threadId: string): Promise<MailThreadView> {
  const db = getPool();
  if (!(await participates(db, userId, threadId))) throw new MailError('Thread not found.', 404);

  const { rows: tRows } = await db.query<{ subject: string }>(
    `SELECT subject FROM mail_threads WHERE id = $1`, [threadId],
  );
  if (!tRows[0]) throw new MailError('Thread not found.', 404);

  const { rows: msgs } = await db.query<{
    id: string; thread_id: string; from_user_id: string; from_name: string; from_address: string;
    from_avatar: string | null; subject: string; body_html: string; body_text: string; snippet: string;
    kind: string; parent_id: string | null; is_draft: boolean; scheduled_at: string | null;
    sent_at: string | null; created_at: string; campaign_id: string | null;
  }>(
    `SELECT m.*, u.avatar_url AS from_avatar
       FROM mail_messages m LEFT JOIN users u ON u.id = m.from_user_id
      WHERE m.thread_id = $1
        AND (NOT m.is_draft OR m.from_user_id = $2)
      ORDER BY m.created_at`,
    [threadId, userId],
  );

  const messages: MailMessageView[] = [];
  for (const m of msgs) {
    const isSender = m.from_user_id === userId;

    const { rows: recips } = await db.query<{
      id: string; kind: 'to' | 'cc' | 'bcc'; user_id: string | null; name: string; address: string;
      avatar_url: string | null; is_read: boolean; is_starred: boolean; folder: MailFolder; labels: string[];
    }>(
      `SELECT r.id, r.kind, r.user_id, r.name, r.address, u.avatar_url,
              r.is_read, r.is_starred, r.folder, r.labels
         FROM mail_recipients r LEFT JOIN users u ON u.id = r.user_id
        WHERE r.message_id = $1
        ORDER BY r.kind, r.name`,
      [m.id],
    );

    // BCC is visible only to the sender.
    const visibleRecips = recips.filter((r) => r.kind !== 'bcc' || isSender);
    const asPerson = (r: typeof recips[number]): MailPerson => ({
      userId: r.user_id, name: r.name || r.address, address: r.address, avatarUrl: r.avatar_url,
    });

    const { rows: atts } = await db.query<{
      id: string; file_id: string; name: string; mime: string; size: string;
    }>(
      `SELECT id, file_id, name, mime, size FROM mail_attachments WHERE message_id = $1 ORDER BY ordinal`,
      [m.id],
    );

    const mineRow = recips.find((r) => r.user_id === userId);

    let deliverySummary: MailMessageView['deliverySummary'];
    if (isSender && !m.is_draft) {
      // Counted per *person*, not per delivery row: someone who gets both an
      // in-app copy and an email is one recipient, "delivered" once both land,
      // "failed" if either bounces. So "28/30" means 28 people are reached.
      const { rows: agg } = await db.query<Record<string, string>>(
        `WITH per_person AS (
           SELECT coalesce(user_id, lower(address)) AS who,
                  CASE
                    WHEN bool_or(delivery_status IN ('bounced','failed')) THEN 'failed'
                    WHEN bool_or(delivery_status = 'suppressed') AND bool_and(delivery_status IN ('suppressed','delivered','sent')) THEN 'suppressed'
                    WHEN bool_and(delivery_status = 'delivered') THEN 'delivered'
                    WHEN bool_or(delivery_status IN ('delivered','sent')) THEN 'sent'
                    ELSE 'queued' END AS state
             FROM mail_recipients WHERE message_id = $1
            GROUP BY coalesce(user_id, lower(address))
         )
         SELECT count(*)::text total,
                count(*) FILTER (WHERE state = 'queued')::text queued,
                count(*) FILTER (WHERE state = 'sent')::text sent,
                count(*) FILTER (WHERE state = 'delivered')::text delivered,
                count(*) FILTER (WHERE state = 'failed')::text failed,
                count(*) FILTER (WHERE state = 'suppressed')::text suppressed
           FROM per_person`,
        [m.id],
      );
      const a = agg[0]!;
      deliverySummary = {
        total: +a.total!, queued: +a.queued!, sent: +a.sent!, delivered: +a.delivered!,
        bounced: 0, failed: +a.failed!, suppressed: +a.suppressed!,
      };
    }

    messages.push({
      id: m.id, threadId: m.thread_id,
      from: { userId: m.from_user_id, name: m.from_name, address: m.from_address, avatarUrl: m.from_avatar },
      to: visibleRecips.filter((r) => r.kind === 'to').map(asPerson),
      cc: visibleRecips.filter((r) => r.kind === 'cc').map(asPerson),
      bcc: isSender ? recips.filter((r) => r.kind === 'bcc').map(asPerson) : [],
      subject: m.subject, bodyHtml: m.body_html, bodyText: m.body_text, snippet: m.snippet,
      kind: m.kind as MailMessageView['kind'], parentId: m.parent_id,
      isDraft: m.is_draft, scheduledAt: m.scheduled_at, sentAt: m.sent_at, createdAt: m.created_at,
      campaignId: m.campaign_id,
      attachments: atts.map((a) => ({
        id: a.id, fileId: a.file_id, name: a.name, mime: a.mime, size: Number(a.size),
        kind: attachmentKind(a.mime),
      })),
      mine: mineRow ? {
        recipientId: mineRow.id, isRead: mineRow.is_read, isStarred: mineRow.is_starred,
        folder: mineRow.folder, labels: Array.isArray(mineRow.labels) ? mineRow.labels : [],
      } : null,
      deliverySummary,
    });
  }

  // Opening a thread marks the viewer's unread copies read (FR-MAIL-1).
  await db.query(
    `UPDATE mail_recipients SET is_read = true, read_at = now()
      WHERE thread_id = $1 AND user_id = $2 AND NOT is_read`,
    [threadId, userId],
  );

  const { rows: lbl } = await db.query<{ labels: string[] }>(
    `SELECT COALESCE((array_agg(labels ORDER BY created_at DESC))[1], '[]'::jsonb) AS labels
       FROM mail_recipients WHERE thread_id = $1 AND user_id = $2`,
    [threadId, userId],
  );

  return {
    threadId, subject: tRows[0].subject, messages,
    labels: Array.isArray(lbl[0]?.labels) ? lbl[0]!.labels : [],
  };
}

/**
 * A thread rendered as plain text for a language model — authorised the same
 * way `getThread` is. Oldest first, "From … :" per message. Capped so a very
 * long thread cannot blow the context window.
 */
export async function threadPlainText(
  userId: string, threadId: string, maxChars = 12_000,
): Promise<{ subject: string; text: string }> {
  const db = getPool();
  if (!(await participates(db, userId, threadId))) throw new MailError('Thread not found.', 404);
  const { rows: t } = await db.query<{ subject: string }>(
    `SELECT subject FROM mail_threads WHERE id = $1`, [threadId],
  );
  if (!t[0]) throw new MailError('Thread not found.', 404);
  const { rows: msgs } = await db.query<{
    from_name: string; created_at: string; body_text: string; body_html: string;
    to_names: string | null;
  }>(
    `SELECT m.from_name, m.created_at, m.body_text, m.body_html,
            (SELECT string_agg(r.name, ', ') FROM mail_recipients r
              WHERE r.message_id = m.id AND r.kind <> 'bcc') AS to_names
       FROM mail_messages m
      WHERE m.thread_id = $1 AND NOT m.is_draft
      ORDER BY m.created_at`,
    [threadId],
  );
  let text = '';
  for (const m of msgs) {
    const body = (m.body_text && m.body_text.trim()) || htmlToText(m.body_html);
    const block = `From: ${m.from_name}\nTo: ${m.to_names ?? ''}\nDate: ${new Date(m.created_at).toISOString().slice(0, 16)}\n\n${body}\n\n---\n\n`;
    if (text.length + block.length > maxChars) { text += '[earlier messages omitted]\n'; break; }
    text += block;
  }
  return { subject: t[0].subject, text: text.trim() };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Compose / send / draft
 * ────────────────────────────────────────────────────────────────────────── */

export interface ComposeResult {
  messageId: string;
  threadId: string;
  draft: boolean;
  scheduled: boolean;
}

/**
 * The one write path: send now, save a draft, or schedule for later.
 *
 * A draft is overwritten in place if `draftId` is given. Sending a draft is
 * the same call with `draft:false` and the `draftId` set — the row is promoted,
 * not copied.
 */
export async function compose(userId: string, payload: MailComposePayload): Promise<ComposeResult> {
  const subject = (payload.subject ?? '').trim().slice(0, MAIL_MAX_SUBJECT) || '(no subject)';
  const bodyHtml = (payload.bodyHtml ?? '').slice(0, MAIL_MAX_BODY_HTML);
  const bodyText = (payload.bodyText?.trim() || htmlToText(bodyHtml)).slice(0, MAIL_MAX_BODY_HTML);
  const isDraft = payload.draft === true;
  const scheduledAt = payload.scheduledAt ? new Date(payload.scheduledAt) : null;
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) throw new MailError('Invalid schedule time.');
  if (scheduledAt && scheduledAt.getTime() < Date.now() - 60_000) {
    throw new MailError('Cannot schedule a message in the past.');
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sender = await personById(client, userId);
    const prefs = await getPrefs(userId);
    const fromName = prefs.displayName || sender.name;

    const to = await resolveRecipients(client, payload.to, 'to');
    const cc = await resolveRecipients(client, payload.cc, 'cc');
    const bcc = await resolveRecipients(client, payload.bcc, 'bcc');
    const all = [...to, ...cc, ...bcc];

    if (!isDraft && all.length === 0) throw new MailError('Add at least one recipient.');
    if (all.length > MAIL_MAX_RECIPIENTS) {
      throw new MailError(`A single message is limited to ${MAIL_MAX_RECIPIENTS} recipients. Use a distribution list for more.`);
    }

    // ── thread ────────────────────────────────────────────────────────────
    // Promoting a draft: it already lives in a thread — reuse that one rather
    // than opening a new (empty) thread and orphaning the message in the old.
    let threadId = payload.threadId ?? null;
    if (!threadId && payload.draftId) {
      const { rows } = await client.query<{ thread_id: string }>(
        `SELECT thread_id FROM mail_messages WHERE id = $1 AND from_user_id = $2 AND is_draft`,
        [payload.draftId, userId],
      );
      if (rows[0]) threadId = rows[0].thread_id;
    }
    if (threadId) {
      if (!(await participates(client, userId, threadId))) throw new MailError('Thread not found.', 404);
    } else {
      threadId = snowflake();
      await client.query(
        `INSERT INTO mail_threads (id, subject, subject_normalized, created_by, last_message_at, last_sender_id, last_sender_name)
         VALUES ($1, $2, $3, $4, now(), $4, $5)`,
        [threadId, subject, normalizeSubject(subject), userId, fromName],
      );
    }

    // ── message ───────────────────────────────────────────────────────────
    let messageId = payload.draftId ?? null;
    if (messageId) {
      const { rows } = await client.query<{ is_draft: boolean }>(
        `SELECT is_draft FROM mail_messages WHERE id = $1 AND from_user_id = $2`, [messageId, userId],
      );
      if (!rows[0]) throw new MailError('Draft not found.', 404);
      if (!rows[0].is_draft) throw new MailError('That message has already been sent.', 409);
      await client.query(
        `UPDATE mail_messages SET subject = $2, body_html = $3, body_text = $4, snippet = $5,
               is_draft = $6, scheduled_at = $7, updated_at = now(),
               recipient_summary = $8::jsonb, has_attachments = $9
          WHERE id = $1`,
        [messageId, subject, bodyHtml, bodyText, snippetOf(bodyHtml, bodyText),
         isDraft, isDraft || scheduledAt ? scheduledAt : null,
         JSON.stringify({ to: to.length, cc: cc.length, bcc: bcc.length }),
         (payload.attachments?.length ?? 0) > 0],
      );
      await client.query(`DELETE FROM mail_recipients WHERE message_id = $1`, [messageId]);
      await client.query(`DELETE FROM mail_attachments WHERE message_id = $1`, [messageId]);
    } else {
      messageId = snowflake();
      await client.query(
        `INSERT INTO mail_messages
           (id, thread_id, from_user_id, from_name, from_address, subject, body_html, body_text, snippet,
            parent_id, kind, is_draft, scheduled_at, has_attachments, recipient_summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
        [messageId, threadId, userId, fromName, sender.email, subject, bodyHtml, bodyText,
         snippetOf(bodyHtml, bodyText), payload.parentId ?? null, payload.kind ?? 'new',
         isDraft, scheduledAt, (payload.attachments?.length ?? 0) > 0,
         JSON.stringify({ to: to.length, cc: cc.length, bcc: bcc.length })],
      );
    }

    // ── attachments ───────────────────────────────────────────────────────
    let i = 0;
    for (const att of payload.attachments ?? []) {
      const { rows } = await client.query(
        `SELECT 1 FROM files WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
        [att.fileId, userId],
      );
      if (!rows[0]) throw new MailError(`Attachment not found or not yours: ${att.name}`, 400);
      await client.query(
        `INSERT INTO mail_attachments (id, message_id, file_id, name, mime, size, ordinal)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [snowflake(), messageId, att.fileId, att.name.slice(0, 300), att.mime, att.size, i++],
      );
    }

    // ── recipients ────────────────────────────────────────────────────────
    for (const r of all) {
      let status = 'queued';
      if (r.channel === 'smtp') {
        const supp = await isSuppressed(r.address);
        if (supp) status = 'suppressed';
      }
      const recipientId = snowflake();
      await client.query(
        `INSERT INTO mail_recipients
           (id, message_id, thread_id, kind, user_id, address, name, merge_vars, channel, delivery_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8,$9)`,
        [recipientId, messageId, threadId, r.kind, r.userId, r.address, r.name, r.channel, status],
      );
      if (!isDraft) await recordEvent(client, recipientId, messageId, 'queued', { channel: r.channel });
    }

    // ── thread rollup ─────────────────────────────────────────────────────
    if (!isDraft) {
      const willSendNow = !scheduledAt;
      await client.query(
        `UPDATE mail_messages SET sent_at = CASE WHEN $2 THEN now() ELSE sent_at END WHERE id = $1`,
        [messageId, willSendNow],
      );
      await client.query(
        `UPDATE mail_threads t SET
           last_message_at = now(), last_sender_id = $2, last_sender_name = $3,
           last_snippet = $4, subject = $5,
           message_count = (SELECT count(*) FROM mail_messages WHERE thread_id = $1 AND NOT is_draft),
           has_attachments = has_attachments OR $6
         WHERE t.id = $1`,
        [threadId, userId, fromName, snippetOf(bodyHtml, bodyText), subject,
         (payload.attachments?.length ?? 0) > 0],
      );
    }

    await client.query('COMMIT');

    // In-app delivery is synchronous and outside the transaction so a slow
    // notification never holds a lock. SMTP is the worker's job.
    if (!isDraft && !scheduledAt) {
      await deliverInApp(messageId).catch((e) => console.error('[mail] in-app delivery:', e));
    }

    return { messageId, threadId, draft: isDraft, scheduled: !!scheduledAt && !isDraft };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteDraft(userId: string, draftId: string): Promise<void> {
  const { rowCount } = await getPool().query(
    `DELETE FROM mail_messages WHERE id = $1 AND from_user_id = $2 AND is_draft`, [draftId, userId],
  );
  if (!rowCount) throw new MailError('Draft not found.', 404);
}

/** Cancel a scheduled send before its time (FR-MAIL-10) — becomes a draft. */
export async function cancelScheduled(userId: string, messageId: string): Promise<void> {
  const { rowCount } = await getPool().query(
    `UPDATE mail_messages SET is_draft = true, scheduled_at = NULL, updated_at = now()
      WHERE id = $1 AND from_user_id = $2 AND NOT is_draft AND scheduled_at IS NOT NULL AND sent_at IS NULL`,
    [messageId, userId],
  );
  if (!rowCount) throw new MailError('No pending scheduled message to cancel.', 404);
  await getPool().query(`DELETE FROM mail_recipients WHERE message_id = $1`, [messageId]);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Mailbox actions
 * ────────────────────────────────────────────────────────────────────────── */

const MOVABLE: MailFolder[] = ['inbox', 'archive', 'trash', 'spam'];

export async function moveThread(userId: string, threadId: string, folder: MailFolder): Promise<void> {
  if (!MOVABLE.includes(folder)) throw new MailError('Cannot move mail there.');
  const { rowCount } = await getPool().query(
    `UPDATE mail_recipients SET folder = $3 WHERE thread_id = $1 AND user_id = $2 AND NOT is_hidden`,
    [threadId, userId, folder],
  );
  if (!rowCount) throw new MailError('Thread not found in your mailbox.', 404);
}

export async function starThread(userId: string, threadId: string, starred: boolean): Promise<void> {
  await getPool().query(
    `UPDATE mail_recipients SET is_starred = $3 WHERE thread_id = $1 AND user_id = $2`,
    [threadId, userId, starred],
  );
}

export async function markThread(userId: string, threadId: string, read: boolean): Promise<void> {
  await getPool().query(
    `UPDATE mail_recipients SET is_read = $3, read_at = CASE WHEN $3 THEN now() ELSE NULL END
      WHERE thread_id = $1 AND user_id = $2`,
    [threadId, userId, read],
  );
}

export async function setThreadLabels(userId: string, threadId: string, labelIds: string[]): Promise<void> {
  const db = getPool();
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM mail_labels WHERE (owner_id = $1 OR owner_id IS NULL) AND id = ANY($2::text[])`,
    [userId, labelIds],
  );
  const valid = rows.map((r) => r.id);
  const { rowCount } = await db.query(
    `UPDATE mail_recipients SET labels = $3::jsonb WHERE thread_id = $1 AND user_id = $2 AND NOT is_hidden`,
    [threadId, userId, JSON.stringify(valid)],
  );
  if (!rowCount) throw new MailError('Thread not found in your mailbox.', 404);
}

/** Permanently remove a thread's copies for this user (from Trash only). */
export async function purgeThread(userId: string, threadId: string): Promise<void> {
  await getPool().query(
    `UPDATE mail_recipients SET is_hidden = true WHERE thread_id = $1 AND user_id = $2 AND folder = 'trash'`,
    [threadId, userId],
  );
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Delivery tracking (FR-MAIL-8) — sender only
 * ────────────────────────────────────────────────────────────────────────── */

export async function deliveryFor(userId: string, messageId: string): Promise<MailRecipientDelivery[]> {
  const db = getPool();
  const { rows: owner } = await db.query(
    `SELECT 1 FROM mail_messages WHERE id = $1 AND from_user_id = $2`, [messageId, userId],
  );
  if (!owner[0]) throw new MailError('Message not found.', 404);

  const { rows } = await db.query<{
    id: string; name: string; address: string; kind: 'to' | 'cc' | 'bcc'; channel: 'in_app' | 'smtp';
    delivery_status: string; delivery_error: string | null; sent_at: string | null; delivered_at: string | null;
  }>(
    `SELECT id, name, address, kind, channel, delivery_status, delivery_error, sent_at, delivered_at
       FROM mail_recipients WHERE message_id = $1 ORDER BY kind, name`,
    [messageId],
  );

  const out: MailRecipientDelivery[] = [];
  for (const r of rows) {
    const { rows: events } = await db.query<{ type: string; at: string; detail: Record<string, unknown> }>(
      `SELECT type, at, detail FROM mail_delivery_events WHERE recipient_id = $1 ORDER BY at`, [r.id],
    );
    out.push({
      recipientId: r.id, name: r.name || r.address, address: r.address, kind: r.kind, channel: r.channel,
      status: r.delivery_status as MailRecipientDelivery['status'], error: r.delivery_error,
      sentAt: r.sent_at, deliveredAt: r.delivered_at, events,
    });
  }
  return out;
}

/** Is `fileId` a mail attachment this user may download? (used by tupo-files) */
export async function canReadMailAttachment(userId: string, fileId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1
       FROM mail_attachments a
       JOIN mail_messages m ON m.id = a.message_id
      WHERE a.file_id = $1
        AND (m.from_user_id = $2
             OR EXISTS (SELECT 1 FROM mail_recipients r
                         WHERE r.message_id = m.id AND r.user_id = $2 AND NOT r.is_hidden))
      LIMIT 1`,
    [fileId, userId],
  );
  return rows.length > 0;
}
