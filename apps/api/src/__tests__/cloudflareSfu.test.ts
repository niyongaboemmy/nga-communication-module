import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config } from '../config.js';
import * as sfu from '../services/cloudflareSfuService.js';

/**
 * The Cloudflare Realtime protocol layer, against a stubbed Cloudflare.
 *
 * The credentials for a real SFU app are a deployment concern, so this suite
 * exercises the part that is ours: the URLs, the headers, the request shapes,
 * and — most importantly — the error handling. Cloudflare reports per-request
 * failures inside a **200 response** with an `errorCode` field, which is
 * exactly the kind of thing that turns into a silent failure if nobody checks
 * for it.
 */

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }>;

function stubCloudflare(response: unknown, status = 200) {
  calls = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(response), {
      status, headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  Object.assign(config, {
    cloudflareRealtimeAppId: 'app-123',
    cloudflareRealtimeAppSecret: 'secret-abc',
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(config, { cloudflareRealtimeAppId: '', cloudflareRealtimeAppSecret: '' });
  vi.restoreAllMocks();
});

describe('configuration', () => {
  it('is configured only when both values are present', () => {
    expect(sfu.isCloudflareSfuConfigured()).toBe(true);
    Object.assign(config, { cloudflareRealtimeAppSecret: '' });
    expect(sfu.isCloudflareSfuConfigured()).toBe(false);
  });

  it('refuses to call out at all when unconfigured', async () => {
    Object.assign(config, { cloudflareRealtimeAppId: '', cloudflareRealtimeAppSecret: '' });
    stubCloudflare({});
    await expect(sfu.createSession()).rejects.toThrow(/not configured/i);
    // Not merely rejected — no request was made, so a misconfigured deployment
    // cannot produce traffic against somebody else's app id.
    expect(calls).toHaveLength(0);
  });
});

describe('sessions', () => {
  it('posts to the app and authenticates with the secret', async () => {
    stubCloudflare({ sessionId: 'sess-1' });
    const result = await sfu.createSession();

    expect(result.sessionId).toBe('sess-1');
    expect(calls[0]!.url).toBe('https://rtc.live.cloudflare.com/v1/apps/app-123/sessions/new');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-abc');
  });

  it('passes a correlation id so a session is traceable from the dashboard', async () => {
    stubCloudflare({ sessionId: 'sess-1' });
    await sfu.createSession('abc-defg-hij:12345');
    expect(calls[0]!.url).toContain('correlationId=abc-defg-hij%3A12345');
  });

  it('truncates an over-long correlation id rather than sending it', async () => {
    stubCloudflare({ sessionId: 'sess-1' });
    await sfu.createSession('x'.repeat(500));
    const value = new URL(calls[0]!.url).searchParams.get('correlationId')!;
    expect(value.length).toBeLessThanOrEqual(64);
  });
});

describe('tracks', () => {
  it('sends a publish exactly as the API expects', async () => {
    stubCloudflare({
      sessionDescription: { sdp: 'v=0', type: 'answer' },
      tracks: [{ trackName: 'cam-1', mid: '1' }],
    });

    const result = await sfu.addTracks('sess-1', {
      sessionDescription: { sdp: 'v=0\r\n', type: 'offer' },
      tracks: [{ location: 'local', mid: '1', trackName: 'cam-1' }],
    });

    expect(calls[0]!.url).toContain('/sessions/sess-1/tracks/new');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.tracks[0]).toEqual({ location: 'local', mid: '1', trackName: 'cam-1' });
    expect(body.sessionDescription.type).toBe('offer');
    expect(result.sessionDescription?.type).toBe('answer');
  });

  it('carries the renegotiation flag through for a subscribe', async () => {
    stubCloudflare({
      requiresImmediateRenegotiation: true,
      sessionDescription: { sdp: 'v=0', type: 'offer' },
      tracks: [{ sessionId: 'sess-2', trackName: 'cam-2', mid: '7' }],
    });

    const result = await sfu.addTracks('sess-1', {
      tracks: [{ location: 'remote', sessionId: 'sess-2', trackName: 'cam-2' }],
    });

    // Missing this is how a subscription silently produces no media: the SFU
    // hands back an offer and waits for an answer that never comes.
    expect(result.requiresImmediateRenegotiation).toBe(true);
    expect(result.tracks?.[0]?.mid).toBe('7');
  });

  it('closes tracks with force, for an unsubscribe that need not renegotiate', async () => {
    stubCloudflare({ tracks: [{ mid: '7' }] });
    await sfu.closeTracks('sess-1', { tracks: [{ mid: '7' }], force: true });

    expect(calls[0]!.url).toContain('/sessions/sess-1/tracks/close');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]!.init.body)).force).toBe(true);
  });

  it('renegotiates with an answer', async () => {
    stubCloudflare({});
    await sfu.renegotiate('sess-1', { sdp: 'v=0', type: 'answer' });
    expect(calls[0]!.url).toContain('/sessions/sess-1/renegotiate');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]!.init.body)).sessionDescription.type).toBe('answer');
  });
});

describe('errors', () => {
  it('treats an errorCode inside a 200 as a failure', async () => {
    // Cloudflare reports per-request failures this way. Reading the body as a
    // success is precisely how a broken call becomes a silent one.
    stubCloudflare({ errorCode: 'invalid_track', errorDescription: 'No such track' });
    await expect(sfu.addTracks('sess-1', { tracks: [{ location: 'local' }] }))
      .rejects.toThrow('No such track');
  });

  it('surfaces Cloudflare\'s own description on an HTTP error', async () => {
    stubCloudflare({ errorCode: 'not_found', errorDescription: 'appId does not exist.' }, 404);
    await expect(sfu.createSession()).rejects.toThrow(/appId does not exist/);
  });

  it('reports a credential problem as a server-side fault, not a client one', async () => {
    stubCloudflare({ errorDescription: 'Unauthorized' }, 401);
    // A 401 from Cloudflare means *our* secret is wrong. Passing that status
    // through would tell the user to sign in again, which cannot help.
    await expect(sfu.createSession()).rejects.toMatchObject({ status: 502 });
  });

  it('does not pass an unreadable response off as success', async () => {
    calls = [];
    globalThis.fetch = vi.fn(async () =>
      new Response('<html>gateway error</html>', { status: 200 })) as typeof fetch;
    await expect(sfu.createSession()).rejects.toThrow(/unreadable/i);
  });

  it('gives up rather than holding a join open forever', async () => {
    calls = [];
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      // Behave like a request aborted by the service's own timeout.
      const error = new Error('aborted');
      error.name = 'AbortError';
      void init;
      throw error;
    }) as typeof fetch;

    await expect(sfu.createSession()).rejects.toThrow(/did not respond in time/i);
  });

  it('never puts the secret in an error message', async () => {
    stubCloudflare({ errorDescription: 'Unauthorized' }, 401);
    await sfu.createSession().catch((err: Error) => {
      expect(err.message).not.toContain('secret-abc');
    });
  });
});
