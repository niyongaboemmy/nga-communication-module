import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { AppNotification } from '@tupo/shared';
import jwt from 'jsonwebtoken';
import { PRESENCE_TTL_SECONDS, PRESENCE_HEARTBEAT_SECONDS, connectedKey, presenceKey } from '@tupo/shared';
import type { ClientToServerEvents, ServerToClientEvents, SessionClaims } from '@tupo/shared';
import { config } from './config.js';
import { registerMeetNamespace } from './meet/namespace.js';
import { ping as pingMeetDb, getPool as getMeetPool } from './meet/db.js';
import { rooms as meetRooms, roomKey as meetRoomKey } from './meet/state.js';
import * as chat from '@tupo/chat';
import { registerChatHandlers } from './chat/handlers.js';
import { hardenSocket, installProcessGuards } from './utils/safeSocket.js';
import { registerFeedHandlers } from './feed/handlers.js';
import { createAccessCache, findInactiveUsers, revocationsFor, sessionEnded } from './access.js';
import { issuedBeforeRevocation } from './utils/ssoLogout.js';
import { stopActivity } from './activity.js';
import { startProcessMetrics, guardDbRole } from '@tupo/db';
import { userRoom } from '@tupo/shared';
import { runWithTid, type TenantCtx } from '@tupo/tenancy';
import { bindSocketTenant, relayRooms, relayTid, socketTid, tenantForSession } from './tenancy.js';
import {
  broadcastPresence, markOffline, readPresence, recomputePresence, toChoice, toStatus, writeChoice,
} from './presence.js';

// Both pools (meet/db and @tupo/db's) use the same login role; a superuser /
// BYPASSRLS one would skip row-level security. Enforce refuses, shadow warns.
try {
  await guardDbRole('realtime', { pool: getMeetPool() });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

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

/*
 * Relay listeners are attached once, at load. Every instance subscribes to the
 * same channels, so each delivers to its OWN sockets only (`io.local`): with
 * the Redis adapter attached, a plain `io.to` would also broadcast to every
 * other instance, and N instances would each deliver N copies (RT-03).
 */
for (const c of [pubClient, subClient, presence, notifySub, chatSub, logoutSub]) {
  // ioredis reconnects by itself once connected; an unhandled 'error' event
  // would otherwise crash the process on the first blip.
  c.on('error', () => {});
}

{
    notifySub.on('message', (_channel, payload) => {
      try {
        const parsed = JSON.parse(payload) as {
          userIds: string[]; notification: AppNotification; tid?: number;
        };
        const { userIds, notification } = parsed;
        // Delivery is per-user-room, so a notification reaches every device
        // that person has open and nobody else's -- in the tenant it was
        // raised in (`t<tid>:user:<id>`).
        const tid = relayTid(parsed);
        for (const id of userIds ?? []) {
          io.local.to(userRoom(id, tid)).emit('notification:new', notification);
        }
      } catch {
        // A malformed message must not take the gateway down with it.
      }
    });

    chatSub.on('message', (_channel, payload) => {
      try {
        const parsed = JSON.parse(payload) as {
          rooms: string[]; event: string; payload: unknown; exceptSocketId?: string;
          leave?: { userIds: string[]; rooms: string[] }; tid?: number;
        };
        // Everything below stays inside the tenant the message names: rooms of
        // any other tenant are dropped (relayRooms), never delivered.
        const tid = relayTid(parsed);
        // A meeting ended outside the room: tell whoever is still in it here,
        // and drop this node's in-memory state for it (E-04).
        const ended = (parsed as { meetEnded?: { meetingId?: string; by?: string | null } }).meetEnded;
        if (ended?.meetingId) {
          meetNsp.local.to(runWithTid(tid, () => meetRoomKey(ended.meetingId!))).emit('meet:ended' as never, {
            by: ended.by ?? null, at: new Date().toISOString(),
            summaryUrl: `/app/meet/${ended.meetingId}/summary`,
          } as never);
          meetRooms.delete(ended.meetingId);
          return;
        }
        // Eviction: these people's sockets leave these rooms, everywhere.
        if (parsed.leave && Array.isArray(parsed.leave.userIds) && Array.isArray(parsed.leave.rooms)) {
          const leaveRooms = relayRooms(parsed.leave.rooms, tid);
          if (leaveRooms.length) io.local.in(parsed.leave.userIds.map((id) => userRoom(id, tid))).socketsLeave(leaveRooms);
          return;
        }
        const { event, payload: data, exceptSocketId } = parsed;
        const rooms = relayRooms(parsed.rooms, tid);
        if (!rooms.length || !event) return;
        const target = exceptSocketId ? io.local.except(exceptSocketId) : io.local;
        // Rooms are named by the publisher, which is our own API — the payload
        // is not client-controlled, so relaying it verbatim is safe.
        (target.to(rooms) as unknown as { emit: (e: string, d: unknown) => void })
          .emit(event, data);
      } catch {
        // A malformed relay message must not take the gateway down with it.
      }
    });

    logoutSub.on('message', (_channel, payload) => {
      void (async () => {
        try {
          const parsed = JSON.parse(payload) as { userIds: string[]; tid?: number };
          const ended = new Set(parsed.userIds ?? []);
          const tid = relayTid(parsed);
          if (ended.size === 0) return;
          const sockets = [
            ...(await io.local.fetchSockets()),
            ...(await meetNsp.local.fetchSockets()),
          ];
          for (const s of sockets) {
            const u = s.data.user as SessionClaims | undefined;
            if (!u?.id || s.data.guest || !ended.has(u.id) || socketTid(s) !== tid) continue;
            s.disconnect(true);
          }
        } catch {
          // A malformed message must not take the gateway down with it.
        }
      })();
    });
}

/**
 * Connect, attach the adapter and subscribe. If Redis is down at boot the
 * gateway still serves (single-instance, no relay) while ioredis keeps
 * reconnecting, and this attaches as soon as every client is up — before, one
 * failed attempt left notifications and the chat relay dead until someone
 * restarted the process (RT-02). After that ioredis resubscribes on its own.
 */
const redisClients = [pubClient, subClient, presence, notifySub, chatSub, logoutSub];

/** Resolve once this client is connected; ioredis keeps retrying underneath. */
async function ensureReady(c: Redis): Promise<void> {
  if (c.status === 'ready') return;
  if (c.status === 'wait' || c.status === 'end') {
    await c.connect();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const ok = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { c.off('ready', ok); reject(new Error(`redis ${c.status}`)); }, 5_000);
    c.once('ready', ok);
  });
}

async function connectRedis(): Promise<void> {
  try {
    await Promise.all(redisClients.map(ensureReady));
    io.adapter(createAdapter(pubClient, subClient));
    await notifySub.subscribe(NOTIFY_CHANNEL);
    await chatSub.subscribe(CHAT_CHANNEL);
    await logoutSub.subscribe(LOGOUT_CHANNEL);
    redisReady = true;
    console.log('[realtime] redis adapter attached');
  } catch (err) {
    console.warn('[realtime] redis unavailable — single-instance for now, retrying:',
      err instanceof Error ? err.message : err);
    setTimeout(() => void connectRedis(), 2_000).unref();
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

  // The session's school first (contract §6): status gates and the
  // MIS-token mismatch rule, exactly as the API applies them. Then, inside
  // that tenant, a valid signature is not enough: the account must still
  // exist and be active, as the API's auth middleware requires.
  void (async () => {
    const t = await tenantForSession(claims);
    if (!t.ok) return next(new Error(t.message));
    socket.data.tenant = t.tenant;
    const err = await runWithTid(t.tenant.tid, () => admitUser(claims.id));
    if (err) return next(err);
    if (await runWithTid(t.tenant.tid, () => sessionEnded(claims.id, (claims as { iat?: number }).iat))) return next(new Error(SESSION_ENDED));
    socket.data.user = claims;
    next();
  })().catch(() => next(new Error('unauthorized: could not check the session')));
});

/**
 * Meet lives in its own namespace rather than on the default one. A meeting
 * generates far more traffic than presence does — captions, speaking state,
 * SDP — and keeping it separate means none of it is broadcast to sockets that
 * only asked for chat presence.
 */
const meetNsp = registerMeetNamespace(io, {
  // Joining or leaving a call moves "in a meeting" (F-10).
  onMeetingPresence: (userId) => { void recomputePresence(io, redisReady ? presence : null, userId).catch(() => {}); },
});

// Runs after the namespace's own JWT middleware has set `socket.data.user`.
// Guests hold a meeting ticket, not an account, so they have no row to check.
meetNsp.use((socket, next) => {
  void (async () => {
    // Guests' tickets name the meeting's tenant; sessions go through the gate.
    const claims = socket.data.guestClaims ?? socket.data.user;
    const t = await tenantForSession((claims ?? {}) as SessionClaims);
    if (!t.ok) return next(new Error(t.message));
    socket.data.tenant = t.tenant;
    if (socket.data.guest) return next();
    const user = socket.data.user as SessionClaims | undefined;
    const err = await runWithTid(t.tenant.tid, () => admitUser(user?.id));
    if (err) return next(err);
    if (user?.id && await runWithTid(t.tenant.tid, () => sessionEnded(user.id, (user as { iat?: number }).iat))) return next(new Error(SESSION_ENDED));
    next();
  })().catch(() => next(new Error('unauthorized: could not check the session')));
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
        // Grouped by tenant: each school's users are read inside its own
        // context (RLS would hide every other school's rows).
        const idsByTenant = new Map<number, Set<string>>();
        for (const s of sockets) {
          const u = s.data.user as SessionClaims | undefined;
          if (!u?.id || s.data.guest) continue;
          const tid = socketTid(s);
          if (!idsByTenant.has(tid)) idsByTenant.set(tid, new Set());
          idsByTenant.get(tid)!.add(u.id);
        }
        const inactive = new Set<string>();
        const revokedAt = new Map<string, Date>();
        for (const [tid, ids] of idsByTenant) {
          await runWithTid(tid, async () => {
            for (const id of await findInactiveUsers([...ids])) inactive.add(`${tid}:${id}`);
            for (const [id, at] of await revocationsFor([...ids])) revokedAt.set(`${tid}:${id}`, at);
          });
        }
        const nowSec = Date.now() / 1000;
        for (const s of sockets) {
          const u = s.data.user as (SessionClaims & { iat?: number; exp?: number }) | undefined;
          if (!u?.id || s.data.guest) continue;
          // The JWT is checked at the handshake; a socket lives for hours, so
          // the sweep also ends sessions that expired or were revoked since
          // (single sign-out, suspension) — RT-04.
          const key = `${socketTid(s)}:${u.id}`;
          const reason = inactive.has(key) ? 'suspended'
            : issuedBeforeRevocation(u.iat, revokedAt.get(key) ?? null) ? 'signed_out'
            : u.exp && u.exp < nowSec ? 'expired'
            : null;
          if (!reason) continue;
          accessCache.invalidate(u.id);
          s.emit('session:ended', { reason });
          // A server-side disconnect: the client does not auto-reconnect,
          // and if it tries, the handshake check refuses it.
          s.disconnect(true);
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
        for (const id of ids) {
          pipeline.expire(`presence:${id}`, PRESENCE_TTL_SECONDS);
          pipeline.set(connectedKey(id), '1', 'EX', PRESENCE_TTL_SECONDS);
        }
        await pipeline.exec();
      } catch {
        // Presence is decoration; a failed refresh costs a grey dot, not a
        // connection.
      }
    })();
  }, PRESENCE_HEARTBEAT_SECONDS * 1000);
}

const presenceHeartbeat = startPresenceHeartbeat();

installProcessGuards('realtime');

// The gateway's own numbers (R-04): connected sockets, and new connections per
// minute — a burst of the latter after a deploy is the reconnect wave.
const metrics = startProcessMetrics('realtime');
metrics.gauge('sockets', () => io.engine.clientsCount);
metrics.gauge('meet_sockets', () => meetNsp.sockets.size);

io.on('connection', (socket) => {
  // Every listener below runs inside the socket's tenant (see tenancy.ts).
  const tenant = socket.data.tenant as TenantCtx;
  bindSocketTenant(socket, tenant);
  runWithTid(tenant.tid, () => onConnection(socket));
});

function onConnection(socket: Parameters<Parameters<typeof io.on<'connection'>>[1]>[0]) {
  metrics.count('connections');
  hardenSocket(socket);
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
  socket.data.presenceReady = (async () => {
    await socket.join(userRoom(user.id));
    const visible = await chat.showsPresence(user.id).catch(() => true);
    socket.data.presenceVisible = visible;
    if (socket.disconnected) return;
    // Coming online is worth telling the people who can see it — otherwise the
    // green dot only ever appears on a reload. A status picked on another
    // device (busy, do not disturb) holds; this tab only adds its activity.
    await recomputePresence(io, redisReady ? presence : null, user.id).catch(() => {});
  })().catch(() => { /* presence is decoration */ });

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
      // Keep the key alive as it is; only when it has gone (a Redis restart)
      // is the status worked out again and rewritten.
      const alive = redisReady
        ? await presence.expire(presenceKey(user.id), PRESENCE_TTL_SECONDS).catch(() => 1)
        : 1;
      if (!alive) await recomputePresence(io, presence, user.id).catch(() => {});
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
    const decision = await accessCache.get(user.id).catch(() => null);
    if (!decision?.ok || !decision.access.permissions.has('PRESENCE_VIEW')) return ack({ presence: {} });
    const wanted = [...new Set(Array.isArray(userIds) ? userIds : [])]
      .filter((id): id is string => typeof id === 'string' && id.length <= 32).slice(0, 200);
    // A block hides presence both ways (B-05): those people read as offline.
    const hidden = await chat.separatedFrom(user.id, wanted).catch(() => new Set<string>());
    if (hidden.size) {
      const shown = await readPresence(redisReady ? presence : null, wanted.filter((id) => !hidden.has(id)));
      for (const id of hidden) shown[id] = { status: 'offline', lastSeenAt: null } as (typeof shown)[string];
      return ack({ presence: shown });
    }
    ack({ presence: await readPresence(redisReady ? presence : null, wanted) });
  });

  /*
   * This tab's activity. Older clients also sent picks through here, so those
   * are honoured as picks rather than read as activity.
   */
  socket.on('presence:set', async ({ status }, ack) => {
    const next = toStatus(status);
    if (next === 'online' || next === 'away') {
      socket.data.presenceStatus = next;
    } else if (next === 'busy' || next === 'dnd' || next === 'offline') {
      await writeChoice(redisReady ? presence : null, user.id, next === 'offline' ? 'invisible' : next);
    }
    await recomputePresence(io, redisReady ? presence : null, user.id).catch(() => {});
    if (typeof ack === 'function') ack({ ok: true });
  });

  /** A status the person picked, for all their devices (F-10). */
  socket.on('presence:choose', async ({ choice }, ack) => {
    await writeChoice(redisReady ? presence : null, user.id, toChoice(choice));
    const outcome = await recomputePresence(io, redisReady ? presence : null, user.id)
      .catch(() => ({ choice: toChoice(choice), status: 'online' as const }));
    if (typeof ack === 'function') ack({ ok: true, ...outcome });
  });

  socket.on('disconnect', async () => {
    // Only clear presence when this was the user's last socket — a second tab
    // closing must not show them offline.
    const remaining = await io.in(userRoom(user.id)).fetchSockets();
    if (remaining.length === 0) {
      const at = new Date();
      if (redisReady) await presence.del(connectedKey(user.id)).catch(() => 0);
      await markOffline(redisReady ? presence : null, user.id);
      // The last-seen goes out with the status change: the moment a dot turns
      // grey is exactly when the UI needs the line that replaces it.
      void broadcastPresence(
        io, user.id, 'offline',
        socket.data.presenceVisible ? at.toISOString() : null,
      );
    } else {
      // The tab in use closed beside an idle one: the person may now be away.
      await recomputePresence(io, redisReady ? presence : null, user.id).catch(() => {});
    }
  });
}

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

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  clearInterval(presenceHeartbeat);
  clearInterval(accessSweep);
  void metrics.stop();
  console.log(`\n[realtime] ${signal} received — telling clients to reconnect`);
  // Clients treat this as a planned restart: no session re-check, and each
  // reconnects after its own random delay so they do not all return at once
  // (R-02). A short pause lets the notice leave before the sockets close.
  io.emit('system:reconnect_required', { reason: 'server restarting' });
  io.of('/meet').emit('system:reconnect_required', { reason: 'server restarting' });
  await new Promise((r) => setTimeout(r, 250));
  setTimeout(() => process.exit(0), 8_000).unref();
  // A server-side disconnect, not a dropped transport: socket.io's own retry
  // would bring every client back within a second; this way each one waits
  // its own random delay.
  io.disconnectSockets();
  io.of('/meet').disconnectSockets();
  await new Promise((r) => setTimeout(r, 150));
  io.close();
  await getMeetPool().end().catch(() => {});
  await stopActivity();
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
