import { createRequire } from 'node:module';

/**
 * Async route safety (A-02).
 *
 * Express 4 does not look at what a handler returns, so a rejected promise
 * from an `async` handler is an unhandled rejection — and under Node 22 that
 * ends the process, taking every in-flight request with it. Patching the
 * router's Layer once routes every rejection to `next(err)`, so the central
 * error middleware answers it like any other error. This is the technique the
 * `express-async-errors` package uses; it is small enough to own.
 *
 * Imported for its side effect, first, before any router is built.
 */
const require = createRequire(import.meta.url);
type Handler = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;
interface LayerLike { handle: Handler & { length: number } }

const Layer = require('express/lib/router/layer') as {
  prototype: LayerLike & { handle_request: (req: unknown, res: unknown, next: (err?: unknown) => void) => void };
};

const original = Layer.prototype.handle_request;
if (!(original as { __tupoAsync?: boolean }).__tupoAsync) {
  const patched = function handle_request(this: LayerLike, req: unknown, res: unknown, next: (err?: unknown) => void) {
    const fn = this.handle;
    // Four-argument functions are error handlers; Express calls those itself.
    if (fn.length > 3) return original.call(this as never, req, res, next);
    try {
      const out = fn(req, res, next);
      if (out && typeof (out as Promise<unknown>).then === 'function') {
        (out as Promise<unknown>).then(undefined, (err) => next(err ?? new Error('Rejected without a reason')));
      }
    } catch (err) {
      next(err);
    }
  };
  (patched as { __tupoAsync?: boolean }).__tupoAsync = true;
  Layer.prototype.handle_request = patched as never;
}

/** The last-resort guards are shared by every service (A-02, R-05). */
export { installProcessGuards } from '@tupo/db';
