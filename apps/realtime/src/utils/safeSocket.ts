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
export function hardenSocket<S extends Socket>(socket: S, service = 'realtime'): S {
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
