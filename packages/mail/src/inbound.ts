/**
 * Receiving outside email (docs/MAIL_INBOUND_PLAN_2026-11.md).
 *
 * Two ways in, one way of storing:
 *
 *   syncMailAccount      a person's connected mailbox, read-only over IMAP
 *   syncReplyMailbox     the relay's mailbox (MAIL_REPLY_CAPTURE=on): outside
 *                        replies to Tupo mail, and delivery reports
 *
 * Both hand each email to `storeInbound`, which threads it, stores it as Tupo
 * mail from an outside sender, and puts a copy in the right people's mailboxes.
 *
 * Threading is by the email's own headers. A Tupo email's Message-ID is
 * `<mail_messages.id@domain>` (outbound.ts), so a reply naming one in
 * In-Reply-To or References joins that conversation; an imported email's own
 * Message-ID is kept, so replies to it thread too.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { getPool, snowflake } from '@tupo/db';
import { notify, push } from '@tupo/notify';
import { effectiveTid } from '@tupo/tenancy';
import { normalizeSubject } from '@tupo/shared';
import { htmlToText, snippetOf, escapeHtml } from './render.js';
import { sanitizeMailHtml } from './sanitize.js';
import { bareAddress } from './smtp.js';
import { recordEvent, suppress } from './delivery.js';
import { inheritThreadState } from './service.js';
import {
  decryptSecret, imapClient, mailServerConfig, replyCaptureEnabled, type MailAccountRow,
} from './accounts.js';

type Db = PoolClient | ReturnType<typeof getPool>;

/* ── Headers ─────────────────────────────────────────────────────────────── */

/** Every `<id>` in a Message-ID / In-Reply-To / References value, in order. */
export function messageIdsIn(value: unknown): string[] {
  const parts = Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value : '';
  return [...parts.matchAll(/<[^<>\s]+>/g)].map((m) => m[0]);
}

/** The Tupo message id inside one of Tupo's own Message-IDs, or null. */
export function tupoMessageIdOf(emailId: string, domains: string[]): string | null {
  const m = /^<(\d{6,24})@([^<>\s]+)>$/.exec(emailId.trim());
  if (!m) return null;
  return domains.includes(m[2]!.toLowerCase()) ? m[1]! : null;
}

/** The domains Tupo's own Message-IDs use (outbound.ts: the relay's From domain). */
export function ownDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>(['tupo.local']);
  for (const v of [env.MAIL_FROM, env.EMAIL_FROM, env.SMTP_USER]) {
    const d = v ? bareAddress(v).split('@')[1] : undefined;
    if (d) out.add(d.toLowerCase());
  }
  return [...out];
}

/** The server marked it as spam (SpamAssassin, Rspamd, or the mailbox's own Junk flag). */
export function looksLikeSpam(parsed: Pick<ParsedMail, 'headers'>, flags?: Set<string>): boolean {
  if (flags && [...flags].some((f) => /^\$?junk$/i.test(f))) return true;
  const flag = String(parsed.headers.get('x-spam-flag') ?? '');
  const status = String(parsed.headers.get('x-spam-status') ?? '');
  return /^\s*yes/i.test(flag) || /^\s*yes\b/i.test(status);
}

/** A delivery report (DSN). Read from the raw text: the useful parts are message/delivery-status. */
export function parseBounce(raw: string): { recipients: Array<{ address: string; diagnostic: string }>; ids: string[] } | null {
  const head = raw.slice(0, 4000);
  const isReport = /content-type:\s*multipart\/report[^]*?report-type\s*=\s*"?delivery-status/i.test(head)
    || /^from:.*(mailer-daemon|postmaster)@/im.test(head);
  if (!isReport) return null;
  const recipients: Array<{ address: string; diagnostic: string }> = [];
  // Each per-recipient block: Final-Recipient … Action: failed … Diagnostic-Code.
  const blocks = raw.split(/(?=^Final-Recipient:)/im).slice(1);
  for (const b of blocks) {
    if (!/^Action:\s*failed/im.test(b)) continue;
    const address = /^Final-Recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)>?/im.exec(b)?.[1];
    if (!address) continue;
    const diagnostic = (/^Diagnostic-Code:\s*(?:smtp;\s*)?(.+(?:\r?\n[ \t].+)*)/im.exec(b)?.[1] ?? 'Returned by the receiving server')
      .replace(/\s+/g, ' ').trim().slice(0, 400);
    recipients.push({ address: address.toLowerCase(), diagnostic });
  }
  const ids = [...new Set([...raw.matchAll(/^(?:Message-ID|In-Reply-To|References):\s*(.+)$/gim)]
    .flatMap((m) => messageIdsIn(m[1])))];
  return { recipients, ids };
}

const addressesOf = (a: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((o) => o.value)
    .filter((v) => v.address)
    .map((v) => ({ address: v.address!.toLowerCase(), name: (v.name ?? '').slice(0, 200) }));

/* ── Storing one email ───────────────────────────────────────────────────── */

export interface InboundOwner { userId: string; address: string; name: string }

export interface StoreInboundInput {
  parsed: ParsedMail;
  raw: Buffer;
  /** The Tupo people this email is for. */
  owners: InboundOwner[];
  source: 'imap' | 'reply';
  folder?: 'inbox' | 'spam';
  /** Bring it to people's attention (false while back-filling a mailbox). */
  notify?: boolean;
  /** Already read in the person's real mailbox (\\Seen): imported as read. */
  read?: boolean;
  /** A Tupo person who wrote it (reply by email); they get a Sent copy. */
  author?: InboundOwner | null;
  importedFor?: string;
  env?: NodeJS.ProcessEnv;
}

export interface StoreInboundResult { messageId: string; threadId: string; owners: string[] }

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;

/**
 * Store one email as Tupo mail. Returns null when there is nothing to do: it
 * reached every owner before, or it is Tupo's own copy of a message they
 * already have.
 */
export async function storeInbound(input: StoreInboundInput): Promise<StoreInboundResult | null> {
  const env = input.env ?? process.env;
  const { parsed, raw } = input;
  const domains = ownDomains(env);
  const emailId = (parsed.messageId && messageIdsIn(parsed.messageId)[0])
    || `<${createHash('sha256').update(raw).digest('hex').slice(0, 32)}@inbound.tupo>`;
  const refs = [...messageIdsIn(parsed.inReplyTo), ...messageIdsIn(parsed.references).reverse()];
  const fromAddr = addressesOf(parsed.from)[0] ?? { address: '', name: '' };

  const pool = getPool();
  // Seen by everyone already: nothing to upload, nothing to store.
  const { rows: unseen } = await pool.query<{ user_id: string }>(
    `SELECT o.user_id FROM unnest($1::text[]) AS o(user_id)
      WHERE NOT EXISTS (SELECT 1 FROM mail_inbound_seen s WHERE s.user_id = o.user_id AND s.email_message_id = $2)`,
    [input.owners.map((o) => o.userId), emailId]);
  if (!unseen.length) return null;

  // Attachments first, so the message never shows without them. Their owner is
  // the first person it is for (mail attachment access follows the message).
  const attachmentsToStore = parsed.attachments.filter((a) => a.size <= MAX_ATTACHMENT_BYTES).slice(0, MAX_ATTACHMENTS);
  const stored: Array<{ fileId: string; name: string; mime: string; size: number }> = [];
  const firstOwner = input.owners.find((o) => o.userId === unseen[0]!.user_id) ?? input.owners[0]!;
  for (const [i, a] of attachmentsToStore.entries()) {
    const name = (a.filename || `attachment-${i + 1}`).slice(0, 300);
    const mime = a.contentType || 'application/octet-stream';
    const fileId = await storeAttachment(firstOwner.userId, name, mime, a.content, env).catch((e) => {
      console.error(`[mail:inbound] attachment ${name} of ${emailId} not stored:`, (e as Error).message);
      return null;
    });
    if (fileId) stored.push({ fileId, name, mime, size: a.size });
  }
  const dropFiles = () => (stored.length
    ? pool.query(`UPDATE files SET deleted_at = now() WHERE id = ANY($1)`, [stored.map((f) => f.fileId)]).catch(() => {})
    : Promise.resolve());

  const client = await pool.connect();
  let result: StoreInboundResult | null = null;
  try {
    await client.query('BEGIN');

    // Once per person per email, whichever way it arrived.
    const fresh: InboundOwner[] = [];
    for (const o of input.owners) {
      const { rowCount } = await client.query(
        `INSERT INTO mail_inbound_seen (user_id, email_message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [o.userId, emailId]);
      if (rowCount) fresh.push(o);
    }
    if (!fresh.length) { await client.query('ROLLBACK'); await dropFiles(); return null; }

    // Tupo's own email copy (MAIL_INTERNAL_EMAIL=on) coming back through the
    // person's mailbox: they already have it in Tupo.
    const ownId = tupoMessageIdOf(emailId, domains);
    if (ownId) {
      const { rows } = await client.query(
        `SELECT 1 FROM mail_messages m WHERE m.id = $1
            AND (m.from_user_id = ANY($2) OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id AND r.user_id = ANY($2)))`,
        [ownId, fresh.map((o) => o.userId)]);
      if (rows.length) { await client.query('COMMIT'); await dropFiles(); return null; }
    }

    // ── thread ──────────────────────────────────────────────────────────
    const people = fresh.map((o) => o.userId);
    let threadId: string | null = null;
    let parentId: string | null = null;
    let parentAt: Date | null = null;
    for (const ref of refs) {
      const tupoId = tupoMessageIdOf(ref, domains);
      const { rows } = await client.query<{ id: string; thread_id: string; created_at: Date }>(
        `SELECT m.id, m.thread_id, m.created_at FROM mail_messages m
          WHERE ${tupoId ? 'm.id = $1' : 'm.external_message_id = $1'}
            AND (m.from_user_id = ANY($2)
                 OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.thread_id = m.thread_id AND r.user_id = ANY($2) AND NOT r.is_hidden))
          ORDER BY m.created_at DESC LIMIT 1`,
        [tupoId ?? ref, people]);
      if (rows[0]) { threadId = rows[0].thread_id; parentId = rows[0].id; parentAt = new Date(rows[0].created_at); break; }
    }

    const subject = (parsed.subject ?? '').trim().slice(0, 300) || '(no subject)';
    const sentAt = parsed.date && !Number.isNaN(parsed.date.getTime()) && parsed.date.getTime() < Date.now() + 5 * 60_000
      ? parsed.date : new Date();
    // A reply always reads after what it answers: a Date header has only
    // whole seconds, and the writer's clock may be behind ours.
    const placedAt = parentAt && parentAt.getTime() >= sentAt.getTime() ? new Date(parentAt.getTime() + 1000) : sentAt;
    const fromName = (input.author?.name || fromAddr.name || fromAddr.address || 'Unknown sender').slice(0, 200);
    if (!threadId) {
      threadId = snowflake();
      await client.query(
        `INSERT INTO mail_threads (id, subject, subject_normalized, last_message_at, last_sender_id, last_sender_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [threadId, subject, normalizeSubject(subject), sentAt, input.author?.userId ?? null, fromName]);
    }

    // ── message ─────────────────────────────────────────────────────────
    const html = parsed.html
      ? sanitizeMailHtml(String(parsed.html).slice(0, 400_000))
      : `<p>${escapeHtml(parsed.text ?? '').replace(/\r?\n/g, '<br>')}</p>`;
    const text = (parsed.text?.trim() || htmlToText(html)).slice(0, 200_000);
    const to = addressesOf(parsed.to);
    const cc = addressesOf(parsed.cc);
    const messageId = snowflake();
    await client.query(
      `INSERT INTO mail_messages
         (id, thread_id, from_user_id, from_name, from_address, subject, body_html, body_text, snippet,
          parent_id, kind, is_draft, sent_at, created_at, updated_at, has_attachments, recipient_summary,
          metadata, source, external_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false,$12,$18,now(),$13,$14::jsonb,$15::jsonb,$16,$17)`,
      [messageId, threadId, input.author?.userId ?? null, fromName, fromAddr.address, subject, html, text,
       snippetOf(html, text), parentId, parentId ? 'reply' : 'new', sentAt, stored.length > 0,
       JSON.stringify({ to: to.length, cc: cc.length, bcc: 0 }),
       JSON.stringify({ importedFor: input.importedFor ?? null, inbound: input.source }),
       input.source, emailId, placedAt]);

    for (const [i, f] of stored.entries()) {
      await client.query(
        `INSERT INTO mail_attachments (id, message_id, file_id, name, mime, size, ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [snowflake(), messageId, f.fileId, f.name, f.mime, f.size, i]);
    }

    // ── copies ──────────────────────────────────────────────────────────
    const folder = input.folder ?? 'inbox';
    const ownerAddrs = new Set(fresh.map((o) => o.address.toLowerCase()));
    for (const o of fresh) {
      if (o.userId === input.author?.userId) continue;
      const kind = cc.some((c) => c.address === o.address.toLowerCase()) ? 'cc' : 'to';
      const id = snowflake();
      await client.query(
        `INSERT INTO mail_recipients (id, message_id, thread_id, kind, user_id, address, name, channel,
                                      delivery_status, delivered_at, folder, pending, is_read, read_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'inbound','delivered',now(),$8,false,$9,CASE WHEN $9 THEN now() END)`,
        [id, messageId, threadId, kind, o.userId, o.address, o.name, folder, input.read === true]);
      await recordEvent(client, id, messageId, 'delivered', { channel: 'inbound', source: input.source });
    }
    // The other addressees, for reading and for Reply all. Not mailboxes:
    // a Tupo person named here who has not connected gets nothing new.
    for (const [kind, list] of [['to', to], ['cc', cc]] as const) {
      for (const a of list) {
        if (ownerAddrs.has(a.address) || a.address === fromAddr.address) continue;
        await client.query(
          `INSERT INTO mail_recipients (id, message_id, thread_id, kind, user_id, address, name, channel,
                                        delivery_status, folder, pending, is_read)
           VALUES ($1,$2,$3,$4,NULL,$5,$6,'inbound','delivered','inbox',false,true)`,
          [snowflake(), messageId, threadId, kind, a.address, a.name]);
      }
    }
    if (input.author) {
      await client.query(
        `INSERT INTO mail_recipients (id, message_id, thread_id, kind, user_id, address, name, merge_vars,
                                      channel, delivery_status, folder, is_read, read_at, pending)
         VALUES ($1,$2,$3,'self',$4,$5,$6,'{}'::jsonb,'self','none','sent',true,now(),false)`,
        [`s${messageId}`, messageId, threadId, input.author.userId, input.author.address, input.author.name]);
    }

    await client.query(`UPDATE mail_inbound_seen SET mail_message_id = $3 WHERE user_id = ANY($1) AND email_message_id = $2`,
      [people, emailId, messageId]);
    await inheritThreadState(client, messageId, threadId);
    await client.query(
      `UPDATE mail_threads t SET
         last_message_at = GREATEST(t.last_message_at, $2), last_sender_id = $3, last_sender_name = $4,
         last_snippet = $5,
         message_count = (SELECT count(*) FROM mail_messages WHERE thread_id = $1 AND NOT is_draft AND sent_at IS NOT NULL),
         has_attachments = t.has_attachments OR $6
       WHERE t.id = $1`,
      [threadId, sentAt, input.author?.userId ?? null, fromName, snippetOf(html, text), stored.length > 0]);

    await client.query('COMMIT');
    result = { messageId, threadId, owners: people };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    await dropFiles();
    throw e;
  } finally {
    client.release();
  }

  if (input.notify !== false) {
    const subject = (parsed.subject ?? '').trim() || '(no subject)';
    const who = input.author?.name || fromAddr.name || fromAddr.address;
    const notifyIds = result.owners.filter((u) => u !== input.author?.userId);
    if (notifyIds.length && (input.folder ?? 'inbox') === 'inbox') {
      await notify(notifyIds, {
        kind: 'mail.received',
        title: `${who}: ${subject}`.slice(0, 200),
        body: snippetOf('', parsed.text ?? '') || null,
        link: `/app/mail/t/${result.threadId}`,
        subjectType: 'mail_message', subjectId: result.messageId,
      }).then((rows) => push(rows)).catch(() => { /* a missed toast is not a lost email */ });
    }
  }
  return result;
}

/** Bytes to tupo-files over its loopback internal route (the same secret the worker reads attachments with). */
async function storeAttachment(ownerId: string, name: string, mime: string, content: Buffer, env: NodeJS.ProcessEnv): Promise<string> {
  const secret = env.FILES_INTERNAL_SECRET ?? '';
  if (!secret) throw new Error('FILES_INTERNAL_SECRET is not set');
  const base = (env.FILES_INTERNAL_URL || 'http://127.0.0.1:5192').replace(/\/$/, '');
  const res = await fetch(`${base}/internal/files`, {
    method: 'POST',
    headers: {
      'x-internal-secret': secret, 'x-tenant-id': String(effectiveTid('mail attachment')),
      'x-owner-id': ownerId, 'x-file-name': encodeURIComponent(name), 'x-file-mime': mime,
      'content-type': 'application/octet-stream',
    },
    body: new Uint8Array(content),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`files answered ${res.status}`);
  const body = await res.json() as { data?: { fileId?: string } };
  if (!body.data?.fileId) throw new Error('files gave no id');
  return body.data.fileId;
}

/** A delivery report naming a Tupo email: mark those recipients bounced. Returns how many. */
export async function applyBounce(raw: string, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  const report = parseBounce(raw);
  if (!report) return null;
  const domains = ownDomains(env);
  const ids = report.ids.map((i) => tupoMessageIdOf(i, domains)).filter((x): x is string => Boolean(x));
  if (!ids.length || !report.recipients.length) return 0;
  const pool = getPool();
  let n = 0;
  for (const r of report.recipients) {
    const { rows } = await pool.query<{ id: string; message_id: string; user_id: string | null }>(
      `UPDATE mail_recipients SET delivery_status = 'bounced', delivery_error = $3, claimed_at = NULL
        WHERE message_id = ANY($1) AND lower(address) = $2 AND channel = 'smtp' AND delivery_status <> 'bounced'
        RETURNING id, message_id, user_id`, [ids, r.address, r.diagnostic]);
    for (const row of rows) {
      await recordEvent(pool, row.id, row.message_id, 'bounced', { error: r.diagnostic, via: 'delivery report' });
      if (!row.user_id) await suppress(r.address, 'bounce', r.diagnostic, row.message_id).catch(() => {});
      n++;
    }
  }
  return n;
}

/* ── A connected mailbox ─────────────────────────────────────────────────── */

interface HistoryState { nextUid: number | null; done: boolean; seen: number; total: number | null }

function historyMax(env: NodeJS.ProcessEnv): number {
  const n = parseInt(env.MAIL_HISTORY_MAX ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : HISTORY_MAX_DEFAULT;
}

/** Older mail read per sync (newest first), on top of the new mail. */
const HISTORY_PER_RUN = 100;
/** The most of a mailbox's history brought in (MAIL_HISTORY_MAX; 0 = all). */
const HISTORY_MAX_DEFAULT = 5000;
const PER_RUN_MAX = 100;
const MAX_EMAIL_BYTES = 30 * 1024 * 1024;

export interface SyncResult { imported: number; skipped: number; bounces: number; error?: string }

/**
 * Bring a person's new mail in. Claims the account first, so overlapping
 * sweeps (and "Sync now") never import the same message twice.
 */
export async function syncMailAccount(accountId: string, env: NodeJS.ProcessEnv = process.env): Promise<SyncResult> {
  const pool = getPool();
  const { rows } = await pool.query<MailAccountRow & { user_name: string }>(
    `UPDATE mail_accounts a SET sync_claimed_at = now()
       FROM users u
      WHERE a.id = $1 AND u.id = a.user_id AND a.status <> 'paused'
        AND (a.sync_claimed_at IS NULL OR a.sync_claimed_at < now() - interval '10 minutes')
      RETURNING a.*, u.name AS user_name`, [accountId]);
  const acct = rows[0];
  if (!acct) return { imported: 0, skipped: 0, bounces: 0 };

  const out: SyncResult = { imported: 0, skipped: 0, bounces: 0 };
  let lastUid = Number(acct.last_uid) || 0;
  let uidValidity = acct.uid_validity;
  let history: HistoryState = {
    nextUid: acct.history_next_uid == null ? null : Number(acct.history_next_uid),
    done: acct.history_done === true, seen: Number(acct.history_seen) || 0,
    total: acct.mailbox_total == null ? null : Number(acct.mailbox_total),
  };
  let client: ReturnType<typeof imapClient> | null = null;
  try {
    client = imapClient({
      host: acct.imap_host, port: acct.imap_port, secure: acct.imap_secure,
      user: acct.username, pass: decryptSecret(acct.secret_enc, env),
    });
    client.on('error', () => { /* surfaced by the awaited call */ });
    await client.connect();
    // Read-only: Tupo never changes the person's real mailbox (no \Seen, no moves).
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const mailbox = client.mailbox;
      const validity = mailbox && typeof mailbox === 'object' ? String(mailbox.uidValidity) : null;
      const uidNext = mailbox && typeof mailbox === 'object' && mailbox.uidNext ? Number(mailbox.uidNext) : null;
      const total = mailbox && typeof mailbox === 'object' && typeof mailbox.exists === 'number' ? mailbox.exists : null;
      if (!uidValidity || validity !== uidValidity) {
        // First sync, or the server renumbered the mailbox: everything now in
        // it is history (read below, newest first, without notifications);
        // only mail arriving from here on counts as new. Seen-once storage
        // keeps a renumbered mailbox from importing anything twice.
        uidValidity = validity;
        lastUid = uidNext ? uidNext - 1 : 0;
        history = { nextUid: uidNext ?? lastUid + 1, done: false, seen: 0, total };
      }
      const owner: InboundOwner = { userId: acct.user_id, address: acct.address, name: acct.user_name };
      const importOne = async (uid: number, isNew: boolean): Promise<void> => {
        const msg = await client!.fetchOne(String(uid), { uid: true, source: true, flags: true, size: true }, { uid: true });
        if (!msg || !msg.source || (msg.size ?? msg.source.length) > MAX_EMAIL_BYTES) { out.skipped++; return; }
        const raw = msg.source;
        // Delivery reports act on Tupo's own sent mail only while fresh.
        if (isNew) {
          const bounced = await applyBounce(raw.toString('utf8'), env);
          if (bounced !== null && bounced > 0) { out.bounces += bounced; return; }
        }
        const parsed = await simpleParser(raw);
        const stored = await storeInbound({
          parsed, raw, owners: [owner], source: 'imap', importedFor: acct.user_id,
          folder: looksLikeSpam(parsed, msg.flags) ? 'spam' : 'inbox',
          notify: isNew, read: msg.flags?.has('\\Seen') ?? false, env,
        });
        if (stored) out.imported++; else out.skipped++;
      };

      // New mail, oldest first, so a failure part-way resumes where it stopped.
      const found = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
      // `n:*` always matches the newest message, even when it is older than n.
      const fresh = (Array.isArray(found) ? found : []).filter((u) => u > lastUid).sort((a, b) => a - b).slice(0, PER_RUN_MAX);
      for (const uid of fresh) {
        await importOne(uid, true);
        lastUid = uid;
      }

      // Then a page of history, newest first, down to the start of the mailbox.
      const cap = historyMax(env);
      if (!history.done) {
        const upper = history.nextUid ?? lastUid + 1;
        const older = upper > 1 ? await client.search({ uid: `1:${upper - 1}` }, { uid: true }) : [];
        const below = (Array.isArray(older) ? older : []).filter((u) => u < upper).sort((a, b) => b - a);
        const room = cap > 0 ? Math.max(0, cap - history.seen) : Infinity;
        const page = below.slice(0, Math.min(HISTORY_PER_RUN, room));
        if (history.total === null) history.total = total;
        for (const uid of page) {
          try {
            await importOne(uid, false);
          } catch (e) {
            // A dropped connection stops the run (the next one resumes here);
            // one email that cannot be read or stored is skipped, so it does
            // not hold back the rest of the history for ever.
            if (!client.usable) throw e;
            console.warn(`[mail] history import skipped uid ${uid} for ${acct.address}: ${(e as Error).message}`);
            out.skipped++;
          }
          history.nextUid = uid;
          history.seen++;
        }
        if (page.length === below.length || (cap > 0 && history.seen >= cap)) history.done = true;
      }
    } finally {
      lock.release();
    }
    await client.logout().catch(() => {});
    await pool.query(
      `UPDATE mail_accounts SET last_sync_at = now(), last_error = NULL, status = 'active', sync_claimed_at = NULL,
              uid_validity = $2, last_uid = $3, imported_count = imported_count + $4, updated_at = now(),
              history_next_uid = $5, history_done = $6, history_seen = $7, mailbox_total = $8
        WHERE id = $1`, [accountId, uidValidity, lastUid, out.imported, history.nextUid, history.done, history.seen, history.total]);
  } catch (e) {
    client?.close();
    const err = e as { authenticationFailed?: boolean; message?: string };
    const auth = Boolean(err.authenticationFailed);
    out.error = auth ? 'The password no longer works. Reconnect your mailbox in Mail settings.'
      : `Could not read your mailbox: ${(err.message ?? 'unknown error').slice(0, 200)}`;
    await pool.query(
      `UPDATE mail_accounts SET last_sync_at = now(), last_error = $2, sync_claimed_at = NULL,
              status = CASE WHEN $3 THEN 'error' ELSE status END,
              uid_validity = $4, last_uid = $5, imported_count = imported_count + $6, updated_at = now(),
              history_next_uid = $7, history_done = $8, history_seen = $9, mailbox_total = $10
        WHERE id = $1`, [accountId, out.error, auth, uidValidity, lastUid, out.imported,
                         history.nextUid, history.done, history.seen, history.total]);
  }
  return out;
}

/** The sweep: every connected mailbox not synced in the last interval. */
export async function syncDueMailAccounts(env: NodeJS.ProcessEnv = process.env): Promise<{ accounts: number; imported: number }> {
  const everySec = Math.max(15, parseInt(env.MAIL_INBOUND_EVERY_SECONDS ?? '', 10) || 60);
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM mail_accounts
      WHERE status <> 'paused'
        AND (last_sync_at IS NULL
             OR last_sync_at < now() - make_interval(secs => CASE WHEN status = 'error' THEN 1800 ELSE $1 END))
        AND (sync_claimed_at IS NULL OR sync_claimed_at < now() - interval '10 minutes')
      ORDER BY last_sync_at NULLS FIRST LIMIT 50`, [everySec - 5]);
  let imported = 0;
  // Three at a time: a slow mailbox does not hold up the rest.
  const queue = rows.map((r) => r.id);
  await Promise.all([0, 1, 2].map(async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const r = await syncMailAccount(id, env).catch((e) => ({ imported: 0, error: String(e) }));
      imported += r.imported;
    }
  }));
  return { accounts: rows.length, imported };
}

/* ── Shared reply capture (the relay's mailbox) ──────────────────────────── */

export function replyCaptureLogin(env: NodeJS.ProcessEnv = process.env) {
  const cfg = mailServerConfig(env);
  const user = env.MAIL_REPLY_IMAP_USER || env.SMTP_USER || '';
  const pass = env.MAIL_REPLY_IMAP_PASS || env.SMTP_PASS || '';
  // Its own host/port when the relay's mailbox lives elsewhere; the school's mail server otherwise.
  const host = (env.MAIL_REPLY_IMAP_HOST || cfg.imapHost || '').trim();
  const port = parseInt(env.MAIL_REPLY_IMAP_PORT ?? '', 10) || cfg.imapPort;
  if (!replyCaptureEnabled(env) || !host || !user || !pass) return null;
  return {
    host, port, secure: env.MAIL_REPLY_IMAP_PORT ? port === 993 || /^(1|true|on|yes)$/i.test(env.MAIL_REPLY_IMAP_SECURE ?? '') : cfg.imapSecure,
    user, pass,
    address: (env.MAIL_REPLY_ADDRESS || (user.includes('@') ? user : bareAddress(env.MAIL_FROM ?? ''))).toLowerCase(),
  };
}

/**
 * Read the relay's mailbox for outside replies to Tupo mail and delivery
 * reports. Only mail that names a Tupo message is used; everything else in
 * that mailbox (it is shared with the MIS) is left alone, and nothing is
 * changed there. The first run starts at the newest message: history is not
 * replayed into Tupo.
 */
export async function syncReplyMailbox(env: NodeJS.ProcessEnv = process.env): Promise<{ matched: number; bounces: number; skipped: number } | null> {
  const login = replyCaptureLogin(env);
  if (!login) return null;
  const pool = getPool();
  await pool.query(`INSERT INTO mail_reply_capture_state DEFAULT VALUES ON CONFLICT DO NOTHING`);
  const { rows: st } = await pool.query<{ uid_validity: string | null; last_uid: string }>(
    `SELECT uid_validity, last_uid FROM mail_reply_capture_state FOR UPDATE SKIP LOCKED`);
  const state = st[0];
  if (!state) return null;
  const out = { matched: 0, bounces: 0, skipped: 0 };
  const domains = ownDomains(env);
  let lastUid = Number(state.last_uid) || 0;
  let validity = state.uid_validity;
  const client = imapClient(login);
  client.on('error', () => { /* surfaced by the awaited call */ });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const mb = client.mailbox && typeof client.mailbox === 'object' ? client.mailbox : null;
      const v = mb ? String(mb.uidValidity) : null;
      if (!validity || v !== validity) {
        validity = v;
        lastUid = mb?.uidNext ? Number(mb.uidNext) - 1 : 0;
      } else {
        const found = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
        const uids = (Array.isArray(found) ? found : []).filter((u) => u > lastUid).sort((a, b) => a - b).slice(0, PER_RUN_MAX);
        for (const uid of uids) {
          lastUid = uid;
          const msg = await client.fetchOne(String(uid), { uid: true, source: true, size: true }, { uid: true });
          if (!msg || !msg.source || (msg.size ?? msg.source.length) > MAX_EMAIL_BYTES) { out.skipped++; continue; }
          const rawText = msg.source.toString('utf8');
          const bounced = await applyBounce(rawText, env);
          if (bounced !== null) { out.bounces += bounced; continue; }
          const parsed = await simpleParser(msg.source);
          const refs = [...messageIdsIn(parsed.inReplyTo), ...messageIdsIn(parsed.references).reverse()];
          const tupoIds = refs.map((r) => tupoMessageIdOf(r, domains)).filter((x): x is string => Boolean(x));
          if (!tupoIds.length) { out.skipped++; continue; }
          const delivered = await deliverCapturedReply(parsed, msg.source, tupoIds, login.address, env);
          if (delivered) out.matched++; else out.skipped++;
        }
      }
    } finally {
      lock.release();
    }
    await client.logout().catch(() => {});
    await pool.query(
      `UPDATE mail_reply_capture_state SET uid_validity = $1, last_uid = $2, last_sync_at = now(), last_error = NULL,
              matched = matched + $3, bounces = bounces + $4`, [validity, lastUid, out.matched, out.bounces]);
  } catch (e) {
    client.close();
    await pool.query(
      `UPDATE mail_reply_capture_state SET uid_validity = $1, last_uid = $2, last_sync_at = now(), last_error = $3`,
      [validity, lastUid, String((e as Error).message ?? e).slice(0, 300)]);
  }
  return out;
}

/**
 * An outside reply to a Tupo message, caught in the relay's mailbox: into the
 * conversation, for the Tupo people on the message it answers. When the
 * writer is themselves a Tupo person (replying to their email copy), it is
 * their reply, sent by email: theirs in Sent, everyone else's in Inbox.
 */
async function deliverCapturedReply(
  parsed: ParsedMail, raw: Buffer, tupoIds: string[], relayAddress: string, env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const pool = getPool();
  const { rows: msgs } = await pool.query<{ id: string; thread_id: string }>(
    `SELECT id, thread_id FROM mail_messages WHERE id = ANY($1) ORDER BY created_at DESC LIMIT 1`, [tupoIds]);
  const target = msgs[0];
  if (!target) return false;
  const from = addressesOf(parsed.from)[0];
  if (!from || from.address === relayAddress) return false; // our own mail, looped back

  // Everyone with a mailbox copy in the conversation, plus its writers.
  const { rows: people } = await pool.query<{ user_id: string; address: string; name: string }>(
    `SELECT DISTINCT ON (u.id) u.id AS user_id, COALESCE(NULLIF(u.email, ''), '') AS address, u.name
       FROM users u
      WHERE u.id IN (
              SELECT from_user_id FROM mail_messages WHERE thread_id = $1 AND from_user_id IS NOT NULL
              UNION SELECT user_id FROM mail_recipients WHERE thread_id = $1 AND user_id IS NOT NULL
                       AND kind <> 'bcc' AND NOT is_hidden)
        AND u.status = 'active'`, [target.thread_id]);
  if (!people.length) return false;
  const author = people.find((p) => p.address.toLowerCase() === from.address) ?? null;
  const owners = people.map((p) => ({ userId: p.user_id, address: p.address || `${p.user_id}@tupo.local`, name: p.name }));
  const stored = await storeInbound({
    parsed, raw, owners, source: 'reply', env,
    author: author ? { userId: author.user_id, address: author.address, name: author.name } : null,
  });
  return Boolean(stored);
}
