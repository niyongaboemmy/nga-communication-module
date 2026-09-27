import { Router, type Request, type Response, type NextFunction } from 'express';
import { ok, fail } from '@tupo/shared';
import * as chat from '@tupo/chat';
import { ChatError } from '@tupo/chat';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { authorizePermission } from '../middleware/authorize.js';
import { emitToConversation, emitToUsers } from '../services/chatRealtime.js';
import { audit } from '../services/userService.js';
import { requireRestricted, forwardOversightAudit } from '../access/oversight.js';

// Access control v2: in enforce these also demand the v2 capability at its
// restricted depth, and every read/redaction is forwarded to the MIS audit log.
const VIEW = [authorizePermission('OVERSIGHT_VIEW_ALL'), requireRestricted('OVERSIGHT_VIEW_ALL', 'sensitive')];
const REDACT = [authorizePermission('OVERSIGHT_MESSAGE_DELETE'), requireRestricted('OVERSIGHT_MESSAGE_DELETE', null)];

/**
 * Academic-conduct oversight.
 *
 * Tupo is a communication tool used for school business, so somebody
 * accountable has to be able to check what is being communicated in it — even
 * inside private groups and one-to-one DMs. This router is that window, and it
 * is deliberately small:
 *
 *   • `OVERSIGHT_VIEW_ALL`        — list every conversation, open any one, read
 *                                   its messages. Opening a conversation's
 *                                   contents is written to the audit log.
 *   • `OVERSIGHT_MESSAGE_DELETE`  — remove a single message that breaks the
 *                                   rules, with a mandatory reason, always
 *                                   audit-logged.
 *
 * There is no endpoint here to post, join, rename, or add members. Oversight is
 * "read, and redact what violates policy" — nothing more. The service layer
 * does no membership check on purpose, so these permission gates are the whole
 * of the access control and must never be loosened.
 */
const router = Router();
router.use(authMiddleware);

const actor = (req: Request) => (req as AuthenticatedRequest).user!;

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try { await fn(req, res); }
    catch (err) {
      if (err instanceof ChatError) return res.status(err.status).json(fail(err.message));
      next(err);
    }
  };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/* ────────────────────────────────────────────────────────────────────────── *
 * Overview
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/stats', ...VIEW, wrap(async (_req, res) => {
  res.json(ok({ stats: await chat.oversightStats() }));
}));

/* ────────────────────────────────────────────────────────────────────────── *
 * Conversations
 * ────────────────────────────────────────────────────────────────────────── */

router.get('/conversations', ...VIEW, wrap(async (req, res) => {
  const result = await chat.oversightListConversations({
    query: str(req.query.q),
    type: str(req.query.type) as never,
    includeArchived: req.query.includeArchived === 'true',
    limit: num(req.query.limit),
    offset: num(req.query.offset),
  });
  res.json(ok(result));
}));

/**
 * One conversation, with its roster.
 *
 * Metadata only — the member list and the counts — so this is not itself a read
 * of anyone's words and is not audit-logged. Fetching the messages is, below.
 */
router.get('/conversations/:id', ...VIEW, wrap(async (req, res) => {
  const conversation = await chat.oversightGetConversation(req.params.id!);
  await forwardOversightAudit(req, {
    action: 'oversight.conversation.open',
    target: { conversationId: conversation.id, conversationType: conversation.type },
  });
  res.json(ok({ conversation }));
}));

/**
 * The messages themselves.
 *
 * This is the read that matters, so every page of it lands in the audit log
 * against the reviewer's name. Pagination uses the same `before`/`after` seq
 * cursor as the ordinary message endpoint.
 */
router.get('/conversations/:id/messages',
  ...VIEW, wrap(async (req, res) => {
    const me = actor(req);
    const id = req.params.id!;

    // 404s here if the conversation does not exist, before we log anything.
    const conversation = await chat.oversightGetConversation(id);

    // Deleted messages come back with their preserved content, not a blank
    // tombstone — the whole point of an academic-conduct review is being able
    // to read the message that was taken down.
    const page = await chat.oversightListMessages(me.id, id, {
      before: num(req.query.before),
      after: num(req.query.after),
      limit: num(req.query.limit),
      threadRootId: str(req.query.thread),
    });

    await audit({
      actorId: me.id,
      action: 'chat.oversight.conversation.read',
      targetType: 'conversation',
      targetId: id,
      metadata: {
        conversationType: conversation.type,
        conversationName: conversation.name,
        isPrivate: conversation.isPrivate,
        messagesReturned: page.messages.length,
        deletedMessagesRevealed: page.messages.filter((m) => m.deletedAt).length,
        before: num(req.query.before) ?? null,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    await forwardOversightAudit(req, {
      action: 'oversight.conversation.read',
      target: {
        conversationId: id, conversationType: conversation.type,
        messagesReturned: page.messages.length,
        deletedMessagesRevealed: page.messages.filter((m) => m.deletedAt).length,
      },
    });

    res.json(ok(page));
  }));

/* ────────────────────────────────────────────────────────────────────────── *
 * Redaction
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Remove a message that violates the rules.
 *
 * A reason is required — a redaction power with no stated cause is
 * indistinguishable from censorship — and the removal is audit-logged with that
 * reason and the text that was taken down. The conversation's members are told
 * in real time, exactly as they would be for a moderator delete, so the message
 * disappears for everyone without a reload.
 */
router.post('/conversations/:id/messages/:messageId/remove',
  ...REDACT, wrap(async (req, res) => {
    const me = actor(req);
    const { id, messageId } = req.params as { id: string; messageId: string };

    const reason = String(req.body?.reason ?? '').trim();
    if (reason.length < 3) {
      return res.status(400).json(fail('A reason is required to remove a message.'));
    }

    const result = await chat.oversightDeleteMessage(me.id, id, messageId);

    await audit({
      actorId: me.id,
      action: 'chat.oversight.message.remove',
      targetType: 'message',
      targetId: messageId,
      metadata: {
        conversationId: id,
        conversationName: result.conversationName,
        authorId: result.senderId,
        authorName: result.senderName,
        seq: result.seq,
        reason,
        removedText: result.removedBody,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    // The central copy carries no message text — ids and the reason only.
    await forwardOversightAudit(req, {
      action: 'oversight.message.remove',
      subjectUserId: result.senderId,
      target: { conversationId: id, messageId, seq: result.seq },
      reason,
    });

    emitToConversation(id, 'message:deleted', {
      conversationId: id, messageId, deletedBy: me.id, byModerator: true,
    });

    // Everyone's unread arithmetic changed — mirror what the chat delete does.
    const members = await chat.memberIdsOf(id);
    const counts = await chat.unreadFor(members, id);
    for (const [userId, c] of Object.entries(counts)) {
      emitToUsers([userId], 'conversation:unread', {
        conversationId: id, unread: c.unread, unreadMentions: c.unreadMentions,
        lastReadSeq: c.lastReadSeq,
      });
    }

    res.json(ok({ removed: true, seq: result.seq }));
  }));

/**
 * Remove one attachment from a message, leaving the message itself.
 *
 * A message can be fine while a file it carries is not — a photo that should
 * never have been posted, a document with a pupil's personal data. Same
 * safeguards as a message removal: a reason is required, the file is detached
 * and soft-deleted so it stops being served, and it is all audit-logged with
 * the reason and the file name. The conversation's members get the updated
 * message in real time.
 */
router.post('/conversations/:id/messages/:messageId/attachments/:fileId/remove',
  ...REDACT, wrap(async (req, res) => {
    const me = actor(req);
    const { id, messageId, fileId } = req.params as {
      id: string; messageId: string; fileId: string;
    };

    const reason = String(req.body?.reason ?? '').trim();
    if (reason.length < 3) {
      return res.status(400).json(fail('A reason is required to remove an attachment.'));
    }

    const result = await chat.oversightRemoveAttachment(id, messageId, fileId);

    await audit({
      actorId: me.id,
      action: 'chat.oversight.attachment.remove',
      targetType: 'message',
      targetId: messageId,
      metadata: {
        conversationId: id,
        conversationName: result.conversationName,
        fileId,
        fileName: result.fileName,
        fileKind: result.fileKind,
        authorId: result.senderId,
        authorName: result.senderName,
        seq: result.seq,
        reason,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    await forwardOversightAudit(req, {
      action: 'oversight.attachment.remove',
      subjectUserId: result.senderId,
      target: { conversationId: id, messageId, fileId, seq: result.seq },
      reason,
    });

    // Everyone looking at the conversation repaints the message without its file.
    const message = await chat.getMessage(me.id, id, messageId);
    if (message) emitToConversation(id, 'message:updated', { conversationId: id, message });

    res.json(ok({ removed: true, remaining: result.remaining, message }));
  }));

export default router;
