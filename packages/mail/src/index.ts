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
export * from './sanitize.js';
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
  const { releaseMessage } = await import('./service.js');
  const pool = getPool();
  const client = await pool.connect();
  let ids: string[] = [];
  try {
    await client.query('BEGIN');
    // SKIP LOCKED: two overlapping sweeps never release the same message twice.
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM mail_messages
        WHERE scheduled_at IS NOT NULL AND sent_at IS NULL AND NOT is_draft AND scheduled_at <= now()
        ORDER BY scheduled_at
        LIMIT 200
        FOR UPDATE SKIP LOCKED`,
    );
    ids = rows.map((r) => r.id);
    for (const id of ids) await releaseMessage(client, id);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  for (const id of ids) {
    try { await deliverInApp(id); }
    catch (e) { console.error(`[mail] scheduled send ${id} failed:`, e); }
  }
  return { sent: ids.length };
}
