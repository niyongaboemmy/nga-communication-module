import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { activity } from '../activity/relay.js';

/**
 * Platform usage analytics intake (USAGE_ANALYTICS_IMPLEMENTATION_PLAN.md §5.2).
 *
 * Mounted in app.ts BEFORE the global JSON parser, so it brings its own: 256 kB,
 * and `text/plain` too, which is what `navigator.sendBeacon` sends. There is no
 * auth middleware here on purpose -- public pages (sign-in, guest meetings) are
 * tracked as visitors, and the relay decides identity from the session itself.
 * Nothing on this router can answer 401, so the SPA's "dead session → sign in
 * again" handling is never triggered by analytics.
 */
const router = Router();

router.post(
  '/',
  express.json({ limit: '256kb', type: ['application/json', 'text/plain'] }),
  (req: Request, res: Response) => activity().handler(req, res),
);

router.get('/config', (req: Request, res: Response) => activity().configHandler(req, res));

// A body that is too large or not JSON is dropped like any other bad batch:
// analytics answers 204, never an error the browser would retry or log.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
router.use((_err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(204).end();
});

export default router;
