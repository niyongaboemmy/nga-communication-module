import { Router, type Request, type Response, type NextFunction } from 'express';
import { getPool } from '@tupo/db';
import { ok, fail } from '@tupo/shared';
import * as mail from '@tupo/mail';
import { MailError } from '@tupo/mail';
import * as mailAi from '../services/mailAiService.js';
import { MailAiError } from '../services/mailAiService.js';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { hasPermission } from '../access/gate.js';
import { routeCampaignForApproval } from '../access/approvers.js';
import { audit } from '../services/userService.js';
import { enqueueMailSend, enqueueMailCampaign, enqueueMailListSync } from '../services/queue.js';
import { activity } from '../activity/relay.js';

/**
 * Mail REST (FR-MAIL-1…11).
 *
 * The mailbox, compose, distribution lists, templates and bulk campaigns. All
 * domain logic — and every authorisation decision about who may read a thread —
 * lives in `@tupo/mail`, shared with the worker; the routes here only translate
 * HTTP to those calls and gate on the RBAC permission.
 */
const router = Router();
router.use(authMiddleware);

const actor = (req: Request) => (req as AuthenticatedRequest).user!;
// Shadow-compared with the v2 snapshot; the v2 set itself in enforce (access/gate.ts).
const can = (req: Request, key: string) => hasPermission(req, key);

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try { await fn(req, res); }
    catch (err) {
      if (err instanceof MailError) return res.status(err.status).json(fail(err.message));
      next(err);
    }
  };

const str = (v: unknown, max = 10_000) => (typeof v === 'string' ? v.slice(0, max) : '');
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/* ────────────────────────────────────────────────────────────────────────── *
 * Mailbox
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/counts', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  res.json(ok({ counts: await mail.mailboxCounts(actor(req).id) }));
}));

router.get('/labels', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  res.json(ok({ labels: await mail.listLabels(actor(req).id) }));
}));

router.post('/labels', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  const label = await mail.createLabel(actor(req).id, str(req.body?.name, 60), str(req.body?.color, 20));
  res.status(201).json(ok({ label }));
}));

router.delete('/labels/:id', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  await mail.deleteLabel(actor(req).id, req.params.id!);
  res.json(ok({ deleted: true }));
}));

router.get('/threads', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  const folder = str(req.query.folder) || 'inbox';
  const result = await mail.listThreads(actor(req).id, {
    folder: folder as never,
    labelId: str(req.query.label) || undefined,
    q: str(req.query.q, 200) || undefined,
    cursor: str(req.query.cursor) || undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  });
  res.json(ok(result));
}));

router.get('/threads/:id', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  res.json(ok({ thread: await mail.getThread(actor(req).id, req.params.id!) }));
}));

router.post('/threads/:id/move', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  await mail.moveThread(actor(req).id, req.params.id!, str(req.body?.folder) as never);
  res.json(ok({ moved: true }));
}));

router.post('/threads/:id/star', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  await mail.starThread(actor(req).id, req.params.id!, req.body?.starred !== false);
  res.json(ok({ starred: req.body?.starred !== false }));
}));

router.post('/threads/:id/read', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  await mail.markThread(actor(req).id, req.params.id!, req.body?.read !== false);
  res.json(ok({ read: req.body?.read !== false }));
}));

router.post('/threads/:id/labels', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  await mail.setThreadLabels(actor(req).id, req.params.id!, arr(req.body?.labels));
  res.json(ok({ labels: arr(req.body?.labels) }));
}));

router.delete('/threads/:id', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  await mail.purgeThread(actor(req).id, req.params.id!);
  res.json(ok({ purged: true }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Compose
 * ────────────────────────────────────────────────────────────────────────── */

router.post('/compose', wrap(async (req, res) => {
  const me = actor(req);
  const body = req.body ?? {};
  const isDraft = body.draft === true;

  // Saving a draft only needs MAIL_READ; actually sending needs MAIL_SEND.
  if (!isDraft && !hasPermission(req, 'MAIL_SEND')) {
    return res.status(403).json(fail('You do not have permission to send mail.'));
  }
  if (isDraft && !hasPermission(req, 'MAIL_READ')) {
    return res.status(403).json(fail('You do not have permission to use mail.'));
  }

  const result = await mail.compose(me.id, {
    to: arr(body.to), cc: arr(body.cc), bcc: arr(body.bcc),
    subject: str(body.subject, 300), bodyHtml: str(body.bodyHtml, 200_000),
    bodyText: body.bodyText ? str(body.bodyText, 200_000) : undefined,
    attachments: Array.isArray(body.attachments) ? body.attachments.slice(0, 20) : [],
    threadId: body.threadId ? str(body.threadId) : undefined,
    parentId: body.parentId ? str(body.parentId) : undefined,
    kind: body.kind,
    draft: isDraft,
    scheduledAt: body.scheduledAt ?? null,
    draftId: body.draftId ? str(body.draftId) : undefined,
  });

  if (!result.draft) {
    // A scheduled message is left for the worker's sweep, which promotes it and
    // dispatches its email once its time comes; only send now for an immediate one.
    if (!result.scheduled) await enqueueMailSend(result.messageId);
    await audit({ actorId: me.id, action: result.scheduled ? 'mail.schedule' : 'mail.send', targetType: 'mail_message', targetId: result.messageId });
    // Counts only -- never the subject, body or addresses.
    activity().trackFor(req, 'tupo.mail.send', {
      recipients: arr(body.to).length + arr(body.cc).length + arr(body.bcc).length,
      attachments: Array.isArray(body.attachments) ? Math.min(body.attachments.length, 20) : 0,
      scheduled: Boolean(result.scheduled),
      reply: Boolean(body.threadId),
    });
  }
  res.status(201).json(ok(result));
}));

router.delete('/drafts/:id', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  await mail.deleteDraft(actor(req).id, req.params.id!);
  res.json(ok({ deleted: true }));
}));

router.post('/messages/:id/cancel', authorizePermission('MAIL_SEND'), wrap(async (req, res) => {
  await mail.cancelScheduled(actor(req).id, req.params.id!);
  res.json(ok({ cancelled: true }));
}));

router.get('/messages/:id/delivery', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  res.json(ok({ recipients: await mail.deliveryFor(actor(req).id, req.params.id!) }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Preferences & directory
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/prefs', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  res.json(ok({ prefs: await mail.getPrefs(actor(req).id) }));
}));

router.put('/prefs', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (typeof b.displayName === 'string' || b.displayName === null) patch.displayName = b.displayName;
  if (typeof b.signatureHtml === 'string') patch.signatureHtml = b.signatureHtml.slice(0, 20_000);
  if (typeof b.signatureEnabled === 'boolean') patch.signatureEnabled = b.signatureEnabled;
  if (typeof b.emailCopies === 'boolean') patch.emailCopies = b.emailCopies;
  res.json(ok({ prefs: await mail.updatePrefs(actor(req).id, patch) }));
}));

/** People you can address mail to — name, email, avatar. */
router.get('/directory', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  const q = str(req.query.q, 100).trim();
  const { rows } = await getPool().query<{
    id: string; name: string; email: string; avatar_url: string | null;
  }>(
    `SELECT id, name, email, avatar_url FROM users
      WHERE status = 'active'
        AND ($1 = '' OR name ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%')
      ORDER BY name, email LIMIT 20`,
    [q],
  );
  res.json(ok({
    people: rows.map((r) => ({
      userId: r.id, name: r.name, address: r.email, avatarUrl: r.avatar_url,
    })),
  }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Distribution lists (FR-MAIL-4)
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/lists', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  res.json(ok({ lists: await mail.listLists(can(req, 'MAIL_LIST_MANAGE')) }));
}));

router.post('/lists', authorizePermission('MAIL_LIST_MANAGE'), wrap(async (req, res) => {
  const list = await mail.createList(actor(req).id, {
    name: str(req.body?.name, 120), description: str(req.body?.description, 500),
    origin: str(req.body?.origin, 60) || 'manual',
  });
  await audit({ actorId: actor(req).id, action: 'mail.list.create', targetType: 'mail_list', targetId: list.id, metadata: { name: list.name } });
  res.status(201).json(ok({ list }));
}));

router.patch('/lists/:id', authorizePermission('MAIL_LIST_MANAGE'), wrap(async (req, res) => {
  res.json(ok({ list: await mail.updateList(req.params.id!, {
    name: req.body?.name, description: req.body?.description, isActive: req.body?.isActive,
  }) }));
}));

router.delete('/lists/:id', authorizePermission('MAIL_LIST_MANAGE'), wrap(async (req, res) => {
  await mail.deleteList(req.params.id!);
  await audit({ actorId: actor(req).id, action: 'mail.list.delete', targetType: 'mail_list', targetId: req.params.id! });
  res.json(ok({ deleted: true }));
}));

router.get('/lists/:id/members', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  res.json(ok({ members: await mail.listMembers(req.params.id!) }));
}));

router.post('/lists/:id/members', authorizePermission('MAIL_LIST_MANAGE'), wrap(async (req, res) => {
  await mail.addManualMember(req.params.id!, {
    address: str(req.body?.address, 320), name: str(req.body?.name, 200),
    userId: req.body?.userId ? str(req.body.userId) : undefined,
    mergeVars: typeof req.body?.mergeVars === 'object' ? req.body.mergeVars : {},
  });
  res.status(201).json(ok({ added: true }));
}));

router.delete('/lists/:id/members/:address', authorizePermission('MAIL_LIST_MANAGE'), wrap(async (req, res) => {
  await mail.removeMember(req.params.id!, decodeURIComponent(req.params.address!));
  res.json(ok({ removed: true }));
}));

router.post('/lists/:id/sync', authorizePermission('MAIL_LIST_MANAGE'), wrap(async (req, res) => {
  await enqueueMailListSync(req.params.id!);
  const result = await mail.syncList(req.params.id!);
  res.json(ok(result));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Templates (FR-MAIL-6)
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/templates', authorizePermission('MAIL_READ'), wrap(async (req, res) => {
  res.json(ok({ templates: await mail.listTemplates(actor(req).id) }));
}));

router.post('/templates', authorizePermission('MAIL_TEMPLATE_MANAGE'), wrap(async (req, res) => {
  const b = req.body ?? {};
  const template = await mail.createTemplate(actor(req).id, {
    name: str(b.name, 120), description: str(b.description, 500), category: str(b.category, 40),
    subject: str(b.subject, 300), bodyHtml: str(b.bodyHtml, 200_000), isShared: b.isShared !== false,
  });
  res.status(201).json(ok({ template }));
}));

router.patch('/templates/:id', authorizePermission('MAIL_TEMPLATE_MANAGE'), wrap(async (req, res) => {
  const b = req.body ?? {};
  res.json(ok({ template: await mail.updateTemplate(actor(req).id, req.params.id!, {
    name: b.name, description: b.description, category: b.category,
    subject: b.subject, bodyHtml: b.bodyHtml, isShared: b.isShared,
  }, can(req, 'MAIL_APPROVE')) }));
}));

router.delete('/templates/:id', authorizePermission('MAIL_TEMPLATE_MANAGE'), wrap(async (req, res) => {
  await mail.deleteTemplate(actor(req).id, req.params.id!, can(req, 'MAIL_APPROVE'));
  res.json(ok({ deleted: true }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Campaigns (FR-MAIL-5, FR-MAIL-10)
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/campaigns', authorizePermission('MAIL_BULK_SEND', 'MAIL_APPROVE'), wrap(async (req, res) => {
  res.json(ok({ campaigns: await mail.listCampaigns(actor(req).id, can(req, 'MAIL_APPROVE')) }));
}));

router.post('/campaigns', authorizePermission('MAIL_BULK_SEND'), wrap(async (req, res) => {
  const b = req.body ?? {};
  const campaign = await mail.createCampaign(actor(req).id, {
    name: str(b.name, 200), subject: str(b.subject, 300),
    bodyHtml: str(b.bodyHtml, 200_000), bodyText: b.bodyText ? str(b.bodyText, 200_000) : undefined,
    templateId: b.templateId ?? null, listIds: arr(b.listIds),
    extraRecipients: Array.isArray(b.extraRecipients) ? b.extraRecipients.slice(0, 500) : [],
    scheduledAt: b.scheduledAt ?? null,
  });
  await audit({ actorId: actor(req).id, action: 'mail.campaign.create', targetType: 'mail_campaign', targetId: campaign.id, metadata: { subject: campaign.subject } });
  res.status(201).json(ok({ campaign }));
}));

router.get('/campaigns/:id', authorizePermission('MAIL_BULK_SEND', 'MAIL_APPROVE'), wrap(async (req, res) => {
  res.json(ok({ campaign: await mail.getCampaign(actor(req).id, req.params.id!, can(req, 'MAIL_APPROVE')) }));
}));

router.patch('/campaigns/:id', authorizePermission('MAIL_BULK_SEND'), wrap(async (req, res) => {
  const b = req.body ?? {};
  res.json(ok({ campaign: await mail.updateCampaign(actor(req).id, req.params.id!, {
    name: b.name, subject: b.subject, bodyHtml: b.bodyHtml, bodyText: b.bodyText,
    templateId: b.templateId, listIds: b.listIds ? arr(b.listIds) : undefined,
    extraRecipients: b.extraRecipients, scheduledAt: b.scheduledAt,
  }) }));
}));

router.delete('/campaigns/:id', authorizePermission('MAIL_BULK_SEND'), wrap(async (req, res) => {
  await mail.deleteCampaign(actor(req).id, req.params.id!);
  res.json(ok({ deleted: true }));
}));

router.get('/campaigns/:id/preview', authorizePermission('MAIL_BULK_SEND', 'MAIL_APPROVE'), wrap(async (req, res) => {
  res.json(ok({ preview: await mail.previewCampaign(actor(req).id, req.params.id!) }));
}));

router.post('/campaigns/:id/submit', authorizePermission('MAIL_BULK_SEND'), wrap(async (req, res) => {
  const campaign = await mail.submitCampaign(actor(req).id, req.params.id!, can(req, 'MAIL_APPROVE'));
  if (campaign.status === 'approved') await enqueueMailCampaign(campaign.id);
  // Approver pool from MIS holders of MAIL_APPROVE, sender excluded
  // (shadow: compared and recorded; enforce: notified; off: nothing).
  await routeCampaignForApproval(actor(req), campaign);
  await audit({ actorId: actor(req).id, action: 'mail.campaign.submit', targetType: 'mail_campaign', targetId: campaign.id, metadata: { status: campaign.status } });
  res.json(ok({ campaign }));
}));

router.post('/campaigns/:id/approve', authorizePermission('MAIL_APPROVE'), wrap(async (req, res) => {
  const campaign = await mail.approveCampaign(actor(req).id, req.params.id!);
  if (campaign.status === 'approved') await enqueueMailCampaign(campaign.id);
  await audit({ actorId: actor(req).id, action: 'mail.campaign.approve', targetType: 'mail_campaign', targetId: campaign.id });
  res.json(ok({ campaign }));
}));

router.post('/campaigns/:id/reject', authorizePermission('MAIL_APPROVE'), wrap(async (req, res) => {
  const campaign = await mail.rejectCampaign(actor(req).id, req.params.id!, str(req.body?.reason, 500));
  await audit({ actorId: actor(req).id, action: 'mail.campaign.reject', targetType: 'mail_campaign', targetId: campaign.id });
  res.json(ok({ campaign }));
}));

router.post('/campaigns/:id/cancel', authorizePermission('MAIL_BULK_SEND'), wrap(async (req, res) => {
  await mail.cancelCampaign(actor(req).id, req.params.id!);
  res.json(ok({ cancelled: true }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Suppression list (FR-MAIL-7)
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/suppressions', authorizePermission('MAIL_BULK_SEND', 'MAIL_APPROVE'), wrap(async (_req, res) => {
  const { rows } = await getPool().query(
    `SELECT address, reason, note, created_at FROM mail_suppressions ORDER BY created_at DESC LIMIT 500`,
  );
  res.json(ok({ suppressions: rows }));
}));

router.post('/suppressions', authorizePermission('MAIL_BULK_SEND', 'MAIL_APPROVE'), wrap(async (req, res) => {
  await mail.suppress(str(req.body?.address, 320), 'manual', str(req.body?.note, 500), undefined, actor(req).id);
  res.status(201).json(ok({ added: true }));
}));

router.delete('/suppressions/:address', authorizePermission('MAIL_BULK_SEND', 'MAIL_APPROVE'), wrap(async (req, res) => {
  const removed = await mail.unsuppress(decodeURIComponent(req.params.address!));
  res.json(ok({ removed }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * AI assistant (drafting, replying, summarising, planning)
 *
 * Gated on MAIL_AI_USE — Students and Parents do not hold it. Every response
 * carries `providerUsed`. The model only ever sees text the caller is already
 * authorised to read (their own draft, and threads they participate in).
 * ────────────────────────────────────────────────────────────────────────── */

const aiWrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try { await fn(req, res); }
    catch (err) {
      if (err instanceof MailAiError) return res.status(err.status).json(fail(err.message));
      if (err instanceof MailError) return res.status(err.status).json(fail(err.message));
      next(err);
    }
  };

router.get('/ai/status', authorizePermission('MAIL_AI_USE'), (_req, res) => {
  res.json(ok({ available: mailAi.isAnyProviderConfigured() }));
});

router.post('/ai/compose', authorizePermission('MAIL_AI_USE'), aiWrap(async (req, res) => {
  const b = req.body ?? {};
  const action = b.action;
  let threadText: string | undefined;
  if (action === 'reply' && b.threadId) {
    threadText = (await mail.threadPlainText(actor(req).id, str(b.threadId))).text;
  }
  const result = await mailAi.composeAssist({
    action,
    instruction: b.instruction ? str(b.instruction, 2000) : undefined,
    currentText: b.currentText ? str(b.currentText, 20_000) : undefined,
    subject: b.subject ? str(b.subject, 300) : undefined,
    recipients: Array.isArray(b.recipients) ? b.recipients.slice(0, 30).map((x: unknown) => str(x, 120)) : undefined,
    senderName: b.senderName ? str(b.senderName, 120) : actor(req).name,
    tone: b.tone ? str(b.tone, 40) : undefined,
    threadText,
  });
  res.json(ok(result));
}));

router.post('/ai/subject', authorizePermission('MAIL_AI_USE'), aiWrap(async (req, res) => {
  res.json(ok(await mailAi.suggestSubjects(str(req.body?.bodyText, 20_000))));
}));

router.post('/ai/summarize', authorizePermission('MAIL_AI_USE'), aiWrap(async (req, res) => {
  const me = actor(req);
  const { text } = await mail.threadPlainText(me.id, str(req.body?.threadId));
  res.json(ok(await mailAi.summariseThread(text, me.name)));
}));

router.post('/ai/smart-replies', authorizePermission('MAIL_AI_USE'), aiWrap(async (req, res) => {
  const me = actor(req);
  const { text } = await mail.threadPlainText(me.id, str(req.body?.threadId));
  res.json(ok(await mailAi.smartReplies(text, me.name)));
}));

router.post('/ai/campaign', authorizePermission('MAIL_AI_USE'), aiWrap(async (req, res) => {
  res.json(ok(await mailAi.draftCampaign(str(req.body?.brief, 4000), req.body?.audience ? str(req.body.audience, 200) : undefined)));
}));

export default router;
