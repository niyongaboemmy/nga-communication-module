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
import { smtpConfigFromEnv, sendSmtp } from './smtp.js';
import { wrapEmailHtml } from './render.js';

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
        subjectType: 'mail_thread',
        subjectId: m.thread_id,
      }).then((rows) => push(rows)).catch(() => { /* a missed toast is not a failed delivery */ });
    }
  }
  return delivered;
}

/**
 * Send the SMTP copies for one message. Called by the worker. Idempotent:
 * only touches rows still `queued`/`failed` on the smtp channel.
 */
export async function deliverSmtp(
  messageId: string, env: NodeJS.ProcessEnv = process.env,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const pool = getPool();
  const cfg = smtpConfigFromEnv(env);

  const { rows: msg } = await pool.query<{
    from_name: string; from_address: string; subject: string; body_html: string; body_text: string;
    is_draft: boolean;
  }>(
    `SELECT from_name, from_address, subject, body_html, body_text, is_draft
       FROM mail_messages WHERE id = $1`, [messageId],
  );
  const m = msg[0];
  if (!m || m.is_draft) return { sent: 0, failed: 0, skipped: 0 };

  const { rows: recipients } = await pool.query<{
    id: string; address: string; name: string;
  }>(
    `SELECT id, address, name FROM mail_recipients
      WHERE message_id = $1 AND channel = 'smtp'
        AND delivery_status IN ('queued', 'failed') AND attempts < 4`,
    [messageId],
  );

  let sent = 0, failed = 0, skipped = 0;
  for (const r of recipients) {
    const supp = await isSuppressed(r.address);
    if (supp) {
      await pool.query(
        `UPDATE mail_recipients SET delivery_status = 'suppressed', delivery_error = $2 WHERE id = $1`,
        [r.id, `address suppressed (${supp.reason})`],
      );
      await recordEvent(pool, r.id, messageId, 'suppressed', supp);
      skipped++;
      continue;
    }

    if (!cfg) {
      await pool.query(
        `UPDATE mail_recipients SET delivery_status = 'failed',
                delivery_error = 'no SMTP relay configured', attempts = attempts + 1 WHERE id = $1`,
        [r.id],
      );
      await recordEvent(pool, r.id, messageId, 'failed', { reason: 'no SMTP relay configured' });
      failed++;
      continue;
    }

    await pool.query(`UPDATE mail_recipients SET delivery_status = 'sending' WHERE id = $1`, [r.id]);
    const result = await sendSmtp(cfg, {
      to: r.address,
      toName: r.name,
      fromName: m.from_name,
      replyTo: m.from_address || undefined,
      subject: m.subject,
      html: wrapEmailHtml(m.body_html),
      text: m.body_text,
    });

    if (result.ok) {
      await pool.query(
        `UPDATE mail_recipients SET delivery_status = 'delivered', sent_at = now(),
                delivered_at = now(), attempts = attempts + 1, delivery_error = NULL WHERE id = $1`,
        [r.id],
      );
      await recordEvent(pool, r.id, messageId, 'sent', { messageId: result.messageId });
      await recordEvent(pool, r.id, messageId, 'delivered', { channel: 'smtp' });
      sent++;
    } else {
      const permanent = result.permanent ?? false;
      await pool.query(
        `UPDATE mail_recipients
            SET delivery_status = $2, delivery_error = $3, attempts = attempts + 1 WHERE id = $1`,
        [r.id, permanent ? 'bounced' : 'failed', result.error ?? 'send failed'],
      );
      await recordEvent(pool, r.id, messageId, permanent ? 'bounced' : 'failed',
        { error: result.error, permanent });
      if (permanent) await suppress(r.address, 'bounce', result.error ?? '', messageId);
      failed++;
    }
  }
  return { sent, failed, skipped };
}
