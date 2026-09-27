/**
 * Bulk announcements (FR-MAIL-5, FR-MAIL-8, FR-MAIL-10).
 *
 * A campaign is: a body (ad-hoc or from a template) with `{{merge}}` fields,
 * one or more distribution lists, a preview step, an approval gate for large
 * audiences, and per-recipient delivery tracking.
 *
 * When it runs, each recipient gets their **own** thread and message — a
 * personalised copy, not a shared thread — so merge fields work and nobody
 * sees the rest of the list. `campaign_id` ties them back together and the
 * sender's mailbox shows one campaign, not five hundred messages.
 */
import type { PoolClient } from 'pg';
import { getPool, snowflake } from '@tupo/db';
import { notify, push } from '@tupo/notify';
import {
  MAIL_APPROVAL_THRESHOLD, normalizeSubject,
} from '@tupo/shared';
import type { MailCampaignPayload, MailCampaignView, MailPerson } from '@tupo/shared';
import { MailError } from './errors.js';
import { internalEmailDelivery } from './config.js';
import { renderMerge, htmlToText, snippetOf, isEmailAddress } from './render.js';
import { getPrefs } from './service.js';
import { deliverInApp } from './delivery.js';
import { deliverSmtp } from './delivery.js';

const rowTo = (r: Record<string, unknown>, from: MailPerson): MailCampaignView => ({
  id: r.id as string, name: (r.name as string) ?? '', subject: r.subject as string,
  bodyHtml: r.body_html as string, bodyText: r.body_text as string,
  templateId: (r.template_id as string) ?? null, from,
  status: r.status as MailCampaignView['status'],
  listIds: (r.list_ids as string[]) ?? [], extraRecipients: (r.extra_recipients as MailCampaignView['extraRecipients']) ?? [],
  scheduledAt: (r.scheduled_at as string) ?? null,
  requiresApproval: r.requires_approval as boolean,
  approvedBy: (r.approved_by as string) ?? null, approvedAt: (r.approved_at as string) ?? null,
  rejectedReason: (r.rejected_reason as string) ?? null,
  totalRecipients: r.total_recipients as number, counts: (r.counts as Record<string, number>) ?? {},
  createdAt: r.created_at as string, startedAt: (r.started_at as string) ?? null,
  finishedAt: (r.finished_at as string) ?? null,
});

async function personFor(userId: string): Promise<MailPerson> {
  const { rows } = await getPool().query<{ name: string; email: string }>(
    `SELECT name, email FROM users WHERE id = $1`, [userId],
  );
  const prefs = await getPrefs(userId);
  return {
    userId, name: prefs.displayName || rows[0]?.name || 'Unknown',
    address: rows[0]?.email ?? '', avatarUrl: null,
  };
}

export async function getCampaign(userId: string, id: string, canSeeAll = false): Promise<MailCampaignView> {
  const { rows } = await getPool().query(
    `SELECT * FROM mail_campaigns WHERE id = $1 AND ($2 OR created_by = $3)`, [id, canSeeAll, userId],
  );
  if (!rows[0]) throw new MailError('Campaign not found.', 404);
  return rowTo(rows[0], await personFor(rows[0].from_user_id));
}

export async function listCampaigns(userId: string, canSeeAll = false): Promise<MailCampaignView[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM mail_campaigns WHERE $1 OR created_by = $2 ORDER BY created_at DESC LIMIT 100`,
    [canSeeAll, userId],
  );
  return Promise.all(rows.map(async (r) => rowTo(r, await personFor(r.from_user_id))));
}

export async function createCampaign(userId: string, payload: MailCampaignPayload): Promise<MailCampaignView> {
  if (!payload.subject?.trim()) throw new MailError('A campaign needs a subject.');
  const from = await personFor(userId);
  const id = snowflake();
  const bodyHtml = payload.bodyHtml ?? '';
  await getPool().query(
    `INSERT INTO mail_campaigns
       (id, name, subject, body_html, body_text, template_id, from_user_id, from_name, from_address,
        list_ids, extra_recipients, scheduled_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$7)`,
    [id, payload.name ?? payload.subject.trim(), payload.subject.trim(), bodyHtml,
     payload.bodyText?.trim() || htmlToText(bodyHtml), payload.templateId ?? null,
     userId, from.name, from.address,
     JSON.stringify(payload.listIds ?? []),
     JSON.stringify((payload.extraRecipients ?? []).map((e) => ({
       address: e.address.toLowerCase(), name: e.name ?? e.address, mergeVars: e.mergeVars ?? {},
     }))),
     payload.scheduledAt ? new Date(payload.scheduledAt) : null],
  );
  return getCampaign(userId, id);
}

export async function updateCampaign(
  userId: string, id: string, payload: Partial<MailCampaignPayload>,
): Promise<MailCampaignView> {
  const cur = await getCampaign(userId, id);
  if (!['draft', 'pending_approval'].includes(cur.status)) {
    throw new MailError('Only a draft campaign can be edited.', 409);
  }
  const bodyHtml = payload.bodyHtml ?? cur.bodyHtml;
  await getPool().query(
    `UPDATE mail_campaigns SET name = $2, subject = $3, body_html = $4, body_text = $5,
           template_id = $6, list_ids = $7::jsonb, extra_recipients = $8::jsonb, scheduled_at = $9,
           status = 'draft', requires_approval = false, approved_by = NULL, approved_at = NULL,
           rejected_reason = NULL, updated_at = now()
      WHERE id = $1`,
    [id, payload.name ?? cur.name, (payload.subject ?? cur.subject).trim(), bodyHtml,
     payload.bodyText?.trim() || htmlToText(bodyHtml), payload.templateId ?? cur.templateId,
     JSON.stringify(payload.listIds ?? cur.listIds),
     JSON.stringify(payload.extraRecipients
       ? payload.extraRecipients.map((e) => ({ address: e.address.toLowerCase(), name: e.name ?? e.address, mergeVars: e.mergeVars ?? {} }))
       : cur.extraRecipients),
     payload.scheduledAt !== undefined ? (payload.scheduledAt ? new Date(payload.scheduledAt) : null) : cur.scheduledAt],
  );
  return getCampaign(userId, id);
}

export async function deleteCampaign(userId: string, id: string): Promise<void> {
  const cur = await getCampaign(userId, id);
  if (['sending', 'sent'].includes(cur.status)) throw new MailError('A sent campaign cannot be deleted.', 409);
  await getPool().query(`DELETE FROM mail_campaigns WHERE id = $1 AND created_by = $2`, [id, userId]);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Recipient resolution & preview (FR-MAIL-5)
 * ────────────────────────────────────────────────────────────────────────── */

export interface ResolvedCampaignRecipient {
  userId: string | null;
  address: string;
  name: string;
  mergeVars: Record<string, string>;
  /** Internal recipient who should also receive a real email. */
  alsoEmail?: boolean;
}

export async function resolveCampaignRecipients(campaign: MailCampaignView): Promise<ResolvedCampaignRecipient[]> {
  const byAddress = new Map<string, ResolvedCampaignRecipient>();
  const instanceEmailDefault = internalEmailDelivery();

  if (campaign.listIds.length) {
    const { rows } = await getPool().query<{
      address: string; user_id: string | null; name: string; merge_vars: Record<string, string>;
      copies: boolean | null;
    }>(
      `SELECT DISTINCT ON (lower(m.address)) m.address, m.user_id, m.name, m.merge_vars,
              p.email_copies AS copies
         FROM mail_list_members m
         LEFT JOIN mail_prefs p ON p.user_id = m.user_id
        WHERE m.list_id = ANY($1::text[])`,
      [campaign.listIds],
    );
    for (const r of rows) {
      byAddress.set(r.address.toLowerCase(), {
        userId: r.user_id, address: r.address.toLowerCase(), name: r.name, mergeVars: r.merge_vars ?? {},
        alsoEmail: !!r.user_id && (r.copies === null ? instanceEmailDefault : r.copies),
      });
    }
  }

  for (const e of campaign.extraRecipients) {
    byAddress.set(e.address.toLowerCase(), {
      userId: null, address: e.address.toLowerCase(), name: e.name, mergeVars: e.mergeVars ?? {},
    });
  }

  // Drop suppressed addresses up front so the preview count is honest.
  const { rows: supp } = await getPool().query<{ address: string }>(
    `SELECT address FROM mail_suppressions WHERE address = ANY($1::text[])`,
    [[...byAddress.keys()]],
  );
  for (const s of supp) byAddress.delete(s.address);

  return [...byAddress.values()];
}

export interface CampaignPreview {
  totalRecipients: number;
  requiresApproval: boolean;
  missingFields: string[];
  samples: Array<{ to: string; subject: string; bodyHtml: string }>;
}

export async function previewCampaign(userId: string, id: string): Promise<CampaignPreview> {
  const campaign = await getCampaign(userId, id, true);
  const recipients = await resolveCampaignRecipients(campaign);
  const { extractMergeFields } = await import('./render.js');
  const fields = extractMergeFields(campaign.subject, campaign.bodyHtml);

  const missing = new Set<string>();
  for (const r of recipients.slice(0, 500)) {
    for (const f of fields) {
      if (!(f in r.mergeVars) && !['name', 'first_name', 'email', 'role'].includes(f)) missing.add(f);
    }
  }

  const samples = recipients.slice(0, 3).map((r) => {
    const vars = mergeVarsFor(r);
    return {
      to: r.address,
      subject: renderMerge(campaign.subject, vars),
      bodyHtml: renderMerge(campaign.bodyHtml, vars, { escape: false }),
    };
  });

  return {
    totalRecipients: recipients.length,
    requiresApproval: recipients.length > MAIL_APPROVAL_THRESHOLD,
    missingFields: [...missing],
    samples,
  };
}

function mergeVarsFor(r: ResolvedCampaignRecipient): Record<string, string> {
  const first = (r.mergeVars.first_name as string) || r.name.split(/\s+/)[0] || r.name;
  return { name: r.name, first_name: first, email: r.address, ...r.mergeVars };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Submit → approve → run (FR-MAIL-10)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Submit a campaign. Above MAIL_APPROVAL_THRESHOLD it always waits for a
 * second person, even when the sender holds MAIL_APPROVE themselves: the
 * approval step exists so no single account can reach the whole school
 * unreviewed, and a self-approval would defeat it (four-eyes rule). Small
 * sends go straight out as before.
 *
 * `_canApprove` is kept for call-site compatibility; it no longer affects the
 * outcome.
 */
export async function submitCampaign(
  userId: string, id: string, _canApprove?: boolean,
): Promise<MailCampaignView> {
  const campaign = await getCampaign(userId, id);
  if (!['draft', 'pending_approval'].includes(campaign.status)) {
    throw new MailError('This campaign has already been submitted.', 409);
  }
  const recipients = await resolveCampaignRecipients(campaign);
  if (recipients.length === 0) throw new MailError('This campaign has no deliverable recipients.');

  const needsApproval = recipients.length > MAIL_APPROVAL_THRESHOLD;
  const scheduled = campaign.scheduledAt && new Date(campaign.scheduledAt).getTime() > Date.now();

  let status: MailCampaignView['status'];
  if (needsApproval) status = 'pending_approval';
  else status = scheduled ? 'scheduled' : 'approved';

  await getPool().query(
    `UPDATE mail_campaigns SET status = $2, requires_approval = $3, total_recipients = $4,
           updated_at = now()
      WHERE id = $1`,
    [id, status, needsApproval, recipients.length],
  );
  return getCampaign(userId, id, true);
}

export async function approveCampaign(approverId: string, id: string): Promise<MailCampaignView> {
  const { rows } = await getPool().query<{ status: string; scheduled_at: string | null; created_by: string }>(
    `SELECT status, scheduled_at, created_by FROM mail_campaigns WHERE id = $1`, [id],
  );
  if (!rows[0]) throw new MailError('Campaign not found.', 404);
  if (rows[0].status !== 'pending_approval') throw new MailError('This campaign is not awaiting approval.', 409);
  if (rows[0].created_by === approverId) {
    throw new MailError(
      'You cannot approve your own bulk send. Another approver has to review it.', 403,
    );
  }
  const scheduled = rows[0].scheduled_at && new Date(rows[0].scheduled_at).getTime() > Date.now();
  await getPool().query(
    `UPDATE mail_campaigns SET status = $2, approved_by = $3, approved_at = now(), updated_at = now()
      WHERE id = $1`,
    [id, scheduled ? 'scheduled' : 'approved', approverId],
  );
  await notify([rows[0].created_by], {
    kind: 'mail.campaign', title: 'Your bulk send was approved', link: `/app/mail/campaigns/${id}`,
    subjectType: 'mail_campaign', subjectId: id,
  }).then((rows) => push(rows)).catch(() => {});
  return getCampaign(approverId, id, true);
}

export async function rejectCampaign(approverId: string, id: string, reason: string): Promise<MailCampaignView> {
  const { rows } = await getPool().query<{ status: string; created_by: string }>(
    `SELECT status, created_by FROM mail_campaigns WHERE id = $1`, [id],
  );
  if (!rows[0]) throw new MailError('Campaign not found.', 404);
  if (rows[0].status !== 'pending_approval') throw new MailError('This campaign is not awaiting approval.', 409);
  await getPool().query(
    `UPDATE mail_campaigns SET status = 'draft', rejected_reason = $2, updated_at = now() WHERE id = $1`,
    [id, reason.slice(0, 500)],
  );
  await notify([rows[0].created_by], {
    kind: 'mail.campaign', title: 'Your bulk send needs changes',
    body: reason.slice(0, 200), link: `/app/mail/campaigns/${id}`,
    subjectType: 'mail_campaign', subjectId: id,
  }).then((rows) => push(rows)).catch(() => {});
  return getCampaign(approverId, id, true);
}

export async function cancelCampaign(userId: string, id: string): Promise<void> {
  const { rowCount } = await getPool().query(
    `UPDATE mail_campaigns SET status = 'cancelled', updated_at = now()
      WHERE id = $1 AND created_by = $2 AND status IN ('draft','pending_approval','approved','scheduled')`,
    [id, userId],
  );
  if (!rowCount) throw new MailError('This campaign cannot be cancelled.', 409);
}

/**
 * Run the campaign — the worker's job. Materialises one personalised message
 * per recipient, delivers it, and rolls up the counts (FR-MAIL-8).
 *
 * Idempotent at the campaign level: it will not start one already `sending`
 * or `sent`. Within a run, a recipient who already has a message row for this
 * campaign is skipped, so a retry after a crash resumes rather than doubles.
 */
export async function runCampaign(id: string): Promise<{ delivered: number; failed: number }> {
  const pool = getPool();
  const { rows: cRows } = await pool.query(
    `UPDATE mail_campaigns SET status = 'sending', started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = $1 AND status IN ('approved', 'scheduled')
      RETURNING *`,
    [id],
  );
  const c = cRows[0];
  if (!c) return { delivered: 0, failed: 0 };

  const from = await personFor(c.from_user_id);
  const campaign = rowTo(c, from);
  const recipients = await resolveCampaignRecipients(campaign);

  const { rows: doneRows } = await pool.query<{ address: string }>(
    `SELECT r.address FROM mail_recipients r
       JOIN mail_messages m ON m.id = r.message_id
      WHERE m.campaign_id = $1`, [id],
  );
  const done = new Set(doneRows.map((r) => r.address.toLowerCase()));

  let delivered = 0, failed = 0;
  for (const r of recipients) {
    if (done.has(r.address.toLowerCase())) continue;
    try {
      const messageId = await materialiseCampaignMessage(pool, campaign, from, r);
      await deliverInApp(messageId);
      const smtp = await deliverSmtp(messageId);
      delivered += smtp.sent + 1; // rough; real numbers come from the rollup
      failed += smtp.failed;
    } catch (e) {
      failed++;
      console.error(`[mail] campaign ${id} recipient ${r.address} failed:`, e);
    }
  }

  const counts = await rollupCampaignCounts(id);
  const allDone = counts.queued === 0;
  await pool.query(
    `UPDATE mail_campaigns SET status = $2, counts = $3::jsonb,
           finished_at = CASE WHEN $4 THEN now() ELSE finished_at END, updated_at = now()
      WHERE id = $1`,
    [id, allDone ? 'sent' : 'sending', JSON.stringify(counts), allDone],
  );
  if (allDone) {
    await notify([c.from_user_id], {
      kind: 'mail.campaign',
      title: `"${campaign.subject}" sent to ${counts.total} recipients`,
      body: counts.bounced + counts.failed > 0 ? `${counts.bounced + counts.failed} could not be delivered` : null,
      link: `/app/mail/campaigns/${id}`, subjectType: 'mail_campaign', subjectId: id,
    }).then((rows) => push(rows)).catch(() => {});
  }
  return { delivered, failed };
}

async function materialiseCampaignMessage(
  db: PoolClient | ReturnType<typeof getPool>,
  campaign: MailCampaignView, from: MailPerson, r: ResolvedCampaignRecipient,
): Promise<string> {
  const vars = mergeVarsFor(r);
  const subject = renderMerge(campaign.subject, vars).slice(0, 300) || '(no subject)';
  const bodyHtml = renderMerge(campaign.bodyHtml, vars, { escape: false });
  const bodyText = renderMerge(campaign.bodyText || htmlToText(campaign.bodyHtml), vars);

  const threadId = snowflake();
  const messageId = snowflake();

  await db.query(
    `INSERT INTO mail_threads (id, subject, subject_normalized, created_by, last_message_at, last_sender_id, last_sender_name, last_snippet, message_count)
     VALUES ($1,$2,$3,$4,now(),$4,$5,$6,1)`,
    [threadId, subject, normalizeSubject(subject), from.userId, from.name, snippetOf(bodyHtml, bodyText)],
  );
  await db.query(
    `INSERT INTO mail_messages
       (id, thread_id, from_user_id, from_name, from_address, subject, body_html, body_text, snippet,
        kind, campaign_id, sent_at, recipient_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'new',$10,now(),'{"to":1}'::jsonb)`,
    [messageId, threadId, from.userId, from.name, from.address, subject, bodyHtml, bodyText,
     snippetOf(bodyHtml, bodyText), campaign.id],
  );

  // In-app for an internal recipient, SMTP for an external one — plus an SMTP
  // copy for an internal recipient who should also get a real email.
  const channels: Array<'in_app' | 'smtp'> = r.userId ? ['in_app'] : ['smtp'];
  if (r.userId && r.alsoEmail && isEmailAddress(r.address)) channels.push('smtp');

  for (const channel of channels) {
    await db.query(
      `INSERT INTO mail_recipients
         (id, message_id, thread_id, kind, user_id, address, name, merge_vars, channel, delivery_status)
       VALUES ($1,$2,$3,'to',$4,$5,$6,$7::jsonb,$8,'queued')`,
      [snowflake(), messageId, threadId, r.userId, r.address, r.name, JSON.stringify(r.mergeVars), channel],
    );
  }
  return messageId;
}

export async function rollupCampaignCounts(id: string): Promise<{
  total: number; queued: number; sent: number; delivered: number; bounced: number; failed: number; suppressed: number;
}> {
  // Per recipient (one personalised message each), collapsing that recipient's
  // in-app + email delivery rows into a single outcome.
  const { rows } = await getPool().query<Record<string, string>>(
    `WITH per_msg AS (
       SELECT m.id,
              CASE
                WHEN bool_or(r.delivery_status IN ('bounced','failed')) THEN 'failed'
                WHEN bool_or(r.delivery_status = 'suppressed') AND bool_and(r.delivery_status IN ('suppressed','delivered','sent')) THEN 'suppressed'
                WHEN bool_and(r.delivery_status = 'delivered') THEN 'delivered'
                WHEN bool_or(r.delivery_status IN ('delivered','sent')) THEN 'sent'
                ELSE 'queued' END AS state
         FROM mail_messages m JOIN mail_recipients r ON r.message_id = m.id
        WHERE m.campaign_id = $1
        GROUP BY m.id
     )
     SELECT count(*)::text total,
            count(*) FILTER (WHERE state = 'queued')::text queued,
            count(*) FILTER (WHERE state = 'sent')::text sent,
            count(*) FILTER (WHERE state = 'delivered')::text delivered,
            count(*) FILTER (WHERE state = 'failed')::text failed,
            count(*) FILTER (WHERE state = 'suppressed')::text suppressed
       FROM per_msg`,
    [id],
  );
  const a = rows[0]!;
  return {
    total: +a.total!, queued: +a.queued!, sent: +a.sent!, delivered: +a.delivered!,
    bounced: 0, failed: +a.failed!, suppressed: +a.suppressed!,
  };
}

/** Worker sweep: pick up campaigns due to send. */
export async function runDueCampaigns(): Promise<number> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM mail_campaigns
      WHERE status = 'approved'
         OR (status = 'scheduled' AND scheduled_at <= now())
         OR status = 'sending'`,
  );
  for (const r of rows) {
    try { await runCampaign(r.id); }
    catch (e) { console.error(`[mail] campaign ${r.id} run failed:`, e); }
  }
  return rows.length;
}
