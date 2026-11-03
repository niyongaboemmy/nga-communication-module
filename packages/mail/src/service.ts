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
import { getPool, snowflake, activeUserSql } from '@tupo/db';
import {
  MAIL_FOLDERS,
  MAIL_MAX_BODY_HTML, MAIL_MAX_RECIPIENTS, MAIL_MAX_SUBJECT, MAIL_MAX_PAGE_SIZE, MAIL_PAGE_SIZE,
  normalizeSubject,
} from '@tupo/shared';
import type {
  MailComposePayload, MailFolder, MailMessageView, MailPerson, MailPrefs, MailThreadSummary,
  MailThreadView, MailLabel, MailboxCounts, MailRecipientDelivery, MailAttachment,
} from '@tupo/shared';
import { MailError } from './errors.js';
import { sanitizeMailHtml } from './sanitize.js';
import { internalEmailDelivery } from './config.js';
import { htmlToText, snippetOf, isEmailAddress, extractMergeFields, renderMerge } from './render.js';
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
          WHERE u.id = $1 AND ${activeUserSql('u')}`, [id],
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
    // Active accounts first: two rows can share an address.
    const { rows } = await db.query<{ id: string; name: string; copies: boolean | null; active: boolean }>(
      `SELECT u.id, u.name, p.email_copies AS copies, ${activeUserSql('u')} AS active
         FROM users u LEFT JOIN mail_prefs p ON p.user_id = u.id
        WHERE lower(u.email) = $1
        ORDER BY ${activeUserSql('u')} DESC LIMIT 1`, [addr],
    );
    // The address of a person who is no longer active (suspended here, or
    // deactivated / removed in NGA MIS) is still an internal address: it must
    // not fall through to an outside SMTP send.
    if (rows[0] && !rows[0].active) {
      throw new MailError(`${value} belongs to an account that is no longer active.`, 422);
    }
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
    [userId, next.displayName, sanitizeMailHtml(next.signatureHtml.slice(0, 20_000)), next.signatureEnabled, next.emailCopies],
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
              SELECT count(DISTINCT r.thread_id) FROM mail_recipients r
               WHERE r.user_id = $1 AND NOT r.is_read AND r.folder = 'inbox' AND NOT r.is_hidden
                 AND NOT r.pending AND r.labels ? l.id
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

/** Rename or recolour one of your labels (C-09). System labels are fixed. */
export async function updateLabel(
  userId: string, labelId: string, patch: { name?: string; color?: string },
): Promise<MailLabel> {
  const name = patch.name === undefined ? undefined : patch.name.trim().slice(0, 60);
  if (name !== undefined && !name) throw new MailError('A label needs a name.');
  const color = patch.color === undefined ? undefined : patch.color.trim();
  if (color !== undefined && !/^#[0-9a-f]{6}$/i.test(color)) throw new MailError('Choose a colour like #6366f1.');
  try {
    const { rows } = await getPool().query<{ id: string; name: string; color: string; ordinal: number }>(
      `UPDATE mail_labels SET name = COALESCE($3, name), color = COALESCE($4, color)
        WHERE id = $1 AND owner_id = $2
        RETURNING id, name, color, ordinal`,
      [labelId, userId, name ?? null, color ?? null],
    );
    if (!rows[0]) throw new MailError('Label not found.', 404);
    return { id: rows[0].id, name: rows[0].name, color: rows[0].color, ordinal: rows[0].ordinal, isSystem: false, unread: 0 };
  } catch (err) {
    if (err instanceof MailError) throw err;
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
       -- Conversations, not rows: an internal recipient with email copies on
       -- has an in-app and an email row for the same mail, and a thread of five
       -- unread messages is one thing to read.
       (SELECT count(DISTINCT r.thread_id) FROM mail_recipients r
         WHERE r.user_id = $1 AND NOT r.is_read AND r.folder = 'inbox' AND NOT r.is_hidden AND NOT r.pending)::text AS inbox,
       (SELECT count(DISTINCT r.thread_id) FROM mail_recipients r
         WHERE r.user_id = $1 AND r.is_starred AND NOT r.is_hidden AND NOT r.pending
           AND r.folder <> 'trash')::text AS starred,
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
  if (!(MAIL_FOLDERS as readonly string[]).includes(opts.folder)) {
    throw new MailError('Unknown mail folder.', 400);
  }
  const limit = Math.min(Math.max(Number(opts.limit) || MAIL_PAGE_SIZE, 1), MAIL_MAX_PAGE_SIZE);
  const db = getPool();
  const senderFolders: MailFolder[] = ['sent', 'drafts', 'scheduled'];
  const like = opts.q ? `%${opts.q.replace(/[%_]/g, '\\$&')}%` : null;

  let threadIds: Array<{ thread_id: string; sort_at: string }>;

  if (senderFolders.includes(opts.folder) && !opts.labelId) {
    const cond =
      opts.folder === 'drafts' ? 'm.is_draft'
      : opts.folder === 'scheduled' ? 'NOT m.is_draft AND m.scheduled_at IS NOT NULL AND m.sent_at IS NULL'
      // Sent leaves out what the sender put in Trash or deleted (C-08); mail
      // sent before sender copies existed has none, and stays.
      : `NOT m.is_draft AND (m.scheduled_at IS NULL OR m.sent_at IS NOT NULL)
         AND (NOT EXISTS (SELECT 1 FROM mail_recipients sr WHERE sr.message_id = m.id AND sr.user_id = $1 AND sr.kind = 'self')
              OR EXISTS (SELECT 1 FROM mail_recipients sr WHERE sr.message_id = m.id AND sr.user_id = $1
                          AND sr.kind = 'self' AND sr.folder = 'sent' AND NOT sr.is_hidden))`;
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
    // The folder is always a bound parameter, never part of the SQL text.
    // A label is a view across folders (C-09): an archived conversation with
    // the label is still found under it. Trash and Spam stay out.
    const folderCond =
      opts.labelId ? `r.folder NOT IN ('trash', 'spam')`
      : opts.folder === 'starred' ? `r.is_starred AND r.folder <> 'trash'`
      : `r.folder = $5`;
    // Sorted and searched by what this person can see of each thread (C-04),
    // and limited in SQL rather than after loading the whole mailbox.
    const { rows } = await db.query<{ thread_id: string; sort_at: string }>(
      `SELECT thread_id, sort_at FROM (
         SELECT r.thread_id,
                (SELECT max(COALESCE(vm.sent_at, vm.updated_at)) FROM mail_messages vm
                  WHERE vm.thread_id = r.thread_id AND ${visibleTo('vm', '$1')}) AS sort_at
           FROM mail_recipients r
          WHERE r.user_id = $1 AND NOT r.is_hidden AND NOT r.pending AND ${folderCond}
            AND ($2::text IS NULL OR $2 = ANY(SELECT jsonb_array_elements_text(r.labels)))
            AND ($3::text IS NULL OR EXISTS (
                  SELECT 1 FROM mail_messages sm
                   WHERE sm.thread_id = r.thread_id AND ${visibleTo('sm', '$1')}
                     AND (sm.subject ILIKE $3 OR sm.body_text ILIKE $3)))
          GROUP BY r.thread_id
       ) x
       WHERE ($4::timestamptz IS NULL OR sort_at < $4::timestamptz)
       ORDER BY sort_at DESC
       LIMIT ${limit + 1}`,
      opts.folder === 'starred' || opts.labelId
        ? [userId, opts.labelId ?? null, like, opts.cursor ?? null]
        : [userId, opts.labelId ?? null, like, opts.cursor ?? null, opts.folder],
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
  // What this viewer can see of the thread, not the thread's global totals:
  // the snippet, count and time of a private reply they were not sent must
  // not show in their list either.
  const { rows: tRows } = await db.query<{
    subject: string; last_message_at: string | null; message_count: number; has_attachments: boolean; last_snippet: string | null;
  }>(
    `WITH v AS (
       SELECT m.id, m.snippet, COALESCE(m.sent_at, m.updated_at) AS at
         FROM mail_messages m WHERE m.thread_id = $1 AND ${visibleTo('m', '$2')}
     )
     SELECT t.subject,
            (SELECT max(at) FROM v) AS last_message_at,
            (SELECT count(*) FROM v)::int AS message_count,
            EXISTS (SELECT 1 FROM mail_attachments a WHERE a.message_id IN (SELECT id FROM v)) AS has_attachments,
            (SELECT snippet FROM v ORDER BY at DESC LIMIT 1) AS last_snippet
       FROM mail_threads t WHERE t.id = $1`, [threadId, userId],
  );
  const t = tRows[0];
  if (!t || !t.message_count) return null;

  const { rows: people } = await db.query<{ user_id: string | null; name: string; address: string; avatar_url: string | null }>(
    `SELECT DISTINCT ON (COALESCE(x.user_id, x.address)) x.user_id, x.name, x.address, u.avatar_url
       FROM (
         SELECT m.from_user_id AS user_id, m.from_name AS name, m.from_address AS address, m.created_at
           FROM mail_messages m WHERE m.thread_id = $1 AND ${visibleTo('m', '$2')}
         UNION ALL
         SELECT r.user_id, r.name, r.address, m.created_at
           FROM mail_recipients r JOIN mail_messages m ON m.id = r.message_id
          WHERE r.thread_id = $1 AND r.kind NOT IN ('bcc', 'self') AND NOT r.pending AND ${visibleTo('m', '$2')}
       ) x
       LEFT JOIN users u ON u.id = x.user_id
      ORDER BY COALESCE(x.user_id, x.address), x.created_at DESC`,
    [threadId, userId],
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
                FROM mail_recipients rr WHERE rr.message_id = m.id AND rr.kind <> 'self'
              ), 'queued') AS delivery
         FROM mail_messages m
        WHERE m.thread_id = $1 AND m.from_user_id = $2
        ORDER BY m.created_at DESC LIMIT 1`,
      [threadId, userId],
    );
    const mm = mine[0];
    return {
      threadId, subject: t.subject, snippet: t.last_snippet ?? '', lastMessageAt: t.last_message_at!,
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
            (array_agg(folder ORDER BY (kind = 'self'), created_at DESC))[1] AS folder,
            COALESCE((array_agg(labels ORDER BY created_at DESC))[1], '[]'::jsonb) AS labels
       FROM mail_recipients WHERE thread_id = $1 AND user_id = $2 AND NOT is_hidden AND NOT pending`,
    [threadId, userId],
  );
  const rr = rRows[0];
  return {
    threadId, subject: t.subject, snippet: t.last_snippet ?? '', lastMessageAt: t.last_message_at!,
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

/**
 * SQL condition: message `m` is visible to the user in parameter `p` (C-04).
 *
 * Mail is addressed per message, not per thread: being on an earlier message
 * does not entitle anyone to a later private reply, and a BCC'd recipient sees
 * only the copy they were sent. So a message is visible to its sender, or —
 * once actually sent — to someone holding a live recipient row on it. Every
 * reader (thread view, list summaries, AI text, search) uses this one rule.
 */
export function visibleTo(m: string, p: string): string {
  return `(${m}.from_user_id = ${p}
           OR (NOT ${m}.is_draft AND ${m}.sent_at IS NOT NULL
               AND EXISTS (SELECT 1 FROM mail_recipients vr
                            WHERE vr.message_id = ${m}.id AND vr.user_id = ${p}
                              AND NOT vr.is_hidden AND NOT vr.pending)))`;
}

async function participates(db: PoolClient | ReturnType<typeof getPool>, userId: string, threadId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM mail_messages WHERE thread_id = $1 AND from_user_id = $2)
                OR EXISTS (SELECT 1 FROM mail_recipients WHERE thread_id = $1 AND user_id = $2 AND NOT is_hidden AND NOT pending)`,
    [threadId, userId],
  );
  return rows.length > 0;
}

function onePerPerson<T extends { user_id: string | null; address: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = r.user_id ?? r.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
        -- Only messages this person sent or was sent; drafts and unsent
        -- scheduled messages are the sender's alone.
        AND ${visibleTo('m', '$2')}
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
        WHERE r.message_id = $1 AND r.kind <> 'self'
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
             FROM mail_recipients WHERE message_id = $1 AND kind <> 'self'
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
      // One entry per person: an in-app and an email copy are the same recipient.
      to: onePerPerson(visibleRecips.filter((r) => r.kind === 'to')).map(asPerson),
      cc: onePerPerson(visibleRecips.filter((r) => r.kind === 'cc')).map(asPerson),
      bcc: isSender ? onePerPerson(recips.filter((r) => r.kind === 'bcc')).map(asPerson) : [],
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
      WHERE thread_id = $1 AND user_id = $2 AND NOT is_read AND NOT pending`,
    [threadId, userId],
  );

  const { rows: lbl } = await db.query<{ labels: string[]; folder: MailFolder | null; starred: boolean | null }>(
    `SELECT COALESCE((array_agg(labels ORDER BY created_at DESC))[1], '[]'::jsonb) AS labels,
            (array_agg(folder ORDER BY (kind = 'self'), created_at DESC))[1] AS folder,
            bool_or(is_starred) AS starred
       FROM mail_recipients WHERE thread_id = $1 AND user_id = $2 AND NOT pending AND NOT is_hidden`,
    [threadId, userId],
  );

  return {
    threadId, subject: tRows[0].subject, messages,
    labels: Array.isArray(lbl[0]?.labels) ? lbl[0]!.labels : [],
    // Where this conversation sits for the reader, so the thread toolbar
    // offers the right actions (C-12): Restore in Trash, Move to Inbox in Archive.
    folder: lbl[0]?.folder ?? 'sent',
    starred: lbl[0]?.starred === true,
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
              WHERE r.message_id = m.id AND r.kind NOT IN ('bcc', 'self')) AS to_names
       FROM mail_messages m
      WHERE m.thread_id = $1 AND NOT m.is_draft AND m.sent_at IS NOT NULL
        AND ${visibleTo('m', '$2')}
      ORDER BY m.created_at`,
    [threadId, userId],
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
export interface RecipientCaps { hourly: number; daily: number }

/** Caps for people without MAIL_BULK_SEND; env-tunable. */
export function defaultRecipientCaps(env: NodeJS.ProcessEnv = process.env): RecipientCaps {
  return {
    hourly: Math.max(1, parseInt(env.MAIL_RECIPIENTS_PER_HOUR ?? '300', 10) || 300),
    daily: Math.max(1, parseInt(env.MAIL_RECIPIENTS_PER_DAY ?? '1000', 10) || 1000),
  };
}

/**
 * The per-message limit alone let ten quick sends of 200 reach the whole
 * school without the bulk-send approval (MAIL-H6). People are counted once
 * per message (an in-app and an email copy are one person), and scheduled
 * mail counts from when it was written.
 */
async function assertUnderRecipientCaps(
  db: PoolClient, userId: string, adding: number, caps: RecipientCaps,
): Promise<void> {
  const { rows } = await db.query<{ hour: number; day: number }>(
    `SELECT count(*) FILTER (WHERE x.at > now() - interval '1 hour')::int AS hour, count(*)::int AS day
       FROM (SELECT DISTINCT r.message_id, COALESCE(r.user_id, lower(r.address)) AS who, m.created_at AS at
               FROM mail_messages m JOIN mail_recipients r ON r.message_id = m.id
              WHERE m.from_user_id = $1 AND NOT m.is_draft AND m.campaign_id IS NULL
                AND m.created_at > now() - interval '1 day') x`,
    [userId],
  );
  const used = rows[0] ?? { hour: 0, day: 0 };
  if (used.hour + adding > caps.hourly || used.day + adding > caps.daily) {
    throw new MailError(
      `You have reached the sending limit (${caps.hourly} recipients an hour, ${caps.daily} a day). ` +
      'For a large audience, use a bulk send so it can be reviewed.', 429);
  }
}

export async function compose(
  userId: string, payload: MailComposePayload, opts: { recipientCaps?: RecipientCaps | null } = {},
): Promise<ComposeResult> {
  let subject = (payload.subject ?? '').trim().slice(0, MAIL_MAX_SUBJECT) || '(no subject)';
  // Sanitised on write: what is stored is safe for every reader and client.
  let bodyHtml = sanitizeMailHtml((payload.bodyHtml ?? '').slice(0, MAIL_MAX_BODY_HTML));
  let bodyText = (payload.bodyText?.trim() || htmlToText(bodyHtml)).slice(0, MAIL_MAX_BODY_HTML);
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
    // Mail goes out under the person's NGA account name, always (C-13 /
    // MAIL2): a free-text display name let anyone appear as "Head Teacher
    // (Official Notice)".
    const fromName = sender.name;

    const to = await resolveRecipients(client, payload.to, 'to');
    const cc = await resolveRecipients(client, payload.cc, 'cc');
    const bcc = await resolveRecipients(client, payload.bcc, 'bcc');
    const all = [...to, ...cc, ...bcc];

    /*
     * Merge fields in personal mail (C-13). A template dropped into the
     * composer used to arrive as "Dear {{first_name}}". With one recipient
     * their own details fill the fields; anything else is refused with what
     * to do about it, rather than sent raw. Drafts keep the tokens.
     */
    const fields = isDraft ? [] : extractMergeFields(subject, bodyHtml);
    if (fields.length) {
      // People, not delivery channels: someone with email copies appears twice.
      const people = new Set(all.map((r) => r.userId ?? r.address.toLowerCase()));
      if (people.size !== 1) {
        throw new MailError(`{{${fields[0]}}} would read the same for everyone. Fill it in, or use a bulk send for personalised mail.`, 400);
      }
      const r = all[0]!;
      const full = (r.name || '').trim();
      const vars: Record<string, string> = {
        name: full, full_name: full, first_name: full.split(/\s+/)[0] ?? '',
        last_name: full.split(/\s+/).slice(1).join(' '), email: r.address,
      };
      const missing = fields.filter((f) => !vars[f]);
      if (missing.length) {
        throw new MailError(`Fill in {{${missing[0]}}} before sending — it has no value for ${full || r.address}.`, 400);
      }
      subject = renderMerge(subject, vars);
      bodyHtml = renderMerge(bodyHtml, vars, { escape: true });
      bodyText = renderMerge(bodyText, vars);
    }

    if (!isDraft && all.length === 0) throw new MailError('Add at least one recipient.');
    if (all.length > MAIL_MAX_RECIPIENTS) {
      throw new MailError(`A single message is limited to ${MAIL_MAX_RECIPIENTS} recipients. Use a distribution list for more.`);
    }
    if (!isDraft && opts.recipientCaps) {
      await assertUnderRecipientCaps(client, userId, new Set(all.map((r) => r.userId ?? r.address.toLowerCase())).size, opts.recipientCaps);
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
           (id, message_id, thread_id, kind, user_id, address, name, merge_vars, channel, delivery_status, pending)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8,$9,$10)`,
        // Drafts and scheduled mail stay invisible to recipients until sent.
        [recipientId, messageId, threadId, r.kind, r.userId, r.address, r.name, r.channel, status,
         isDraft || Boolean(scheduledAt)],
      );
      if (!isDraft) await recordEvent(client, recipientId, messageId, 'queued', { channel: r.channel });
    }

    /*
     * The sender's own copy (C-08): a 'self' row in Sent, so the sender can
     * star, label, trash and restore a conversation they only wrote in, like
     * one they received. Not a recipient: never delivered, never listed as
     * one. Someone writing to themselves already has their received copy.
     */
    if (!all.some((r) => r.userId === userId)) {
      await client.query(
        `INSERT INTO mail_recipients
           (id, message_id, thread_id, kind, user_id, address, name, merge_vars, channel, delivery_status,
            folder, is_read, read_at, pending)
         VALUES ($1,$2,$3,'self',$4,$5,$6,'{}'::jsonb,'self','none','sent',true,now(),$7)`,
        [`s${messageId}`, messageId, threadId, userId, sender.email ?? '', fromName, isDraft || Boolean(scheduledAt)],
      );
    }

    // ── release ───────────────────────────────────────────────────────────
    // Sent now: recipients see it and the thread summary moves. Scheduled
    // mail is released by the sweep at its time; drafts never are.
    if (!isDraft && !scheduledAt) await releaseMessage(client, messageId);

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
  // The recipients stay (still pending): the message is back as a draft with
  // everyone it was addressed to, not an empty one.
}

/**
 * Release a message to its recipients: stamp it sent, make its recipient rows
 * visible, and move the thread's summary. The single point where mail becomes
 * something other people can see — used by compose (send now) and by the
 * scheduled-send sweep.
 */
export async function releaseMessage(db: PoolClient | ReturnType<typeof getPool>, messageId: string): Promise<void> {
  const { rows } = await db.query<{
    thread_id: string; from_user_id: string; from_name: string; snippet: string; subject: string; has_attachments: boolean;
  }>(
    `UPDATE mail_messages SET sent_at = COALESCE(sent_at, now()), updated_at = now()
      WHERE id = $1 AND NOT is_draft
      RETURNING thread_id, from_user_id, from_name, snippet, subject, has_attachments`,
    [messageId],
  );
  const m = rows[0];
  if (!m) return;
  await db.query('UPDATE mail_recipients SET pending = false WHERE message_id = $1 AND pending', [messageId]);
  await inheritThreadState(db, messageId, m.thread_id);
  await db.query(
    `UPDATE mail_threads t SET
       last_message_at = now(), last_sender_id = $2, last_sender_name = $3,
       last_snippet = $4, subject = $5,
       message_count = (SELECT count(*) FROM mail_messages WHERE thread_id = $1 AND NOT is_draft AND sent_at IS NOT NULL),
       has_attachments = has_attachments OR $6
     WHERE t.id = $1`,
    [m.thread_id, m.from_user_id, m.from_name, m.snippet, m.subject, m.has_attachments],
  );
}

/**
 * One state per conversation (C-08 / C-09). State is stored per message, so a
 * reply used to arrive bare: no labels, no star, and in Inbox while the rest
 * of the conversation sat in Archive — listed in both. Now each new copy takes
 * the person's labels and star for the thread; a conversation in Spam keeps
 * new mail there, and otherwise a new message brings an archived
 * conversation back to the Inbox, whole.
 */
async function inheritThreadState(db: PoolClient | ReturnType<typeof getPool>, messageId: string, threadId: string): Promise<void> {
  await db.query(
    `WITH prior AS (
       SELECT r.user_id,
              COALESCE(jsonb_agg(DISTINCT l.value) FILTER (WHERE l.value IS NOT NULL), '[]'::jsonb) AS labels,
              bool_or(r.is_starred) AS starred,
              bool_or(r.folder = 'spam' AND r.kind <> 'self') AS spam
         FROM mail_recipients r
         LEFT JOIN LATERAL jsonb_array_elements(r.labels) l ON true
        WHERE r.thread_id = $2 AND r.message_id <> $1 AND r.user_id IS NOT NULL
          AND NOT r.is_hidden AND NOT r.pending
          AND r.user_id IN (SELECT user_id FROM mail_recipients WHERE message_id = $1 AND user_id IS NOT NULL)
        GROUP BY r.user_id)
     UPDATE mail_recipients r
        SET labels = p.labels,
            is_starred = r.is_starred OR p.starred,
            folder = CASE WHEN r.kind <> 'self' AND p.spam THEN 'spam' ELSE r.folder END
       FROM prior p
      WHERE r.message_id = $1 AND r.user_id = p.user_id`,
    [messageId, threadId],
  );
  await db.query(
    `UPDATE mail_recipients o SET folder = 'inbox'
      WHERE o.thread_id = $2 AND o.kind <> 'self' AND o.folder = 'archive' AND NOT o.is_hidden
        AND o.user_id IN (SELECT user_id FROM mail_recipients
                           WHERE message_id = $1 AND kind <> 'self' AND folder = 'inbox' AND user_id IS NOT NULL)`,
    [messageId, threadId],
  );
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Mailbox actions
 * ────────────────────────────────────────────────────────────────────────── */

const MOVABLE: MailFolder[] = ['inbox', 'archive', 'trash', 'spam'];

export async function moveThread(userId: string, threadId: string, folder: MailFolder): Promise<void> {
  if (!MOVABLE.includes(folder)) throw new MailError('Cannot move mail there.');
  // The sender's own copies live in Sent: they follow the conversation into
  // Trash and back out of it, but are never "in the Inbox" or archived away.
  const { rowCount } = await getPool().query(
    `UPDATE mail_recipients
        SET folder = CASE WHEN kind = 'self' THEN (CASE WHEN $3 = 'trash' THEN 'trash' ELSE 'sent' END) ELSE $3 END
      WHERE thread_id = $1 AND user_id = $2 AND NOT is_hidden AND NOT pending`,
    [threadId, userId, folder],
  );
  if (!rowCount) throw new MailError('Thread not found in your mailbox.', 404);
}

/** Restore from Trash (C-08): received copies to the Inbox, the sender's to Sent. */
export async function restoreThread(userId: string, threadId: string): Promise<void> {
  const { rowCount } = await getPool().query(
    `UPDATE mail_recipients SET folder = CASE WHEN kind = 'self' THEN 'sent' ELSE 'inbox' END
      WHERE thread_id = $1 AND user_id = $2 AND folder IN ('trash', 'spam') AND NOT is_hidden AND NOT pending`,
    [threadId, userId],
  );
  if (!rowCount) throw new MailError('Nothing to restore in that conversation.', 404);
}

/** Empty Trash (C-08): every conversation in it, gone for this person. */
export async function emptyTrash(userId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `WITH gone AS (
       UPDATE mail_recipients SET is_hidden = true
        WHERE user_id = $1 AND folder = 'trash' AND NOT is_hidden
        RETURNING thread_id)
     SELECT count(DISTINCT thread_id)::int AS n FROM gone`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

export async function starThread(userId: string, threadId: string, starred: boolean): Promise<void> {
  await getPool().query(
    `UPDATE mail_recipients SET is_starred = $3 WHERE thread_id = $1 AND user_id = $2 AND NOT pending`,
    [threadId, userId, starred],
  );
}

export async function markThread(userId: string, threadId: string, read: boolean): Promise<void> {
  await getPool().query(
    `UPDATE mail_recipients SET is_read = $3, read_at = CASE WHEN $3 THEN now() ELSE NULL END
      WHERE thread_id = $1 AND user_id = $2 AND NOT pending`,
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
    `UPDATE mail_recipients SET labels = $3::jsonb WHERE thread_id = $1 AND user_id = $2 AND NOT is_hidden AND NOT pending`,
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
       FROM mail_recipients WHERE message_id = $1 AND kind <> 'self' ORDER BY kind, name`,
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
                         WHERE r.message_id = m.id AND r.user_id = $2 AND NOT r.is_hidden AND NOT r.pending))
      LIMIT 1`,
    [fileId, userId],
  );
  return rows.length > 0;
}
