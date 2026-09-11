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

/**
 * The Express app with no side effects — no database init, no listen — so
 * tests can import it straight into supertest. Startup lives in index.ts.
 */
export const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

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

app.use((_req, res) => res.status(404).json(fail('Not found')));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api] unhandled error:', err);
  res.status(500).json(fail('An unexpected error occurred.'));
});
