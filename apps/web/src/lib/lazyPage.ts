import React from 'react';

/**
 * Route-level code splitting (P-01).
 *
 * Every screen is its own chunk, so the first visit downloads the shell and the
 * one module the person lands on rather than all of Tupo (1.86 MB before this).
 * Two things make that safe to do in a messaging app:
 *
 * - **Preloading.** A chunk can be fetched before it is needed: on idle for the
 *   modules in the rail, and on hover or focus of a rail link. By the time the
 *   person clicks, the code is usually already there.
 * - **Deploys.** Chunk names carry a content hash. A tab opened before a deploy
 *   asks for a chunk the server no longer has, and the import fails. That is
 *   recovered with one reload (the new index.html names the new chunks),
 *   guarded so a genuinely broken chunk cannot loop.
 */

type Loader<M> = () => Promise<M>;

const RELOAD_KEY = 'tupo_chunk_reload_at';

/** A failed chunk load: reload once per minute at most, otherwise rethrow to the error boundary. */
function recover(err: unknown): never {
  let last = 0;
  try { last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0); } catch { /* storage blocked */ }
  if (Date.now() - last > 60_000) {
    try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { /* storage blocked */ }
    window.location.reload();
  }
  throw err;
}

/** A lazy component from a named export, plus a `preload()` that starts the download early. */
export function lazyNamed<M, K extends keyof M>(load: Loader<M>, name: K) {
  let pending: Promise<M> | null = null;
  const preload = () => {
    pending ??= load().catch((err) => { pending = null; throw err; });
    return pending;
  };
  const Component = React.lazy(() => preload()
    .then((m) => ({ default: m[name] as unknown as React.ComponentType<Record<string, unknown>> }))
    .catch(recover));
  return Object.assign(Component, { preload });
}

/**
 * Chunk loaders by the rail's route, so navigation code can preload a module
 * without importing it. Filled by App.tsx, which owns the lazy components.
 */
const byRoute = new Map<string, () => Promise<unknown>>();

export function registerPreload(route: string, preload: () => Promise<unknown>): void {
  byRoute.set(route, preload);
}

/** Start downloading the module behind a rail link. Cheap to call repeatedly. */
export function preloadRoute(route: string): void {
  const preload = byRoute.get(route);
  if (preload) void preload().catch(() => {});
}

/** Preload a list of routes when the browser is idle, one at a time. */
export function preloadWhenIdle(routes: string[]): void {
  const idle = (cb: () => void) => ('requestIdleCallback' in window
    ? window.requestIdleCallback(cb, { timeout: 4000 })
    : globalThis.setTimeout(cb, 1500));
  // Data savers and slow links: leave the network to what the person asked for.
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData || conn?.effectiveType === '2g' || conn?.effectiveType === 'slow-2g') return;
  const queue = [...routes];
  const next = () => {
    const route = queue.shift();
    if (!route) return;
    const preload = byRoute.get(route);
    if (!preload) { next(); return; }
    void preload().catch(() => {}).finally(() => idle(next));
  };
  idle(next);
}
