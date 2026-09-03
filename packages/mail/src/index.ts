/**
 * @tupo/mail — the mail domain.
 *
 * Imported by tupo-api (reads, compose) and tupo-worker (scheduled sends,
 * campaigns, SMTP dispatch, list sync). Authorisation for reading a thread and
 * for delivering a message lives here so it cannot differ between the two.
 */
export * from './errors.js';
export * from './config.js';
export * from './render.js';
export * from './smtp.js';
export * from './delivery.js';
export * from './service.js';
export * from './lists.js';
export * from './templates.js';
export * from './campaigns.js';

import { deliverSmtp } from './delivery.js';
import { getPool } from '@tupo/db';

/**
 * Worker sweep: send the SMTP copies for every message that still has queued
 * SMTP recipients (scheduled sends whose time has come, and anything the
 * immediate `mail:send` job missed).
 */
export async function dispatchPendingSmtp(env: NodeJS.ProcessEnv = process.env): Promise<{ messages: number }> {
  const { rows } = await getPool().query<{ message_id: string }>(
    `SELECT DISTINCT r.message_id
       FROM mail_recipients r
       JOIN mail_messages m ON m.id = r.message_id
      WHERE r.channel = 'smtp' AND r.delivery_status IN ('queued', 'failed') AND r.attempts < 4
        AND NOT m.is_draft
        AND (m.scheduled_at IS NULL OR m.scheduled_at <= now())
      LIMIT 200`,
  );
  for (const r of rows) {
    try { await deliverSmtp(r.message_id, env); }
    catch (e) { console.error(`[mail] SMTP dispatch ${r.message_id} failed:`, e); }
  }
  return { messages: rows.length };
}

/**
 * Worker sweep: promote scheduled messages whose time has arrived (FR-MAIL-10)
 * and deliver their in-app copies. SMTP copies are picked up by
 * `dispatchPendingSmtp`.
 */
export async function sendDueScheduled(): Promise<{ sent: number }> {
  const { deliverInApp } = await import('./delivery.js');
  const { rows } = await getPool().query<{ id: string }>(
    `UPDATE mail_messages SET sent_at = now(), updated_at = now()
      WHERE scheduled_at IS NOT NULL AND sent_at IS NULL AND NOT is_draft AND scheduled_at <= now()
      RETURNING id`,
  );
  for (const r of rows) {
    try { await deliverInApp(r.id); }
    catch (e) { console.error(`[mail] scheduled send ${r.id} failed:`, e); }
  }
  return { sent: rows.length };
}
