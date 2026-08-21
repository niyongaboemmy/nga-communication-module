import { Router, type Request, type Response } from 'express';
import { ok, fail } from '@tupo/shared';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import * as notifications from '../services/notificationService.js';

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

  const [rows, unread] = await Promise.all([
    notifications.listFor(userId, {
      unreadOnly: req.query.unread === 'true',
      limit: Number.isFinite(limit) ? limit : 30,
    }),
    notifications.unreadCount(userId),
  ]);

  res.json(ok({ notifications: rows.map(notifications.toWire), unread }));
});

router.post('/:id/read', async (req: Request, res: Response) => {
  const userId = actor(req).id;
  const done = await notifications.markRead(userId, req.params.id ?? '');
  if (!done) return res.status(404).json(fail('Notification not found.'));
  res.json(ok({ read: true, unread: await notifications.unreadCount(userId) }));
});

router.post('/read-all', async (req: Request, res: Response) => {
  const count = await notifications.markAllRead(actor(req).id);
  res.json(ok({ read: count, unread: 0 }));
});

export default router;
