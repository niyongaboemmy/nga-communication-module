import { Router, type Request, type Response } from 'express';
import { ok, fail } from '@tupo/shared';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import * as notifications from '@tupo/notify';
import { emitToUsers } from '../services/chatRealtime.js';

/**
 * Notifications.
 *
 * Every route is scoped to the caller. There is no way to read or dismiss
 * anyone else's, and an id from elsewhere simply matches nothing — the owner
 * is part of every WHERE clause rather than checked separately, so there is no
 * ordering in which the check can be skipped.
 */
const router = Router();
router.use(authMiddleware);

const actor = (req: Request) => (req as AuthenticatedRequest).user!;

router.get('/', async (req: Request, res: Response) => {
  const userId = actor(req).id;
  const limit = Number(req.query.limit ?? 30);
  const module = typeof req.query.module === 'string' ? req.query.module : null;

  const [rows, unread] = await Promise.all([
    notifications.listFor(userId, {
      unreadOnly: req.query.unread === 'true',
      limit: Number.isFinite(limit) ? limit : 30,
      before: typeof req.query.before === 'string' ? req.query.before : null,
      module: module as notifications.NotificationModule | null,
    }),
    notifications.unreadCount(userId),
  ]);

  res.json(ok({
    notifications: rows.map(notifications.toWire), unread,
    // Paging by time: the next page is everything older than the last one shown.
    nextBefore: rows.length ? rows[rows.length - 1]!.created_at : null,
  }));
});

/** Unread per module — the Feed and Meet badges in the shell read these (F-03). */
router.get('/counts', async (req: Request, res: Response) => {
  res.json(ok({ byModule: await notifications.unreadByModule(actor(req).id) }));
});

/** Tell the person's other devices, so every bell agrees. */
async function announceRead(userId: string, ids: string[] | 'all'): Promise<number> {
  const unread = await notifications.unreadCount(userId);
  if (ids === 'all' || ids.length) emitToUsers([userId], 'notification:read', { ids, unread });
  return unread;
}

router.post('/:id/read', async (req: Request, res: Response) => {
  const userId = actor(req).id;
  const done = await notifications.markRead(userId, req.params.id ?? '');
  if (!done) return res.status(404).json(fail('Notification not found.'));
  res.json(ok({ read: true, unread: await announceRead(userId, [req.params.id!]) }));
});

router.post('/read', async (req: Request, res: Response) => {
  const userId = actor(req).id;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: unknown) => typeof x === 'string') : [];
  const changed = await notifications.markManyRead(userId, ids);
  res.json(ok({ read: changed.length, unread: await announceRead(userId, changed) }));
});

router.post('/read-all', async (req: Request, res: Response) => {
  const userId = actor(req).id;
  const count = await notifications.markAllRead(userId);
  res.json(ok({ read: count, unread: await announceRead(userId, 'all') }));
});

export default router;
