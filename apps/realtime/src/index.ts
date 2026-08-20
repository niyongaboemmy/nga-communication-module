import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { PRESENCE_TTL_SECONDS } from '@tupo/shared';
import type { ClientToServerEvents, ServerToClientEvents, SessionClaims } from '@tupo/shared';
import { config } from './config.js';

const app = express();
const server = http.createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: { origin: config.corsOrigins, credentials: true },
  // Long-polling stays enabled as a fallback: some school and mobile networks
  // block WebSocket upgrades outright (SRS §5.2).
  transports: ['websocket', 'polling'],
});

/**
 * Redis is used for two separate jobs: the Socket.IO adapter (so several
 * gateway instances can fan out to each other) and presence keys. A failure
 * here degrades realtime to single-instance rather than taking it down.
 */
const pubClient = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
const subClient = pubClient.duplicate();
const presence = pubClient.duplicate();
let redisReady = false;

async function connectRedis(): Promise<void> {
  try {
    await Promise.all([pubClient.connect(), subClient.connect(), presence.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    redisReady = true;
    console.log('[realtime] redis adapter attached');
  } catch (err) {
    console.warn('[realtime] redis unavailable — running single-instance:',
      err instanceof Error ? err.message : err);
  }
}

/**
 * Handshake authentication. The gateway accepts the SAME session JWT the API
 * issues — there is no separate socket credential, and no anonymous socket.
 */
io.use((socket, next) => {
  const token =
    (socket.handshake.auth as { token?: string })?.token ??
    socket.handshake.headers.authorization?.replace(/^Bearer /, '');

  if (!token) return next(new Error('unauthorized: no session token'));

  try {
    const claims = jwt.verify(token, config.jwtSecret) as SessionClaims;
    socket.data.user = claims;
    next();
  } catch {
    next(new Error('unauthorized: invalid or expired session token'));
  }
});

io.on('connection', async (socket) => {
  const user = socket.data.user as SessionClaims;
  await socket.join(`user:${user.id}`);

  if (redisReady) {
    await presence.set(`presence:${user.id}`, 'online', 'EX', PRESENCE_TTL_SECONDS);
  }

  socket.emit('connection:ready', {
    userId: user.id,
    socketId: socket.id,
    serverTime: new Date().toISOString(),
  });

  socket.on('ping', (ack) => {
    if (typeof ack === 'function') ack({ at: new Date().toISOString() });
  });

  socket.on('presence:set', async ({ status }, ack) => {
    if (redisReady) await presence.set(`presence:${user.id}`, status, 'EX', PRESENCE_TTL_SECONDS);
    socket.to(`user:${user.id}`).emit('presence:update', {
      userId: user.id, status, at: new Date().toISOString(),
    });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', async () => {
    // Only clear presence when this was the user's last socket — a second tab
    // closing must not show them offline.
    const remaining = await io.in(`user:${user.id}`).fetchSockets();
    if (remaining.length === 0 && redisReady) await presence.del(`presence:${user.id}`);
  });
});

app.get('/health', async (_req, res) => {
  const checks: Record<string, string> = { socketio: 'ok' };
  let healthy = true;
  try {
    if (redisReady) { await presence.ping(); checks.redis = 'ok'; }
    else { checks.redis = 'unavailable (single-instance mode)'; }
  } catch (err) {
    checks.redis = err instanceof Error ? `error: ${err.message}` : 'error';
    healthy = false;
  }
  res.status(healthy ? 200 : 503).json({
    service: 'tupo-realtime',
    status: healthy ? 'healthy' : 'degraded',
    checks,
    connections: io.engine.clientsCount,
    uptime: Math.round(process.uptime()),
    date: new Date().toISOString(),
  });
});

await connectRedis();
server.listen(config.port, () => {
  console.log(`🔌 tupo-realtime listening on http://localhost:${config.port}  (env: ${config.env})`);
});

const shutdown = async (signal: string) => {
  console.log(`\n[realtime] ${signal} received — telling clients to reconnect elsewhere`);
  io.emit('system:reconnect_required', { reason: 'server shutting down' });
  io.close();
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
