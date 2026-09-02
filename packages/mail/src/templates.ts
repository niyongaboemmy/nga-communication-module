/**
 * Reusable templates (FR-MAIL-6) — fee notices, term letters, event invitations.
 *
 * A template is a subject + rich-text body carrying `{{merge_field}}` tokens.
 * `variables` is the declared field list, recomputed on save from what the
 * subject and body actually reference so the campaign preview knows what to ask
 * for.
 */
import { getPool, snowflake } from '@tupo/db';
import type { MailTemplate } from '@tupo/shared';
import { MailError } from './errors.js';
import { extractMergeFields, htmlToText } from './render.js';

const rowTo = (r: {
  id: string; name: string; description: string; category: string; subject: string;
  body_html: string; body_text: string; variables: string[]; is_shared: boolean;
  created_by: string | null; updated_at: string;
}): MailTemplate => ({
  id: r.id, name: r.name, description: r.description, category: r.category, subject: r.subject,
  bodyHtml: r.body_html, bodyText: r.body_text, variables: r.variables ?? [], isShared: r.is_shared,
  createdBy: r.created_by, updatedAt: r.updated_at,
});

export async function listTemplates(userId: string): Promise<MailTemplate[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM mail_templates WHERE is_shared OR created_by = $1 ORDER BY category, name`, [userId],
  );
  return rows.map(rowTo);
}

export async function getTemplate(userId: string, id: string): Promise<MailTemplate> {
  const { rows } = await getPool().query(
    `SELECT * FROM mail_templates WHERE id = $1 AND (is_shared OR created_by = $2)`, [id, userId],
  );
  if (!rows[0]) throw new MailError('Template not found.', 404);
  return rowTo(rows[0]);
}

export interface TemplateInput {
  name: string;
  description?: string;
  category?: string;
  subject: string;
  bodyHtml: string;
  isShared?: boolean;
}

export async function createTemplate(userId: string, input: TemplateInput): Promise<MailTemplate> {
  const name = input.name.trim();
  if (!name) throw new MailError('A template needs a name.');
  const id = snowflake();
  const vars = extractMergeFields(input.subject, input.bodyHtml);
  await getPool().query(
    `INSERT INTO mail_templates
       (id, name, description, category, subject, body_html, body_text, variables, is_shared, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$10)`,
    [id, name, input.description ?? '', input.category ?? 'general', input.subject.slice(0, 300),
     input.bodyHtml, htmlToText(input.bodyHtml), JSON.stringify(vars), input.isShared ?? true, userId],
  );
  return getTemplate(userId, id);
}

export async function updateTemplate(
  userId: string, id: string, input: Partial<TemplateInput>, canManageAny: boolean,
): Promise<MailTemplate> {
  const cur = await getTemplate(userId, id);
  if (cur.createdBy && cur.createdBy !== userId && !canManageAny) {
    throw new MailError('You can only edit templates you created.', 403);
  }
  const subject = input.subject ?? cur.subject;
  const bodyHtml = input.bodyHtml ?? cur.bodyHtml;
  const vars = extractMergeFields(subject, bodyHtml);
  await getPool().query(
    `UPDATE mail_templates SET name = $2, description = $3, category = $4, subject = $5,
           body_html = $6, body_text = $7, variables = $8::jsonb, is_shared = $9,
           updated_by = $10, updated_at = now()
      WHERE id = $1`,
    [id, input.name?.trim() || cur.name, input.description ?? cur.description,
     input.category ?? cur.category, subject.slice(0, 300), bodyHtml, htmlToText(bodyHtml),
     JSON.stringify(vars), input.isShared ?? cur.isShared, userId],
  );
  return getTemplate(userId, id);
}

export async function deleteTemplate(userId: string, id: string, canManageAny: boolean): Promise<void> {
  const cur = await getTemplate(userId, id);
  if (cur.createdBy && cur.createdBy !== userId && !canManageAny) {
    throw new MailError('You can only delete templates you created.', 403);
  }
  await getPool().query(`DELETE FROM mail_templates WHERE id = $1`, [id]);
}

/**
 * Seed a handful of institutional templates once, so the module is not empty
 * on first open.
 */
export async function seedDefaultTemplates(): Promise<void> {
  const defaults: Array<TemplateInput & { id: string }> = [
    {
      id: 'tpl-fee-notice',
      name: 'Term fee notice', category: 'fees',
      description: 'Reminder that term fees are due.',
      subject: 'Fee notice for {{name}} — {{term}}',
      bodyHtml: `<p>Dear {{first_name}},</p><p>This is a reminder that the fees for <strong>{{term}}</strong> are now due. The outstanding balance for {{name}} is <strong>{{amount}}</strong>, payable by {{due_date}}.</p><p>Please contact the bursary if you have already paid or wish to arrange a payment plan.</p><p>Kind regards,<br>NGA Bursary</p>`,
    },
    {
      id: 'tpl-term-letter',
      name: 'Start-of-term letter', category: 'academic',
      description: 'Welcome letter with term dates and expectations.',
      subject: 'Welcome to {{term}} at NGA',
      bodyHtml: `<p>Dear parents and guardians,</p><p>We are pleased to welcome {{name}} back for {{term}}. Term begins on {{start_date}} and ends on {{end_date}}.</p><p>Please ensure all learners arrive in full uniform with the required materials.</p><p>Warm regards,<br>The NGA Academic Office</p>`,
    },
    {
      id: 'tpl-event-invite',
      name: 'Event invitation', category: 'events',
      description: 'Invite parents or staff to a school event.',
      subject: 'You are invited: {{event_name}}',
      bodyHtml: `<p>Dear {{first_name}},</p><p>You are warmly invited to <strong>{{event_name}}</strong> on {{event_date}} at {{event_time}}, held at {{venue}}.</p><p>Kindly confirm your attendance by {{rsvp_date}}.</p><p>We look forward to seeing you there.</p>`,
    },
  ];
  for (const d of defaults) {
    const vars = extractMergeFields(d.subject, d.bodyHtml);
    await getPool().query(
      `INSERT INTO mail_templates
         (id, name, description, category, subject, body_html, body_text, variables, is_shared)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,true)
       ON CONFLICT (id) DO NOTHING`,
      [d.id, d.name, d.description ?? '', d.category ?? 'general', d.subject,
       d.bodyHtml, htmlToText(d.bodyHtml), JSON.stringify(vars)],
    );
  }
}
