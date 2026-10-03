import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { openrouterProvider, freeModels, isFreeModel } from '../services/aiProviders/openrouterProvider.js';
import { isQuotaError } from '../services/aiProviders/errors.js';

// A local stand-in for OpenRouter, so the free-only guard is tested without network or quota.
const schema = { type: 'object' as const, properties: { ok: { type: 'boolean' as const } }, required: ['ok'] };
let reply: (body: any) => { status: number; json: any };
let lastBody: any;
let lastHeaders: http.IncomingHttpHeaders;
let server: http.Server;
const saved = { ...process.env };

const ok = (model: string, content: string, cost = 0) => ({
  status: 200,
  json: { id: 'x', object: 'chat.completion', model, usage: { cost }, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] },
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastBody = JSON.parse(raw);
      lastHeaders = req.headers;
      const r = reply(lastBody);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  // The SDK client is created on first use, so these must be set before any call.
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  process.env = saved;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  delete process.env.OPENROUTER_MODELS;
});

describe('OpenRouter provider: free models only', () => {
  it('accepts only :free ids and the openrouter/free router', () => {
    expect(isFreeModel('meta-llama/llama-3.3-70b-instruct:free')).toBe(true);
    expect(isFreeModel('openrouter/free')).toBe(true);
    expect(isFreeModel('google/gemini-2.5-flash')).toBe(false);
    expect(isFreeModel('openrouter/auto')).toBe(false);
  });

  it('drops paid ids from OPENROUTER_MODELS, caps the list at 3 and falls back to the defaults', () => {
    process.env.OPENROUTER_MODELS = 'google/gemini-2.5-flash, a/one:free ,b/two:free,openrouter/free,c/three:free';
    expect(freeModels()).toEqual(['a/one:free', 'b/two:free', 'openrouter/free']);
    process.env.OPENROUTER_MODELS = 'google/gemini-2.5-flash,openai/gpt-4o';
    expect(freeModels()).toEqual(['nvidia/nemotron-3-super-120b-a12b:free', 'openrouter/free']);
  });

  it('sends the free list as the models fallback array in json_object mode', async () => {
    process.env.OPENROUTER_MODELS = 'a/one:free,google/gemini-2.5-flash,b/two:free';
    reply = () => ok('b/two:free', '{"ok":true}');
    await expect(openrouterProvider.generateJSON({ prompt: 'hi', schema, maxOutputTokens: 500 } as any)).resolves.toEqual({ ok: true });
    expect(lastBody.model).toBe('a/one:free');
    expect(lastBody.models).toEqual(['a/one:free', 'b/two:free']);
    expect(lastBody.response_format).toEqual({ type: 'json_object' });
    expect(lastBody.max_tokens).toBe(500);
    expect(lastHeaders['x-title']).toBeTruthy();
  });

  it('discards a reply served by a non-free model or with a cost', async () => {
    reply = () => ok('google/gemini-2.5-flash', '{"ok":true}');
    await expect(openrouterProvider.generateJSON({ prompt: 'hi', schema } as any)).rejects.toThrow(/non-free/);
    reply = () => ok('a/one:free', '{"ok":true}', 0.0001);
    await expect(openrouterProvider.generateJSON({ prompt: 'hi', schema } as any)).rejects.toThrow(/non-free/);
  });

  it('rejects a reply that does not match the schema', async () => {
    reply = () => ok('a/one:free', '{"nope":1}');
    await expect(openrouterProvider.generateJSON({ prompt: 'hi', schema } as any)).rejects.toThrow(/schema/);
  });

  it('treats the free-tier limit (HTTP 429) and a 200-with-error 429 as quota errors', async () => {
    reply = () => ({ status: 429, json: { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } } });
    const httpErr = await openrouterProvider.generateJSON({ prompt: 'hi', schema } as any).catch((e: any) => e);
    expect(isQuotaError(httpErr)).toBe(true);

    reply = () => ({ status: 200, json: { model: 'a/one:free', error: { code: 429, message: 'upstream rate-limited' }, choices: [] } });
    const bodyErr = await openrouterProvider.generateJSON({ prompt: 'hi', schema } as any).catch((e: any) => e);
    expect(bodyErr.status).toBe(429);
    expect(isQuotaError(bodyErr)).toBe(true);
  });
});
