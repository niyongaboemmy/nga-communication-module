import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@tupo/shared';
import { SESSION_KEY } from './api';

/**
 * The application socket — one connection for the whole app.
 *
 * Chat, presence and notifications all ride the default namespace, so opening a
 * second socket per feature would mean two handshakes, two heartbeats and two
 * reconnect storms for information that arrives on one wire anyway. Meet is the
 * exception and keeps its own namespace, because a call's traffic has nothing
 * to do with a sidebar badge.
 *
 * It is a module singleton rather than React state on purpose: the connection
 * must outlive any one component, survive a route change, and not be torn down
 * because a provider re-rendered.
 */

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Origin the realtime gateway is reached on.
 *
 * Empty means same-origin, which is what the Vite dev server proxies and what a
 * single-host deployment uses. Production points this at the gateway's own
 * subdomain instead, so WebSocket traffic never shares an nginx server block
 * with the SPA and the REST API.
 *
 * Cross-origin is safe here because the handshake authenticates with a bearer
 * token in `auth`, not a cookie — there is no SameSite behaviour to preserve.
 * The gateway must list this app's origin in CORS_ORIGINS.
 */
export function socketOrigin(): string {
  return import.meta.env.VITE_SOCKET_URL ?? '';
}

/** Build a namespace URL that works both same-origin and cross-origin. */
export function socketUrl(namespace: string): string {
  const base = socketOrigin().replace(/\/$/, '');
  return base ? `${base}${namespace}` : namespace;
}

let socket: AppSocket | null = null;
let currentToken: string | null = null;

/**
 * Get the shared socket, connecting on first use.
 *
 * Returns null when there is no session — a socket with no credential would be
 * rejected at the handshake, and retrying that in a loop is how you get a
 * console full of red on the sign-in page.
 */
export function getSocket(): AppSocket | null {
  const token = localStorage.getItem(SESSION_KEY);
  if (!token) {
    disconnectSocket();
    return null;
  }

  // A new session means a new identity. Reusing a socket authenticated as the
  // previous user would keep them in that person's rooms.
  if (socket && currentToken !== token) disconnectSocket();

  if (!socket) {
    currentToken = token;
    socket = io(socketUrl('/'), {
      auth: { token },
      // Polling stays as a fallback: some school and mobile networks block
      // WebSocket upgrades outright.
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      // Capped so a long outage does not leave the app waiting minutes to
      // notice the network came back.
      reconnectionDelayMax: 5_000,
      timeout: 10_000,
    });
  }
  return socket;
}

export function disconnectSocket(): void {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  currentToken = null;
}

/**
 * Subscribe to a socket event for the lifetime of a React effect.
 *
 * Returns the cleanup function directly, so a caller cannot forget to remove
 * the listener — the commonest way a chat client ends up handling the same
 * message four times after a few route changes.
 */
export function onSocket<E extends keyof ServerToClientEvents>(
  event: E, handler: ServerToClientEvents[E],
): () => void {
  const s = getSocket();
  if (!s) return () => {};
  s.on(event, handler as never);
  return () => { s.off(event, handler as never); };
}
