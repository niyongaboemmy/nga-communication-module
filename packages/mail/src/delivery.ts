/**
 * Delivery — the one place a `mail_recipients` row changes state, and the one
 * place a `mail_delivery_events` row is written (FR-MAIL-7, FR-MAIL-8).
 *
 * Two channels:
 *   in_app  — the recipient has a Tupo account and has not opted into email
 *             copies. Delivered synchronously: a row flip plus a notification.
 *             No SMTP, ever (FR-MAIL-9).
 *   smtp    — an external address, or an internal user who wants email too.
 *             Left `queued` here; the worker picks it up and calls `sendSmtp`.
 */
import type { PoolClient } from 'pg';
import { getPool, snowflake } from '@tupo/db';
import { notify, push } from '@tupo/notify';
import { smtpConfigFromEnv, sendSmtp, bareAddress, type OutboundMail } from './smtp.js';
import { wrapEmailHtml } from './render.js';
import {
  emailAttachments, omittedNote, emailMessageId, threadHeaders, unsubscribeUrl,
} from './outbound.js';

type Db = PoolClient | ReturnType<typeof getPool>;

export async function recordEvent(
  db: Db, recipientId: string, messageId: string, type: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO mail_delivery_events (id, recipient_id, message_id, type, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [snowflake(), recipientId, messageId, type, JSON.stringify(detail)],
  );
}

export async function isSuppressed(address: string): Promise<{ reason: string } | null> {
  const { rows } = await getPool().query<{ reason: string }>(
    'SELECT reason FROM mail_suppressions WHERE address = $1', [address.toLowerCase()],
  );
  return rows[0] ?? null;
}

export async function suppress(
  address: string, reason: string, note = '', sourceMessageId?: string, by?: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO mail_suppressions (address, reason, note, source_message_id, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (address) DO UPDATE SET reason = EXCLUDED.reason, note = EXCLUDED.note`,
    [address.toLowerCase(), reason, note, sourceMessageId ?? null, by ?? null],
  );
}

export async function unsuppress(address: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    'DELETE FROM mail_suppressions WHERE address = $1', [address.toLowerCase()]);
  return (rowCount ?? 0) > 0;
}

/**
 * Deliver the in-app copies for a just-sent message, synchronously.
 * Returns the count delivered. SMTP recipients are untouched — the worker owns
 * those.
 */
export async function deliverInApp(messageId: string): Promise<number> {
  const pool = getPool();
  const { rows: msg } = await pool.query<{
    from_user_id: string; from_name: string; subject: string; thread_id: string; snippet: string;
    is_draft: boolean; scheduled_at: string | null; sent_at: string | null;
  }>(
    `SELECT from_user_id, from_name, subject, thread_id, snippet, is_draft, scheduled_at, sent_at
       FROM mail_messages WHERE id = $1`, [messageId],
  );
  const m = msg[0];
  if (!m || m.is_draft) return 0;

  const { rows: recipients } = await pool.query<{ id: string; user_id: string; address: string }>(
    `SELECT id, user_id, address FROM mail_recipients
      WHERE message_id = $1 AND channel = 'in_app' AND delivery_status = 'queued'`,
    [messageId],
  );

  let delivered = 0;
  for (const r of recipients) {
    await pool.query(
      `UPDATE mail_recipients
          SET delivery_status = 'delivered', sent_at = now(), delivered_at = now(), attempts = attempts + 1
        WHERE id = $1`, [r.id],
    );
    await recordEvent(pool, r.id, messageId, 'sent', { channel: 'in_app' });
    await recordEvent(pool, r.id, messageId, 'delivered', { channel: 'in_app' });
    delivered++;

    if (r.user_id && r.user_id !== m.from_user_id) {
      await notify([r.user_id], {
        kind: 'mail.received',
        title: `${m.from_name}: ${m.subject}`.slice(0, 200),
        body: m.snippet || null,
        link: `/app/mail/t/${m.thread_id}`,
        // Per message, not per thread: a notification already read for the
        // first mail of a thread must not swallow the reply that follows it.
        subjectType: 'mail_message',
        subjectId: messageId,
      }).then((rows) => push(rows)).catch(() => { /* a missed toast is not a failed delivery */ });
    }
  }
  return delivered;
}

export const MAX_SMTP_ATTEMPTS = 5;
/** Retry spacing after the n-th failed attempt: 1 min, 5 min, 30 min, 2 h. */
const BACKOFF = ['1 minute', '5 minutes', '30 minutes', '2 hours'];
const backoff = (attempts: number) => BACKOFF[Math.min(attempts, BACKOFF.length - 1)]!;
/**
 * A transient failure stays 'queued' (still being tried — counts and the
 * campaign roll-up keep waiting for it) until the last attempt, then 'failed'.
 * `$3` is MAX_SMTP_ATTEMPTS in the statement it is used in.
 */
const RETRY_OR_FAIL = `CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'queued' END`;

/** The most recent relay-level failure, for the worker's health endpoint. */
export let lastTransportError: { at: string; error: string } | null = null;

/**
 * Send the SMTP copies for one message. Called by the worker, the sweep and
 * campaign runs — safely at the same time: rows are claimed atomically, so
 * each copy is sent once.
 */
export async function deliverSmtp(
  messageId: string, env: NodeJS.ProcessEnv = process.env,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const pool = getPool();
  const cfg = smtpConfigFromEnv(env);

  const { rows: msg } = await pool.query<{
    from_name: string; from_address: string; subject: string; body_html: string; body_text: string;
    is_draft: boolean; scheduled_at: string | null; campaign_id: string | null;
  }>(
    `SELECT from_name, from_address, subject, body_html, body_text, is_draft, scheduled_at, campaign_id
       FROM mail_messages WHERE id = $1`, [messageId],
  );
  const m = msg[0];
  if (!m || m.is_draft) return { sent: 0, failed: 0, skipped: 0 };
  // A scheduled message's email must not go out before its time — the sweep
  // picks it up once `scheduled_at` has passed.
  if (m.scheduled_at && new Date(m.scheduled_at).getTime() > Date.now()) {
    return { sent: 0, failed: 0, skipped: 0 };
  }

  // Claim, atomically: only rows due now, and rows another worker left in
  // 'sending' long enough ago that it must have died. SKIP LOCKED means the
  // mail:send job, the 30 s sweep and a campaign run can overlap without two
  // of them ever sending the same copy (MAIL-H4).
  const { rows: recipients } = await pool.query<{
    id: string; address: string; name: string; user_id: string | null; attempts: number;
  }>(
    `UPDATE mail_recipients r SET delivery_status = 'sending', claimed_at = now()
      WHERE r.id IN (
        SELECT id FROM mail_recipients
         WHERE message_id = $1 AND channel = 'smtp'
           AND ((delivery_status IN ('queued', 'failed') AND attempts < $2
                 AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
             OR (delivery_status = 'sending' AND (claimed_at IS NULL OR claimed_at < now() - interval '10 minutes')))
         FOR UPDATE SKIP LOCKED)
      RETURNING r.id, r.address, r.name, r.user_id, r.attempts`,
    [messageId, MAX_SMTP_ATTEMPTS],
  );

  // In the order they were added: RETURNING has no order, and whether the
  // copies after a relay failure were tried depended on how rows came back.
  const toId = (id: string) => { try { return BigInt(id); } catch { return 0n; } };
  recipients.sort((a, b) => (toId(a.id) < toId(b.id) ? -1 : toId(a.id) > toId(b.id) ? 1 : a.id.localeCompare(b.id)));

  let sent = 0, failed = 0, skipped = 0;
  let transportDown = false;

  // Built once per message, and only when a copy is really about to go out:
  // the attachments' bytes, and the headers that thread it.
  let prepared: Promise<Omit<OutboundMail, 'to' | 'toName' | 'headers'>> | null = null;
  const prepare = (domain: string) => (prepared ??= (async () => {
    const [files, thread] = await Promise.all([emailAttachments(messageId, env), threadHeaders(messageId, domain)]);
    const note = omittedNote(files.omitted);
    return {
      fromName: m.from_name,
      replyTo: m.from_address || undefined,
      subject: m.subject,
      html: wrapEmailHtml(m.body_html + (note?.html ?? '')),
      text: m.body_text + (note?.text ?? ''),
      attachments: files.attachments.length ? files.attachments : undefined,
      messageId: emailMessageId(messageId, domain),
      inReplyTo: thread.inReplyTo,
      references: thread.references,
    };
  })());
  for (const r of recipients) {
    // The relay itself is failing: put the rest back untouched for the next
    // attempt rather than burning an attempt on every one of them.
    if (transportDown) {
      await pool.query(
        `UPDATE mail_recipients SET delivery_status = 'queued', claimed_at = NULL,
                next_attempt_at = now() + interval '1 minute' WHERE id = $1`, [r.id]);
      continue;
    }

    const supp = await isSuppressed(r.address);
    if (supp) {
      await pool.query(
        `UPDATE mail_recipients SET delivery_status = 'suppressed', delivery_error = $2, claimed_at = NULL WHERE id = $1`,
        [r.id, `address suppressed (${supp.reason})`],
      );
      await recordEvent(pool, r.id, messageId, 'suppressed', supp);
      skipped++;
      continue;
    }

    if (!cfg) {
      await pool.query(
        `UPDATE mail_recipients SET delivery_status = ${RETRY_OR_FAIL}, claimed_at = NULL,
                delivery_error = 'no SMTP relay configured', attempts = attempts + 1,
                next_attempt_at = now() + $2::interval WHERE id = $1`,
        [r.id, backoff(r.attempts), MAX_SMTP_ATTEMPTS],
      );
      await recordEvent(pool, r.id, messageId, 'failed', { reason: 'no SMTP relay configured' });
      failed++;
      continue;
    }

    const base = await prepare(bareAddress(cfg.from).split('@')[1] || 'tupo.local');
    // Bulk mail carries a one-click unsubscribe (RFC 8058): mail providers
    // expect it, and without it a campaign is far more likely to land in spam.
    const unsubscribe = m.campaign_id ? unsubscribeUrl(r.address, env) : null;
    const result = await sendSmtp(cfg, {
      ...base,
      to: r.address,
      toName: r.name,
      headers: unsubscribe
        ? { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
        : undefined,
    });

    if (result.ok) {
      await pool.query(
        `UPDATE mail_recipients SET delivery_status = 'delivered', sent_at = now(), claimed_at = NULL,
                delivered_at = now(), attempts = attempts + 1, delivery_error = NULL WHERE id = $1`,
        [r.id],
      );
      await recordEvent(pool, r.id, messageId, 'sent', { messageId: result.messageId });
      await recordEvent(pool, r.id, messageId, 'delivered', { channel: 'smtp' });
      sent++;
      continue;
    }

    const failure = result.failure ?? 'transport';
    if (failure === 'transport') {
      transportDown = true;
      lastTransportError = { at: new Date().toISOString(), error: result.error ?? 'send failed' };
      console.error(`[mail] SMTP relay failure — retrying later, nothing suppressed: ${result.error}`);
      await pool.query(
        `UPDATE mail_recipients SET delivery_status = ${RETRY_OR_FAIL.replace('$3', '$4')}, claimed_at = NULL,
                delivery_error = $2, attempts = attempts + 1, next_attempt_at = now() + $3::interval WHERE id = $1`,
        [r.id, result.error ?? 'send failed', backoff(r.attempts), MAX_SMTP_ATTEMPTS],
      );
      await recordEvent(pool, r.id, messageId, 'failed', { error: result.error, transient: true });
      failed++;
      continue;
    }

    // Refused for good: this address (recipient) or this message (content).
    // attempts is pushed to the cap so no sweep retries it.
    const bounced = failure === 'recipient';
    await pool.query(
      `UPDATE mail_recipients
          SET delivery_status = $2, delivery_error = $3, claimed_at = NULL,
              attempts = GREATEST(attempts + 1, $4) WHERE id = $1`,
      [r.id, bounced ? 'bounced' : 'failed', result.error ?? 'send failed', MAX_SMTP_ATTEMPTS],
    );
    await recordEvent(pool, r.id, messageId, bounced ? 'bounced' : 'failed', { error: result.error, failure });
    // Suppression is for outside addresses. A colleague's school address that
    // bounced once is a relay problem to fix, not a person to stop mailing.
    if (bounced && !r.user_id) await suppress(r.address, 'bounce', result.error ?? '', messageId);
    failed++;
  }
  return { sent, failed, skipped };
}
