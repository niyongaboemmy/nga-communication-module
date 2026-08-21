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
 *  2. The result is cached. Cloudflare issues 24-hour credentials, so calling
 *     their API once per participant per join is pure waste — the cache is
 *     refreshed well before expiry and shared by every joiner.
 */

const STUN_ONLY: RTCIceServerLike[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const CREDENTIAL_TTL_SECONDS = 86_400;
/** Refreshed well inside the 24 h TTL so a cached credential is never near expiry. */
const CACHE_MS = 60 * 60 * 1000;

let cache: { servers: RTCIceServerLike[]; expiresAt: number } | null = null;
let inFlight: Promise<RTCIceServerLike[]> | null = null;

export function isTurnConfigured(): boolean {
  return !!(config.cloudflareTurnTokenId && config.cloudflareTurnApiToken);
}

async function fetchFromCloudflare(): Promise<RTCIceServerLike[]> {
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${config.cloudflareTurnTokenId}/credentials/generate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.cloudflareTurnApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
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
 * ICE servers for a joining client. Never throws: a TURN outage should degrade
 * a call to "works on unrestricted networks" rather than fail the join outright.
 */
export async function getIceServers(): Promise<RTCIceServerLike[]> {
  if (!isTurnConfigured()) return STUN_ONLY;
  if (cache && cache.expiresAt > Date.now()) return cache.servers;

  // Several people joining at once must not each hit the Cloudflare API.
  inFlight ??= fetchFromCloudflare()
    .then((servers) => {
      cache = { servers, expiresAt: Date.now() + CACHE_MS };
      return servers;
    })
    .catch((err) => {
      console.error('[meet] Cloudflare TURN unavailable, falling back to STUN:',
        err instanceof Error ? err.message : err);
      return STUN_ONLY;
    })
    .finally(() => { inFlight = null; });

  return inFlight;
}

/** Test seam — lets a suite assert the cache rather than wait an hour for it. */
export function resetIceCache(): void {
  cache = null;
  inFlight = null;
}

export const SUPPORTED_MEDIA_MODES = MEET_MEDIA_MODES;
