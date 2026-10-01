import type { Socket } from 'socket.io';
import { createActivityRelay, type ActivityRelay } from './vendor/nga-activity-relay/relay.js';
import { config } from './config.js';

/**
 * Platform usage analytics from the realtime gateway
 * (USAGE_ANALYTICS_IMPLEMENTATION_PLAN.md §5.2, §5.5).
 *
 * Chat messages are normally sent over the socket, not REST, so the API's relay
 * never sees them. This process keeps its own relay -- one per process -- used
 * only for server-side key events (`track`); browser batches still go to the
 * API's `POST /api/activity`. Needs the same three settings as the API
 * (NGA_MIS_BASE_URL, SSO_CLIENT_ID, SSO_CLIENT_SECRET) in apps/realtime/.env;
 * without any of them, it does nothing. Never on in the test run.
 */
const misBaseUrl = config.env === 'test' ? '' : process.env.NGA_MIS_BASE_URL?.trim();
const clientId = process.env.SSO_CLIENT_ID?.trim();
const clientSecret = process.env.SSO_CLIENT_SECRET?.trim();

const relay: ActivityRelay | null = misBaseUrl && clientId && clientSecret
  ? createActivityRelay({
    app: 'tupo',
    misBaseUrl,
    clientId,
    clientSecret,
    // Browser batches never reach this process; nothing here takes them.
    origins: [],
    getUserId: () => null,
  })
  : null;

if (!relay && config.env !== 'test') {
  console.warn('[activity] NGA_MIS_BASE_URL / SSO_CLIENT_ID / SSO_CLIENT_SECRET not all set: socket key events are not recorded');
}

/** A MIS user id is a positive integer; anything else is not one. */
const toMisUserId = (value: unknown): number | null => {
  const s = String(value ?? '').trim();
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

/**
 * The client's address, as Express's `trust proxy: 'loopback'` would compute
 * it: only when the peer is the local nginx is X-Forwarded-For believed, and
 * then only its last hop (the address nginx itself appended), since everything
 * before it is whatever the client chose to send.
 */
export const handshakeClientIp = (hs: Pick<Socket['handshake'], 'address' | 'headers'>): string | null => {
  const peer = hs.address || '';
  let ip = peer;
  if (LOOPBACK.test(peer)) {
    const hops = String(hs.headers['x-forwarded-for'] ?? '').split(',').map((h) => h.trim()).filter(Boolean);
    ip = hops[hops.length - 1] || peer;
  }
  return ip.replace(/^::ffff:/, '') || null;
};

/**
 * A key event raised by an authenticated socket. The device id comes from the
 * handshake: the SPA passes it in `auth.did`, and the shared `nga_did` cookie
 * rides along when the browser sends cookies.
 */
export function trackSocketEvent(
  socket: Socket, misUserId: unknown, name: string, params?: Record<string, unknown>,
): void {
  if (!relay) return;
  try {
    const hs = socket.handshake;
    const did = (hs.auth as { did?: unknown } | undefined)?.did;
    const deviceId = relay.deviceIdOf({
      headers: { 'x-nga-device': typeof did === 'string' ? did : undefined, cookie: hs.headers.cookie },
    });
    relay.track(toMisUserId(misUserId), deviceId, name, params, handshakeClientIp(hs));
  } catch {
    /* analytics never breaks a send */
  }
}

/** Forward what is still queued (shutdown). */
export const stopActivity = async (): Promise<void> => {
  await relay?.stop().catch(() => undefined);
};
