import type { Socket } from 'socket.io';

/**
 * Socket handler safety (A-02).
 *
 * An `async` socket listener that throws becomes an unhandled rejection, and
 * under Node 22 that ends the gateway — every chat, presence and meeting
 * connection with it. Wrapping `socket.on` once per connection catches every
 * listener registered afterwards: the failure is logged with the event name
 * and, when the client asked for an acknowledgement, answered with
 * `{ ok: false }` instead of silence.
 */
/**
 * Per-socket event ceilings (A-03). Typing is throttled silently — a client
 * sending it on every keystroke is normal, it just does not need relaying
 * more than every second and a half. Everything else that goes over gets a
 * failed ack (if it asked for one) and is dropped.
 */
const EVENT_LIMITS: Array<{ match: RegExp; limit: number; windowMs: number; silent?: boolean }> = [
  { match: /^typing:start$/, limit: 1, windowMs: 1_500, silent: true },
  { match: /^message:send$/, limit: 60, windowMs: 60_000 },
  { match: /^message:(react|edit|delete)$/, limit: 120, windowMs: 60_000 },
  { match: /^(conversation|feed):subscribe$/, limit: 60, windowMs: 60_000 },
  { match: /^meet:(chat|caption|reaction|hand|poll|question)/, limit: 120, windowMs: 60_000 },
  { match: /./, limit: 600, windowMs: 60_000 },
];

function limitEvents(socket: Socket, service: string): void {
  const hits = new Map<string, { n: number; resetAt: number }>();
  socket.use((packet, next) => {
    const [event, ...args] = packet as [string, ...unknown[]];
    const rule = EVENT_LIMITS.find((r) => r.match.test(event))!;
    const key = `${rule.match.source}`;
    const now = Date.now();
    const cur = hits.get(key);
    if (!cur || cur.resetAt <= now) {
      hits.set(key, { n: 1, resetAt: now + rule.windowMs });
      return next();
    }
    cur.n += 1;
    if (cur.n <= rule.limit) return next();
    if (!rule.silent) {
      if (cur.n === rule.limit + 1) console.warn(`[${service}] socket ${socket.id} over the '${event}' limit`);
      const ack = args[args.length - 1];
      if (typeof ack === 'function') {
        try { (ack as (r: unknown) => void)({ ok: false, error: 'You are doing that too quickly. Please slow down.' }); } catch { /* gone */ }
      }
    }
    // Dropped: not passed to the handler, and not an error the client must handle.
  });
}

export function hardenSocket<S extends Socket>(socket: S, service = 'realtime'): S {
  limitEvents(socket, service);
  const on = socket.on.bind(socket) as (ev: string, fn: (...args: unknown[]) => unknown) => S;
  const report = (event: string, err: unknown, args: unknown[]) => {
    console.error(`[${service}] handler '${event}' failed for socket ${socket.id}:`, err);
    const ack = args[args.length - 1];
    if (typeof ack === 'function') {
      try { (ack as (r: unknown) => void)({ ok: false, error: 'Something went wrong. Please try again.' }); } catch { /* client gone */ }
    }
  };
  (socket as unknown as { on: typeof on }).on = (event: string, fn: (...args: unknown[]) => unknown) =>
    on(event, (...args: unknown[]) => {
      try {
        const out = fn(...args);
        if (out && typeof (out as Promise<unknown>).then === 'function') {
          (out as Promise<unknown>).then(undefined, (err) => report(event, err, args));
        }
      } catch (err) {
        report(event, err, args);
      }
    });
  return socket;
}

/** See apps/api/src/utils/asyncErrors.ts — the same last-resort guards. */
export function installProcessGuards(service: string): void {
  process.on('unhandledRejection', (reason) => {
    console.error(`[${service}] unhandled rejection (kept running):`, reason);
  });
  process.on('uncaughtException', (err) => {
    console.error(`[${service}] uncaught exception — exiting for a clean restart:`, err);
    process.exit(1);
  });
}
