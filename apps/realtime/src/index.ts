import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { AppNotification } from '@tupo/shared';
import jwt from 'jsonwebtoken';
import { PRESENCE_TTL_SECONDS } from '@tupo/shared';
import type { ClientToServerEvents, ServerToClientEvents, SessionClaims } from '@tupo/shared';
import { config } from './config.js';
import { registerMeetNamespace } from './meet/namespace.js';
import { ping as pingMeetDb, getPool as getMeetPool } from './meet/db.js';
import { rooms as meetRooms } from './meet/state.js';
import { registerChatHandlers, broadcastPresence } from './chat/handlers.js';
import { registerFeedHandlers } from './feed/handlers.js';

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

/**
 * The channel tupo-api publishes notifications on.
 *
 * The API owns durability (it writes the row); this gateway owns delivery. A
 * separate subscriber connection is used rather than the adapter's, because
 * a client in subscriber mode can issue no other commands.
 */
const NOTIFY_CHANNEL = 'tupo:notify';
const notifySub = pubClient.duplicate();

/**
 * The channel tupo-api publishes chat fan-out on.
 *
 * The API handles everything that is not a plain send — pins, reactions from
 * the REST path, preference changes made on another device — and those still
 * have to reach open sockets. Rather than the API holding its own Socket.IO
 * client, it names the rooms and this gateway does the delivery, exactly as it
 * already does for notifications.
 */
const CHAT_CHANNEL = 'tupo:chat';
const chatSub = pubClient.duplicate();

async function connectRedis(): Promise<void> {
  try {
    await Promise.all([pubClient.connect(), subClient.connect(), presence.connect()]);
    io.adapter(createAdapter(pubClient, subClient));

    await notifySub.connect();
    await notifySub.subscribe(NOTIFY_CHANNEL);
    notifySub.on('message', (_channel, payload) => {
      try {
        const { userIds, notification } = JSON.parse(payload) as {
          userIds: string[]; notification: AppNotification;
        };
        // Delivery is per-user-room, so a notification reaches every device
        // that person has open and nobody else's.
        for (const id of userIds ?? []) {
          io.to(`user:${id}`).emit('notification:new', notification);
        }
      } catch {
        // A malformed message must not take the gateway down with it.
      }
    });

    await chatSub.connect();
    await chatSub.subscribe(CHAT_CHANNEL);
    chatSub.on('message', (_channel, payload) => {
      try {
        const { rooms, event, payload: data, exceptSocketId } = JSON.parse(payload) as {
          rooms: string[]; event: string; payload: unknown; exceptSocketId?: string;
        };
        if (!Array.isArray(rooms) || !event) return;
        const target = exceptSocketId ? io.except(exceptSocketId) : io;
        // Rooms are named by the publisher, which is our own API — the payload
        // is not client-controlled, so relaying it verbatim is safe.
        (target.to(rooms) as unknown as { emit: (e: string, d: unknown) => void })
          .emit(event, data);
      } catch {
        // A malformed relay message must not take the gateway down with it.
      }
    });

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

/**
 * Meet lives in its own namespace rather than on the default one. A meeting
 * generates far more traffic than presence does — captions, speaking state,
 * SDP — and keeping it separate means none of it is broadcast to sockets that
 * only asked for chat presence.
 */
const meetNsp = registerMeetNamespace(io);

io.on('connection', async (socket) => {
  const user = socket.data.user as SessionClaims;
  await socket.join(`user:${user.id}`);

  if (redisReady) {
    await presence.set(`presence:${user.id}`, 'online', 'EX', PRESENCE_TTL_SECONDS);
  }
  // Coming online is worth telling the people who can see it — otherwise the
  // green dot only ever appears on a reload.
  void broadcastPresence(io, user.id, 'online');

  // Chat rides the default namespace alongside presence: it is the baseline
  // traffic of the product, and it shares the per-user room with the shell.
  registerChatHandlers(io, socket, redisReady ? presence : null);
  registerFeedHandlers(io, socket);

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
    // The user's own other devices, so a status set on the phone shows on the
    // laptop…
    socket.to(`user:${user.id}`).emit('presence:update', {
      userId: user.id, status, at: new Date().toISOString(),
    });
    // …and everyone who actually renders this person's dot.
    void broadcastPresence(io, user.id, status);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', async () => {
    // Only clear presence when this was the user's last socket — a second tab
    // closing must not show them offline.
    const remaining = await io.in(`user:${user.id}`).fetchSockets();
    if (remaining.length === 0) {
      if (redisReady) await presence.del(`presence:${user.id}`);
      void broadcastPresence(io, user.id, 'offline');
    }
  });
});

app.get('/health', async (_req, res) => {
  const checks: Record<string, string> = { socketio: 'ok' };
  let healthy = true;
  checks.meetDb = (await pingMeetDb()) ? 'ok' : 'unreachable';
  // A gateway that cannot reach the database can still relay a call but cannot
  // record attendance, so it is degraded rather than healthy.
  if (checks.meetDb !== 'ok') healthy = false;
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
    meet: { rooms: meetRooms.size, sockets: meetNsp.sockets.size },
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
  await getMeetPool().end().catch(() => {});
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
