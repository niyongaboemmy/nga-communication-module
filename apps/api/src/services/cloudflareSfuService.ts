import { config } from '../config.js';

/**
 * Cloudflare Realtime SFU.
 *
 * This is the media server Tupo uses — the only one. It is worth being explicit
 * about why it beat the self-hosted SFUs: those are all servers you have to run
 * — a container, a UDP port range, a TURN companion and somewhere to put them.
 * Cloudflare Realtime is the same job as an API call on infrastructure that
 * already exists, with the TURN service Tupo is already using included free
 * alongside it.
 *
 * The shape of the API matters to the design. Cloudflare's SFU has **no concept
 * of a room**: it is a pub/sub of *sessions* (one PeerConnection each) and
 * *tracks*, and the application decides who subscribes to what. That is a poor
 * fit for an app with no state and an excellent fit for this one, because
 * tupo-realtime already owns the roster, the lobby and the permissions. All the
 * SFU has to do is move packets.
 *
 * **The app secret never leaves this process.** Every call the browser needs is
 * proxied through `routes/meet.ts`, which authorises it against the meeting
 * first. A client holding the secret could create sessions on the account's
 * bill and subscribe to any track in any meeting.
 *
 * API reference: https://developers.cloudflare.com/realtime/sfu/https-api/
 */

const BASE = 'https://rtc.live.cloudflare.com/v1';
/** Cloudflare is fast, but a hung request must not hold a join open. */
const TIMEOUT_MS = 12_000;

export interface SessionDescription {
  sdp: string;
  type: 'offer' | 'answer';
}

export interface TrackObject {
  location: 'local' | 'remote';
  /** Transceiver mid. May be prefixed with `#` to reference one by track name. */
  mid?: string;
  /** The publisher's session. Remote tracks only. */
  sessionId?: string;
  trackName?: string;
  kind?: 'audio' | 'video';
  bidirectionalMediaStream?: boolean;
  simulcast?: {
    preferredRid?: string;
    priorityOrdering?: 'none' | 'asciibetical';
    ridNotAvailable?: 'none' | 'asciibetical';
  };
}

export interface TracksResponse {
  requiresImmediateRenegotiation?: boolean;
  sessionDescription?: SessionDescription;
  tracks?: Array<TrackObject & { errorCode?: string; errorDescription?: string }>;
  errorCode?: string;
  errorDescription?: string;
}

export const isCloudflareSfuConfigured = (): boolean =>
  !!(config.cloudflareRealtimeAppId && config.cloudflareRealtimeAppSecret);

export class CloudflareSfuError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  if (!isCloudflareSfuConfigured()) {
    throw new CloudflareSfuError('The Cloudflare media server is not configured.', 503);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BASE}/apps/${config.cloudflareRealtimeAppId}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.cloudflareRealtimeAppSecret}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw new CloudflareSfuError(
      err instanceof Error && err.name === 'AbortError'
        ? 'The media server did not respond in time.'
        : 'Could not reach the media server.',
      504,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let body: T & { errorCode?: string; errorDescription?: string };
  try {
    body = text ? JSON.parse(text) : ({} as never);
  } catch {
    throw new CloudflareSfuError(`The media server returned an unreadable response (${res.status}).`, 502);
  }

  if (!res.ok) {
    throw new CloudflareSfuError(
      body?.errorDescription || `The media server refused the request (${res.status}).`,
      res.status === 401 || res.status === 403 ? 502 : res.status,
      body?.errorCode,
    );
  }

  // A 200 carrying an errorCode is Cloudflare's way of reporting a per-request
  // failure. Treating it as success is how a broken call becomes a silent one.
  if (body?.errorCode) {
    throw new CloudflareSfuError(
      body.errorDescription || `The media server rejected the request (${body.errorCode}).`,
      502, body.errorCode,
    );
  }

  return body;
}

/** One PeerConnection's worth of session. Created per participant, per meeting. */
export async function createSession(correlationId?: string): Promise<{ sessionId: string }> {
  const query = correlationId
    ? `?correlationId=${encodeURIComponent(correlationId.slice(0, 64))}`
    : '';
  return call<{ sessionId: string }>(`/sessions/new${query}`, { method: 'POST' });
}

/**
 * Publish or subscribe.
 *
 * Both directions are the same endpoint, distinguished by `location`. Local
 * tracks come with the client's offer and get an answer back; remote tracks
 * need no offer and return one, with `requiresImmediateRenegotiation` set —
 * which the caller must answer through `renegotiate` below.
 */
export async function addTracks(sessionId: string, body: {
  sessionDescription?: SessionDescription;
  tracks: TrackObject[];
  autoDiscover?: boolean;
}): Promise<TracksResponse> {
  return call<TracksResponse>(`/sessions/${sessionId}/tracks/new`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function renegotiate(
  sessionId: string, sessionDescription: SessionDescription,
): Promise<{ errorCode?: string }> {
  return call(`/sessions/${sessionId}/renegotiate`, {
    method: 'PUT',
    body: JSON.stringify({ sessionDescription }),
  });
}

export async function closeTracks(sessionId: string, body: {
  tracks: Array<{ mid: string }>;
  sessionDescription?: SessionDescription;
  /** Stop the data flow without renegotiating. Much cheaper when unsubscribing
   *  from someone who has simply scrolled off screen. */
  force?: boolean;
}): Promise<TracksResponse> {
  return call<TracksResponse>(`/sessions/${sessionId}/tracks/close`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export interface SessionState {
  tracks?: Array<TrackObject & { status?: 'active' | 'inactive' | 'waiting' }>;
}

/**
 * Read a session back.
 *
 * Also serves as the keep-alive: a Cloudflare session is garbage-collected
 * after 30 seconds without media, so a participant sitting muted with their
 * camera off would otherwise be dropped by the SFU while still very much in
 * the meeting.
 */
export async function getSession(sessionId: string): Promise<SessionState> {
  return call<SessionState>(`/sessions/${sessionId}`, { method: 'GET' });
}
