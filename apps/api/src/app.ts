import express from 'express';
import cors from 'cors';
import { fail } from '@tupo/shared';
import { config } from './config.js';
import ssoRoutes from './routes/sso.js';
import healthRoutes from './routes/health.js';
import rolesPermissionsRoutes from './routes/rolesPermissions.js';
import usersRoutes from './routes/users.js';
import auditRoutes from './routes/audit.js';
import meetRoutes from './routes/meet.js';
import notificationRoutes from './routes/notifications.js';
import chatRoutes from './routes/chat.js';
import mailRoutes from './routes/mail.js';
import feedRoutes from './routes/feed.js';
import searchRoutes from './routes/search.js';
import oversightRoutes from './routes/oversight.js';
import dashboardRoutes from './routes/dashboard.js';
import accessRoutes from './routes/access.js';
import integrationRoutes from './routes/integration.js';
import activityRoutes from './routes/activity.js';

/**
 * The Express app with no side effects — no database init, no listen — so
 * tests can import it straight into supertest. Startup lives in index.ts.
 */
export const app = express();

app.disable('x-powered-by');
// nginx (and the Vite dev proxy) sit on the same host, so the client address is
// the one they put in X-Forwarded-For. Without this every request's req.ip was
// 127.0.0.1: the per-IP guest and sign-in throttles were one global bucket, and
// audit rows and analytics recorded the proxy instead of the person.
app.set('trust proxy', 'loopback');
app.use(cors({ origin: config.corsOrigins, credentials: true }));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Usage analytics. Before the global parser: it has its own (256 kB, and the
// text/plain bodies sendBeacon sends) and no auth middleware (routes/activity.ts).
app.use('/api/activity', activityRoutes);

app.use(express.json({ limit: '1mb' }));

app.use(healthRoutes);
app.use('/api/sso', ssoRoutes);
app.use('/api/roles-permissions', rolesPermissionsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/meet', meetRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/mail', mailRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/oversight', oversightRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/access', accessRoutes);
// Called by the MIS server with the user's MIS token, not a Tupo session.
app.use('/api/integration', integrationRoutes);

app.use((_req, res) => res.status(404).json(fail('Not found')));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // A body express.json could not parse is the caller's mistake, not ours.
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    return res.status(400).json(fail('The request body is not valid JSON.'));
  }
  console.error('[api] unhandled error:', err);
  res.status(500).json(fail('An unexpected error occurred.'));
});
