import { Router, type Request, type Response } from 'express';
import { ok, fail } from '@tupo/shared';
import * as notifications from '@tupo/notify';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';

/**
 * Web push subscriptions (F-04). A browser that allowed notifications sends
 * its subscription here; the server pushes to it when the person is offline.
 */
const router = Router();
router.use(authMiddleware);
const actor = (req: Request) => (req as AuthenticatedRequest).user!;

/** Whether push is available here, and the key the browser subscribes with. */
router.get('/config', (_req: Request, res: Response) => {
  const cfg = notifications.pushConfigFromEnv();
  res.json(ok({ enabled: Boolean(cfg), publicKey: cfg?.publicKey ?? null }));
});

router.post('/subscriptions', async (req: Request, res: Response) => {
  if (!notifications.pushConfigFromEnv()) return res.status(503).json(fail('Push notifications are not set up on this server.'));
  try {
    await notifications.saveSubscription(actor(req).id, req.body?.subscription, req.headers['user-agent'] ?? null);
    res.status(201).json(ok({ subscribed: true }));
  } catch (err) {
    res.status(400).json(fail(err instanceof Error ? err.message : 'Invalid subscription.'));
  }
});

router.delete('/subscriptions', async (req: Request, res: Response) => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
  if (endpoint) await notifications.removeSubscription(actor(req).id, endpoint);
  res.json(ok({ subscribed: false }));
});

export default router;
