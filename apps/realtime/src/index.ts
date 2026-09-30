import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { AppNotification } from '@tupo/shared';
import jwt from 'jsonwebtoken';
import { PRESENCE_TTL_SECONDS, PRESENCE_HEARTBEAT_SECONDS } from '@tupo/shared';
import type { ClientToServerEvents, ServerToClientEvents, SessionClaims } from '@tupo/shared';
import { config } from './config.js';
import { registerMeetNamespace } from './meet/namespace.js';
import { ping as pingMeetDb, getPool as getMeetPool } from './meet/db.js';
import { rooms as meetRooms } from './meet/state.js';
import * as chat from '@tupo/chat';
import { registerChatHandlers } from './chat/handlers.js';
import { registerFeedHandlers } from './feed/handlers.js';
import { createAccessCache, findInactiveUsers, sessionEnded } from './access.js';
import {
  broadcastPresence, markOffline, markOnline, readPresence, toStatus,
} from './presence.js';

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

/**
 * Single sign-out: tupo-api publishes `{ userIds }` here after NGA MIS tells
 * it the person signed out. Every open socket of theirs -- chat and meetings,
 * on every device -- is closed at once.
 */
const LOGOUT_CHANNEL = 'tupo:logout';
const logoutSub = pubClient.duplicate();
const SESSION_ENDED = 'unauthorized: you signed out of NGA MIS, please sign in again';

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

    await logoutSub.connect();
    await logoutSub.subscribe(LOGOUT_CHANNEL);
    logoutSub.on('message', (_channel, payload) => {
      void (async () => {
        try {
          const { userIds } = JSON.parse(payload) as { userIds: string[] };
          const ended = new Set(userIds ?? []);
          if (ended.size === 0) return;
          const sockets = [
            ...(await io.local.fetchSockets()),
            ...(await meetNsp.local.fetchSockets()),
          ];
          for (const s of sockets) {
            const u = s.data.user as SessionClaims | undefined;
            if (!u?.id || s.data.guest || !ended.has(u.id)) continue;
            s.disconnect(true);
          }
        } catch {
          // A malformed message must not take the gateway down with it.
        }
      })();
    });

    redisReady = true;
    console.log('[realtime] redis adapter attached');
  } catch (err) {
    console.warn('[realtime] redis unavailable — running single-instance:',
      err instanceof Error ? err.message : err);
  }
}

/**
 * Live account state (status + permission set), shared by the handshake, the
 * per-event guard and the chat handlers. See access.ts.
 */
const accessCache = createAccessCache();

/** `null` to admit, or the error to reject the handshake with. */
async function admitUser(userId: string | undefined): Promise<Error | null> {
  if (!userId) return new Error('unauthorized: malformed session token');
  try {
    const decision = await accessCache.get(userId, { fresh: true });
    return decision.ok ? null : new Error(decision.message);
  } catch (err) {
    // The lookup itself failed (database blip). A handshake rejected by
    // middleware is NOT retried by the socket.io client, so failing closed
    // here would strand every tab that connected during the blip without
    // chat until a reload. Admit instead: the JWT is valid, every handler
    // needs the database anyway, and the periodic sweep disconnects a
    // suspended account as soon as the database answers again.
    console.warn('[realtime] account check failed at handshake, admitting:',
      err instanceof Error ? err.message : err);
    return null;
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

  let claims: SessionClaims;
  try {
    claims = jwt.verify(token, config.jwtSecret) as SessionClaims;
  } catch {
    return next(new Error('unauthorized: invalid or expired session token'));
  }

  // A valid signature is not enough: the account must still exist and be
  // active, exactly as the API's auth middleware requires on every request.
  void admitUser(claims.id).then(async (err) => {
    if (err) return next(err);
    if (await sessionEnded(claims.id, (claims as { iat?: number }).iat)) return next(new Error(SESSION_ENDED));
    socket.data.user = claims;
    next();
  });
});

/**
 * Meet lives in its own namespace rather than on the default one. A meeting
 * generates far more traffic than presence does — captions, speaking state,
 * SDP — and keeping it separate means none of it is broadcast to sockets that
 * only asked for chat presence.
 */
const meetNsp = registerMeetNamespace(io);

// Runs after the namespace's own JWT middleware has set `socket.data.user`.
// Guests hold a meeting ticket, not an account, so they have no row to check.
meetNsp.use((socket, next) => {
  if (socket.data.guest) return next();
  const user = socket.data.user as SessionClaims | undefined;
  void admitUser(user?.id).then(async (err) => {
    if (err) return next(err);
    if (user?.id && await sessionEnded(user.id, (user as { iat?: number }).iat)) return next(new Error(SESSION_ENDED));
    next();
  });
});

/**
 * Suspension has to reach sockets that are sitting idle, not only ones that
 * send something. One batched status query per pass over this instance's own
 * sockets (both namespaces); anyone no longer active is cut off.
 */
const ACCESS_SWEEP_MS = 60_000;
function startAccessSweep(): NodeJS.Timeout {
  return setInterval(() => {
    void (async () => {
      try {
        const sockets = [
          ...(await io.local.fetchSockets()),
          ...(await meetNsp.local.fetchSockets()),
        ];
        const ids = new Set<string>();
        for (const s of sockets) {
          const u = s.data.user as SessionClaims | undefined;
          if (u?.id && !s.data.guest) ids.add(u.id);
        }
        const inactive = await findInactiveUsers([...ids]);
        for (const s of sockets) {
          const u = s.data.user as SessionClaims | undefined;
          if (u?.id && inactive.has(u.id)) {
            accessCache.invalidate(u.id);
            // A server-side disconnect: the client does not auto-reconnect,
            // and if it tries, the handshake check refuses it.
            s.disconnect(true);
          }
        }
        accessCache.prune();
      } catch {
        // A failed sweep is retried next pass; per-event checks still apply.
      }
    })();
  }, ACCESS_SWEEP_MS);
}
const accessSweep = startAccessSweep();

/**
 * Keep the presence keys of everyone still connected from expiring.
 *
 * `presence:<id>` is written with a 90-second TTL and, until this existed,
 * nothing ever refreshed it: a person who sat in a channel reading for two
 * minutes had their key expire underneath them and went grey to everybody,
 * while their socket was open the whole time. The TTL is what makes a crashed
 * gateway or a killed tab fall out of presence on its own, so the answer is a
 * heartbeat rather than a longer TTL.
 *
 * One pass per instance over its own sockets, deduped by user (several tabs
 * are one key), at half the TTL so a single missed pass is harmless.
 */
function startPresenceHeartbeat(): NodeJS.Timeout {
  return setInterval(() => {
    void (async () => {
      if (!redisReady) return;
      try {
        const sockets = await io.local.fetchSockets();
        const ids = new Set<string>();
        for (const s of sockets) {
          const u = s.data.user as SessionClaims | undefined;
          if (u?.id) ids.add(u.id);
        }
        if (!ids.size) return;
        // EXPIRE, not SET: re-setting would clobber a chosen status ("busy",
        // "in a meeting") back to whatever this instance last assumed. If the
        // key has already gone, EXPIRE is a no-op and the next connect or
        // presence:set puts it back.
        const pipeline = presence.pipeline();
        for (const id of ids) pipeline.expire(`presence:${id}`, PRESENCE_TTL_SECONDS);
        await pipeline.exec();
      } catch {
        // Presence is decoration; a failed refresh costs a grey dot, not a
        // connection.
      }
    })();
  }, PRESENCE_HEARTBEAT_SECONDS * 1000);
}

const presenceHeartbeat = startPresenceHeartbeat();

io.on('connection', (socket) => {
  const user = socket.data.user as SessionClaims;

  /*
   * Handlers first, and synchronously.
   *
   * Socket.IO does not queue events for listeners that do not exist yet: an
   * event arriving before its `socket.on` is registered is dropped silently.
   * A client emits `conversation:subscribe` the instant it sees `connect`, so
   * every `await` between here and the registration below is a window in which
   * that subscribe is lost and the conversation simply never receives anything
   * until the next reconnect. The presence bookkeeping that follows touches
   * Postgres and Redis, so that window was real rather than theoretical.
   */
  socket.data.presenceStatus = 'online';
  // Assumed until the preference is read a few lines down. The presence write
  // is what waits for the real answer; nothing is broadcast before then.
  socket.data.presenceVisible = true;

  /*
   * Every inbound event re-checks the account through the short-lived cache,
   * so a suspension lands within ACCESS_CACHE_TTL_MS even on a busy socket.
   * A suspended or deleted account is disconnected and the event dropped.
   * Registered synchronously, before the handlers, for the reason above.
   */
  socket.use((_packet, next) => {
    accessCache.get(user.id).then((decision) => {
      if (decision.ok) return next();
      socket.disconnect(true);
    }, () => {
      // Could not reach the database: let the event through rather than
      // turning a DB blip into a dead chat; the handlers still enforce
      // membership and the sweep catches a suspension once the DB is back.
      next();
    });
  });

  // Chat rides the default namespace alongside presence: it is the baseline
  // traffic of the product, and it shares the per-user room with the shell.
  registerChatHandlers(io, socket, redisReady ? presence : null, accessCache);
  registerFeedHandlers(io, socket);

  /*
   * Presence is opt-out, and the opt-out is enforced here rather than at every
   * reader.
   *
   * Someone who has switched "show my presence" off simply never gets a
   * presence key written and is never broadcast, so every existing lookup —
   * the REST routes, the member panel, another gateway instance — reads them as
   * offline without knowing the preference exists. Filtering at each reader
   * instead would mean one forgotten call site quietly leaking the thing the
   * setting was flicked to hide.
   */
  void (async () => {
    await socket.join(`user:${user.id}`);
    const visible = await chat.showsPresence(user.id).catch(() => true);
    socket.data.presenceVisible = visible;
    if (!visible || socket.disconnected) return;
    await markOnline(redisReady ? presence : null, user.id, 'online');
    // Coming online is worth telling the people who can see it — otherwise the
    // green dot only ever appears on a reload.
    void broadcastPresence(io, user.id, 'online');
  })();

  socket.emit('connection:ready', {
    userId: user.id,
    socketId: socket.id,
    serverTime: new Date().toISOString(),
  });

  socket.on('ping', (ack) => {
    if (typeof ack === 'function') ack({ at: new Date().toISOString() });
  });

  /*
   * The heartbeat, which is what makes the TTL honest.
   *
   * Without it the presence key of someone reading a long thread quietly
   * expires after ninety seconds and everyone watching sees them go offline
   * while they are looking straight at the screen — the bug that teaches people
   * the green dot means nothing.
   *
   * The database write is throttled hard on top of that. Last seen is only ever
   * read for somebody who is *offline*, and the disconnect path writes it
   * exactly; this periodic write exists solely so a process killed with -9,
   * which never reaches that path, still leaves a figure minutes out rather
   * than days.
   */
  let lastSeenWrittenAt = Date.now();
  socket.on('presence:heartbeat', async (ack) => {
    if (socket.data.presenceVisible) {
      const status = toStatus(socket.data.presenceStatus);
      await markOnline(redisReady ? presence : null, user.id, status);
      if (Date.now() - lastSeenWrittenAt > chat.LAST_SEEN_WRITE_INTERVAL_MS) {
        lastSeenWrittenAt = Date.now();
        void chat.touchLastSeen(user.id).catch(() => {});
      }
    }
    if (typeof ack === 'function') ack({ ok: true });
  });

  /**
   * Presence for a named set of people.
   *
   * Bounded, because this is the one presence call a client chooses the size
   * of, and an unbounded roster lookup is an mget of the whole school.
   */
  socket.on('presence:query', async ({ userIds }, ack) => {
    if (typeof ack !== 'function') return;
    const wanted = [...new Set(userIds ?? [])].slice(0, 500);
    ack({ presence: await readPresence(redisReady ? presence : null, wanted) });
  });

  socket.on('presence:set', async ({ status }, ack) => {
    const next = toStatus(status);
    socket.data.presenceStatus = next;

    if (socket.data.presenceVisible) {
      if (next === 'offline') {
        // Appearing offline on purpose. The key goes, exactly as it would on a
        // disconnect, so every reader agrees without needing to know this was
        // a choice rather than a closed laptop.
        await markOffline(redisReady ? presence : null, user.id);
        void broadcastPresence(io, user.id, 'offline', new Date().toISOString());
      } else {
        await markOnline(redisReady ? presence : null, user.id, next);
        void broadcastPresence(io, user.id, next);
      }
    }
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', async () => {
    // Only clear presence when this was the user's last socket — a second tab
    // closing must not show them offline.
    const remaining = await io.in(`user:${user.id}`).fetchSockets();
    if (remaining.length === 0) {
      const at = new Date();
      await markOffline(redisReady ? presence : null, user.id);
      // The last-seen goes out with the status change: the moment a dot turns
      // grey is exactly when the UI needs the line that replaces it.
      void broadcastPresence(
        io, user.id, 'offline',
        socket.data.presenceVisible ? at.toISOString() : null,
      );
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
  clearInterval(presenceHeartbeat);
  clearInterval(accessSweep);
  console.log(`\n[realtime] ${signal} received — telling clients to reconnect elsewhere`);
  io.emit('system:reconnect_required', { reason: 'server shutting down' });
  io.close();
  await getMeetPool().end().catch(() => {});
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
