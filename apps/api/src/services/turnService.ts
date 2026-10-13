import { MEET_MEDIA_MODES } from '@tupo/shared';
import type { RTCIceServerLike } from '@tupo/shared';
import { config } from '../config.js';

/**
 * ICE server provisioning.
 *
 * This is the same Cloudflare Realtime TURN integration TaskMentor's proctoring
 * module uses (`live-server/src/index.ts → GET /turn-credentials`), down to the
 * endpoint and the fallback: TURN is what makes WebRTC work on a school network
 * that blocks UDP, and a proven integration is worth more than a novel one.
 *
 * Two things differ deliberately:
 *
 *  1. Credentials are minted *per request path*, never embedded in the client
 *     bundle, and the API token stays server-side.
 *  2. Each person gets their own short-lived credential (MEET-SEC10). One
 *     shared 24-hour credential, handed to anonymous guests too, was a free
 *     relay for anyone who ever joined a public meeting. A person's
 *     credential is reused for a while so reconnects do not each call
 *     Cloudflare.
 */

const STUN_ONLY: RTCIceServerLike[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/** Long enough for a school day of calls; a guest's covers one meeting. */
const MEMBER_TTL_SECONDS = 8 * 3600;
const GUEST_TTL_SECONDS = 3 * 3600;
/** Reused well inside its TTL so a handed-out credential is never near expiry. */
const REUSE_MS = 60 * 60 * 1000;
const MAX_CACHED = 5_000;

const cache = new Map<string, { servers: RTCIceServerLike[]; expiresAt: number }>();
const inFlight = new Map<string, Promise<RTCIceServerLike[]>>();

export function isTurnConfigured(): boolean {
  return !!(config.cloudflareTurnTokenId && config.cloudflareTurnApiToken);
}

async function fetchFromCloudflare(ttl: number): Promise<RTCIceServerLike[]> {
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${config.cloudflareTurnTokenId}/credentials/generate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.cloudflareTurnApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl }),
    },
  );

  if (!res.ok) {
    throw new Error(`Cloudflare TURN API returned ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { iceServers: RTCIceServerLike | RTCIceServerLike[] };
  // Cloudflare returns a single object, not an array. The WebRTC API wants an
  // array, and handing it an object produces an opaque failure much later.
  return Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
}

/**
 * ICE servers for one person: `who` is a user id, or `guest:<participantId>`
 * for someone without an account. Never throws: a TURN outage should degrade
 * a call to "works on unrestricted networks" rather than fail the join.
 */
export async function getIceServers(who: string): Promise<RTCIceServerLike[]> {
  if (!isTurnConfigured()) return STUN_ONLY;
  const hit = cache.get(who);
  if (hit && hit.expiresAt > Date.now()) return hit.servers;

  // The same person reconnecting from two tabs must not mint twice.
  let pending = inFlight.get(who);
  if (!pending) {
    const ttl = who.startsWith('guest:') ? GUEST_TTL_SECONDS : MEMBER_TTL_SECONDS;
    pending = fetchFromCloudflare(ttl)
      .then((servers) => {
        if (cache.size >= MAX_CACHED) {
          const now = Date.now();
          for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
          if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
        }
        cache.set(who, { servers, expiresAt: Date.now() + REUSE_MS });
        return servers;
      })
      .catch((err) => {
        console.error('[meet] Cloudflare TURN unavailable, falling back to STUN:',
          err instanceof Error ? err.message : err);
        return STUN_ONLY;
      })
      .finally(() => { inFlight.delete(who); });
    inFlight.set(who, pending);
  }
  return pending;
}

/** Test seam — lets a suite assert the cache rather than wait an hour for it. */
export function resetIceCache(): void {
  cache.clear();
  inFlight.clear();
}

export const SUPPORTED_MEDIA_MODES = MEET_MEDIA_MODES;
