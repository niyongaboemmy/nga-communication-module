import { appendFileSync } from 'node:fs';
import './utils/asyncErrors.js';
import express from 'express';
import cors from 'cors';
import { fail } from '@tupo/shared';
import { config } from './config.js';
import { rateLimit } from './middleware/rateLimit.js';
import { isAiDisabledError, aiDisabledBody } from './services/aiPolicy.js';
import { handoffResponse } from './services/externalAi.js';
import ssoRoutes from './routes/sso.js';
import healthRoutes from './routes/health.js';
import rolesPermissionsRoutes from './routes/rolesPermissions.js';
import usersRoutes from './routes/users.js';
import auditRoutes from './routes/audit.js';
import meetRoutes from './routes/meet.js';
import notificationRoutes from './routes/notifications.js';
import pushRoutes from './routes/push.js';
import chatRoutes from './routes/chat.js';
import mailRoutes from './routes/mail.js';
import feedRoutes from './routes/feed.js';
import searchRoutes from './routes/search.js';
import oversightRoutes from './routes/oversight.js';
import dashboardRoutes from './routes/dashboard.js';
import accessRoutes from './routes/access.js';
import integrationRoutes from './routes/integration.js';
import activityRoutes from './routes/activity.js';
import aiRoutes from './routes/ai.js';
import systemRoutes from './routes/system.js';
import { requestMetrics } from './services/observability.js';
import { recordError, RELEASE } from '@tupo/db';

/**
 * The Express app with no side effects — no database init, no listen — so
 * tests can import it straight into supertest. Startup lives in index.ts.
 */
export const app = express();

app.disable('x-powered-by');
// Requests, errors and latency per minute (R-04); a no-op until index.ts starts metrics.
app.use(requestMetrics);
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

// LOG_HTTP_ERRORS=1 (console) or =/path/to/file: log every 4xx/5xx with its
// message — for chasing a test or probe that only fails inside a long run
// (test runners hide console output of passing tests). Off unless asked for.
const httpErrorLog = process.env.LOG_HTTP_ERRORS;
if (httpErrorLog) {
  app.use((req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 400) {
        const line = `${new Date().toISOString()} [${process.pid}] [http ${res.statusCode}] ${req.method} ${req.originalUrl} — ${JSON.stringify(body).slice(0, 200)}`;
        if (httpErrorLog === '1') console.log(line);
        else try { appendFileSync(httpErrorLog, line + '\n'); } catch { /* best effort */ }
      }
      return json(body);
    };
    next();
  });
}
// Per-person ceilings on the write paths that can be flooded (A-03).
app.use(rateLimit);

app.use(healthRoutes);
app.use('/api/sso', ssoRoutes);
app.use('/api/roles-permissions', rolesPermissionsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/meet', meetRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/mail', mailRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/oversight', oversightRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/access', accessRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/system', systemRoutes);
// Called by the MIS server with the user's MIS token, not a Tupo session.
app.use('/api/integration', integrationRoutes);

app.use((_req, res) => res.status(404).json(fail('Not found')));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) return;
  // A body express.json could not parse is the caller's mistake, not ours.
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    return res.status(400).json(fail('The request body is not valid JSON.'));
  }
  // Any AI route that let the chokepoint's refusal through still answers 403.
  if (isAiDisabledError(err)) return res.status(403).json(aiDisabledBody(err));
  // An AI route that let a hand-off prompt (200) or refusal through.
  const handoff = handoffResponse(err);
  if (handoff) return res.status(handoff.status).json(handoff.body);
  if ((err as { type?: string }).type === 'entity.too.large') {
    return res.status(413).json(fail('The request is too large.'));
  }
  // Schema validation failures name the field, never the internals.
  if (err.name === 'ZodError') {
    const issue = (err as unknown as { issues?: Array<{ path: unknown[]; message: string }> }).issues?.[0];
    const where = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
    return res.status(400).json(fail(`Invalid request — ${where}${issue?.message ?? 'check the values sent'}.`));
  }
  // Domain errors (ChatError, FeedError, MailError, …) carry their own status.
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return res.status(status).json(fail(err.message));
  }
  // PostgreSQL rejecting a malformed value (bad number, id, date or enum) is a
  // bad request, not a server fault — and its text never goes back out.
  const pgCode = (err as { code?: unknown }).code;
  if (typeof pgCode === 'string' && /^22/.test(pgCode)) {
    return res.status(400).json(fail('One of the values sent is not valid.'));
  }
  console.error(`[api] unhandled error on ${req.method} ${req.path}:`, err);
  // Grouped on the System page (R-05). The route pattern, not the URL, so
  // /messages/123 and /messages/456 are one problem.
  void recordError({
    source: 'api', message: err.message, stack: err.stack, release: RELEASE,
    route: `${req.method} ${req.baseUrl}${(req.route as { path?: string } | undefined)?.path ?? req.path}`,
    userId: (req as express.Request & { user?: { id?: string } }).user?.id ?? null,
  });
  res.status(500).json(fail('An unexpected error occurred.'));
});
