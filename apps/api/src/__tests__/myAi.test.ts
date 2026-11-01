import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';
import { setAiPolicyForTests, __resetAiPolicyCache, AiDisabledError } from '../services/aiPolicy.js';
import {
  withPersonalAi, postJson, getRoutes, noteAiRoutesVersion, PersonalAiError,
  __resetMyAiCache, __ageMyAiRoutes, type PersonalAiCall,
} from '../services/myAiGateway.js';

/**
 * My AI (MY_AI_GATEWAY.md): a person's own key answers through the MIS gateway;
 * every other outcome is the school AI, labelled. The MIS is mocked.
 */

const realFetch = globalThis.fetch;
const MIS = config.misBaseUrl;

const POLICY_ON = { v: 3, enabled: true, personal: { enabled: true } };

const routesBody = (author: 'personal' | 'school', extra: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    v: 10, policyV: 3, enabled: true,
    byTask: {
      author: author === 'personal'
        ? { route: 'personal', reason: 'PERSONAL', credentialId: 12, provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'My Claude', fallbackToSchool: true }
        : { route: 'school', reason: 'NO_ROUTE' },
      assist: { route: 'school', reason: 'NO_ROUTE' },
      translate: { route: 'school', reason: 'NO_ROUTE' },
    },
    choices: [{ credentialId: 12, provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'My Claude' }],
    ...extra,
  },
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Seen { url: string; method: string; headers: Headers; body: any }

/** Stub fetch for MIS URLs only; everything else (a local fake provider) goes through. */
function stubMis(handler: (url: string, body: any) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(MIS)) return realFetch(input as any, init);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body });
    return handler(url, body);
  }));
  return seen;
}

const call = (over: Partial<PersonalAiCall> = {}): PersonalAiCall =>
  ({ misUserId: '501', task: 'author', feature: 'tupo.test', ...over });

/** A run whose school branch says so, and whose personal branch is the real gateway client. */
function runner() {
  const school = vi.fn(async () => ({ data: { from: 'school' }, providerUsed: 'groq' }));
  return {
    school,
    run: {
      personal: (misUserId: string, base: any) =>
        postJson<{ from: string }>(misUserId, { ...base, prompt: 'P', schema: { type: 'object' }, schemaName: 's' }),
      school,
    },
  };
}

beforeEach(() => { __resetAiPolicyCache(); __resetMyAiCache(); });
afterEach(() => { vi.unstubAllGlobals(); __resetAiPolicyCache(); __resetMyAiCache(); });

describe('withPersonalAi', () => {
  it('200: the person’s own key answers, with the MIS id and SSO Basic auth', async () => {
    setAiPolicyForTests(POLICY_ON);
    const seen = stubMis((url) => url.endsWith('/routes')
      ? json(200, routesBody('personal'))
      : json(200, { success: true, data: { from: 'personal' }, ai: { route: 'personal', reason: 'PERSONAL', credentialId: 12, label: 'My Claude', provider: 'anthropic', model: 'claude-sonnet-5-5' } }));
    const { run, school } = runner();
    const out = await withPersonalAi(call(), run);
    expect(out).toEqual({
      data: { from: 'personal' }, providerUsed: 'anthropic',
      ai: { route: 'personal', reason: 'PERSONAL', credentialId: 12, label: 'My Claude', provider: 'anthropic', model: 'claude-sonnet-5-5' },
    });
    expect(school).not.toHaveBeenCalled();
    expect(seen.map((s) => s.url)).toEqual([`${MIS}/integrations/ai/routes`, `${MIS}/integrations/ai/gateway/json`]);
    for (const s of seen) {
      expect(s.headers.get('x-nga-on-behalf-of')).toBe('501');
      expect(s.headers.get('authorization')).toBe(
        `Basic ${Buffer.from(`${config.ssoClientId}:${config.ssoClientSecret}`).toString('base64')}`);
    }
    expect(seen[1]!.body).toEqual({
      task: 'author', feature: 'tupo.test', aiRoute: null, inAssessment: false,
      prompt: 'P', schema: { type: 'object' }, schemaName: 's',
    });
  });

  it('409 AI_USE_SCHOOL: the school AI answers, labelled with the MIS reason', async () => {
    setAiPolicyForTests(POLICY_ON);
    stubMis((url) => url.endsWith('/routes')
      ? json(200, routesBody('personal'))
      : json(409, { success: false, code: 'AI_USE_SCHOOL', reason: 'KEY_NOT_ACTIVE', skipped: { credentialId: 12 } }));
    const { run, school } = runner();
    const out = await withPersonalAi(call(), run);
    expect(school).toHaveBeenCalledOnce();
    expect(out).toEqual({
      data: { from: 'school' }, providerUsed: 'groq',
      ai: { route: 'school', reason: 'KEY_NOT_ACTIVE', skipped: { credentialId: 12 } },
    });
  });

  it('503 with fallbackAllowed: the school AI answers, naming the failed key', async () => {
    setAiPolicyForTests(POLICY_ON);
    stubMis((url) => url.endsWith('/routes')
      ? json(200, routesBody('personal'))
      : json(503, { success: false, code: 'AI_KEY_NO_CREDIT', message: 'Out of credit.', fallbackAllowed: true, label: 'My Claude' }));
    const { run } = runner();
    const out = await withPersonalAi(call(), run);
    expect(out.ai).toEqual({ route: 'school', reason: 'KEY_NOT_ACTIVE', fallbackFrom: 'AI_KEY_NO_CREDIT', label: 'My Claude' });
    expect(out.data).toEqual({ from: 'school' });
  });

  it('503 without fallback: a 503 PersonalAiError with the MIS message, and no school call', async () => {
    setAiPolicyForTests(POLICY_ON);
    stubMis((url) => url.endsWith('/routes')
      ? json(200, routesBody('personal'))
      : json(503, { success: false, code: 'AI_KEY_INVALID', message: 'Your key was rejected.', fallbackAllowed: false, label: 'My Claude' }));
    const { run, school } = runner();
    const err = await withPersonalAi(call(), run).catch((e) => e);
    expect(err).toBeInstanceOf(PersonalAiError);
    expect(err).toMatchObject({ status: 503, code: 'AI_KEY_INVALID', message: 'Your key was rejected.' });
    expect(school).not.toHaveBeenCalled();
  });

  it('403 AI_DISABLED from the gateway is the usual AiDisabledError', async () => {
    setAiPolicyForTests(POLICY_ON);
    stubMis((url) => url.endsWith('/routes')
      ? json(200, routesBody('personal'))
      : json(403, { success: false, code: 'AI_DISABLED', reason: 'APP_OFF', message: 'off' }));
    const { run } = runner();
    await expect(withPersonalAi(call(), run)).rejects.toBeInstanceOf(AiDisabledError);
  });

  it('a network failure on the gateway: the school AI, reason GATEWAY_UNAVAILABLE', async () => {
    setAiPolicyForTests(POLICY_ON);
    stubMis((url) => {
      if (url.endsWith('/routes')) return json(200, routesBody('personal'));
      throw new Error('ECONNREFUSED');
    });
    const { run, school } = runner();
    const out = await withPersonalAi(call(), run);
    expect(school).toHaveBeenCalledOnce();
    expect(out.ai).toEqual({ route: 'school', reason: 'GATEWAY_UNAVAILABLE' });
  });

  it('an unreachable routes read, or an unexpected status, is also GATEWAY_UNAVAILABLE', async () => {
    setAiPolicyForTests(POLICY_ON);
    stubMis(() => { throw new Error('ECONNREFUSED'); });
    expect((await withPersonalAi(call(), runner().run)).ai.reason).toBe('GATEWAY_UNAVAILABLE');

    __resetMyAiCache();
    stubMis((url) => url.endsWith('/routes')
      ? json(200, routesBody('personal'))
      : json(403, { success: false, code: 'AI_GATEWAY_UNKNOWN_APP' }));
    expect((await withPersonalAi(call(), runner().run)).ai.reason).toBe('GATEWAY_UNAVAILABLE');
  });

  it('policy.personal off, Tupo opted out, or a system call: zero network calls', async () => {
    const seen = stubMis(() => json(500, {}));
    setAiPolicyForTests({ v: 3, enabled: true });                 // personal defaults to off
    expect((await withPersonalAi(call(), runner().run)).ai).toEqual({ route: 'school', reason: 'PERSONAL_OFF' });
    setAiPolicyForTests({ v: 3, enabled: true, personal: { enabled: true, apps: { tupo: false } } });
    expect((await withPersonalAi(call(), runner().run)).ai).toEqual({ route: 'school', reason: 'APP_OFF' });
    setAiPolicyForTests(POLICY_ON);
    expect((await withPersonalAi(call({ system: true }), runner().run)).ai.reason).toBe('SYSTEM_CALL');
    expect((await withPersonalAi(undefined, runner().run)).ai.reason).toBe('SYSTEM_CALL');
    expect((await withPersonalAi(call({ aiRoute: 'school' }), runner().run)).ai.reason).toBe('NO_ROUTE');
    expect(seen).toHaveLength(0);
  });

  it('a task the person left on School AI never calls the gateway', async () => {
    setAiPolicyForTests(POLICY_ON);
    const seen = stubMis(() => json(200, routesBody('school')));
    const out = await withPersonalAi(call(), runner().run);
    expect(out.ai).toEqual({ route: 'school', reason: 'NO_ROUTE' });
    expect(seen.map((s) => s.url)).toEqual([`${MIS}/integrations/ai/routes`]);
  });

  it('a one-off key choice goes straight to the gateway with aiRoute passed through', async () => {
    setAiPolicyForTests(POLICY_ON);
    const seen = stubMis(() => json(200, { success: true, data: { from: 'personal' }, ai: { route: 'personal', reason: 'PERSONAL', provider: 'openai' } }));
    await withPersonalAi(call({ aiRoute: '12:gpt-5' }), runner().run);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body.aiRoute).toBe('12:gpt-5');
  });
});

describe('route map cache', () => {
  it('caches 60 s per person and drops on a new ai_routes_v or ai_policy_v', async () => {
    let v = 10;
    const seen = stubMis(() => json(200, routesBody('personal', { v })));
    await getRoutes('501');
    await getRoutes('501');
    expect(seen).toHaveLength(1);

    expect(noteAiRoutesVersion('501', 10, 3)).toBe(false);   // same versions: keep
    expect(noteAiRoutesVersion('501', null, null)).toBe(false); // an older MIS sends none
    await getRoutes('501');
    expect(seen).toHaveLength(1);

    v = 11;
    expect(noteAiRoutesVersion('501', 11, 3)).toBe(true);
    expect((await getRoutes('501'))?.v).toBe(11);
    expect(seen).toHaveLength(2);

    expect(noteAiRoutesVersion('501', 11, 4)).toBe(true);    // the policy changed
    await getRoutes('501');
    expect(seen).toHaveLength(3);

    __ageMyAiRoutes('501', 61_000);
    await getRoutes('501');
    expect(seen).toHaveLength(4);
    // Another person has their own copy.
    await getRoutes('777');
    expect(seen.at(-1)!.headers.get('x-nga-on-behalf-of')).toBe('777');
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Route level: POST /api/mail/ai/subject
 * ────────────────────────────────────────────────────────────────────────── */

describe('My AI on a Mail AI route', () => {
  const created: string[] = [];
  const savedEnv = { ...process.env };
  let server: http.Server;
  let providerPrompts: string[] = [];

  beforeAll(async () => {
    // A local stand-in for OpenRouter: the school chain's only provider here.
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        providerPrompts.push(body.messages.map((m: { content: string }) => m.content).join('\n'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion', model: 'openrouter/free', usage: { cost: 0 },
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"suggestions":["Fees due on Friday"]}' } }],
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    process.env.AI_PROVIDER_ORDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-key';
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    delete process.env.OPENROUTER_MODELS;
  });

  afterAll(async () => {
    process.env = savedEnv;
    await new Promise((resolve) => server.close(resolve));
    if (created.length) await getPool().query('DELETE FROM users WHERE id = ANY($1)', [created]).catch(() => {});
    await closeDb();
  });

  beforeEach(() => { providerPrompts = []; });

  async function staff() {
    const pool = getPool();
    await seedRbac(pool);
    const id = snowflake();
    const roleId = (await pool.query<{ id: number }>("SELECT id FROM roles WHERE name = 'Staff'")).rows[0]!.id;
    await pool.query(
      `INSERT INTO users (id, mis_user_id, name, email, role, role_id)
       VALUES ($1, $2, 'Teacher', $3, 'staff', $4)`,
      [id, `mis-${id}`, `${id}@amashuri.com`, roleId],
    );
    created.push(id);
    const token = jwt.sign(
      { id, misUserId: `mis-${id}`, name: 'Teacher', email: `${id}@amashuri.com`, role: 'staff' },
      config.jwtSecret, { expiresIn: '10m' },
    );
    return { id, misUserId: `mis-${id}`, token };
  }

  it('My AI off: the school path is unchanged, `ai` says School AI, and the MIS is never asked', async () => {
    const { token } = await staff();
    setAiPolicyForTests({ v: 1, enabled: true });
    const seen = stubMis(() => json(500, {}));
    const res = await request(app).post('/api/mail/ai/subject')
      .set('Authorization', `Bearer ${token}`)
      .send({ bodyText: 'Fees are due on Friday.' }).expect(200);
    expect(res.body.data).toEqual({
      suggestions: ['Fees due on Friday'], providerUsed: 'openrouter',
      ai: { route: 'school', reason: 'PERSONAL_OFF' },
    });
    expect(providerPrompts).toHaveLength(1);
    expect(seen).toHaveLength(0);
  });

  it('My AI on: the person’s key answers the same prompt and schema, and `ai` names it', async () => {
    const { token, misUserId } = await staff();
    setAiPolicyForTests({ v: 1, enabled: true });
    stubMis(() => json(500, {}));
    await request(app).post('/api/mail/ai/subject')
      .set('Authorization', `Bearer ${token}`).send({ bodyText: 'Fees are due on Friday.' }).expect(200);
    const schoolPrompt = providerPrompts[0]!;

    setAiPolicyForTests(POLICY_ON);
    const ai = { route: 'personal', reason: 'PERSONAL', credentialId: 12, label: 'My Claude', provider: 'anthropic', model: 'claude-sonnet-5-5' };
    const seen = stubMis((url) => url.endsWith('/routes')
      ? json(200, routesBody('personal'))
      : json(200, { success: true, data: { suggestions: ['From my key'] }, ai }));
    const res = await request(app).post('/api/mail/ai/subject')
      .set('Authorization', `Bearer ${token}`)
      .send({ bodyText: 'Fees are due on Friday.' }).expect(200);
    expect(res.body.data).toEqual({ suggestions: ['From my key'], providerUsed: 'anthropic', ai });
    expect(providerPrompts).toHaveLength(1);                    // the school chain was not called again
    const gw = seen.find((s) => s.url.endsWith('/gateway/json'))!;
    expect(gw.headers.get('x-nga-on-behalf-of')).toBe(misUserId); // the MIS id, never Tupo's
    expect(gw.body).toMatchObject({ task: 'author', feature: 'tupo.mail.subject', schemaName: 'mail_subjects', maxOutputTokens: 300 });
    expect(schoolPrompt).toContain(gw.body.prompt);              // exactly the school prompt

    // A failed key without fallback is a 503 carrying the MIS message.
    __resetMyAiCache();
    stubMis((url) => url.endsWith('/routes')
      ? json(200, routesBody('personal'))
      : json(503, { success: false, code: 'AI_KEY_INVALID', message: 'Your key was rejected.', fallbackAllowed: false }));
    const failed = await request(app).post('/api/mail/ai/subject')
      .set('Authorization', `Bearer ${token}`).send({ bodyText: 'Fees are due on Friday.' }).expect(503);
    expect(failed.body).toEqual({ success: false, code: 'AI_KEY_INVALID', message: 'Your key was rejected.' });
  });

  it('a worker host token (system) never reaches the gateway', async () => {
    const { id, misUserId } = await staff();
    setAiPolicyForTests(POLICY_ON);
    const seen = stubMis(() => json(200, routesBody('personal')));
    const token = jwt.sign(
      { id, misUserId, name: 'Teacher', email: `${id}@amashuri.com`, role: 'staff', system: true },
      config.jwtSecret, { expiresIn: '10m' },
    );
    const res = await request(app).post('/api/mail/ai/subject')
      .set('Authorization', `Bearer ${token}`).send({ bodyText: 'Fees are due on Friday.' }).expect(200);
    expect(res.body.data.ai).toEqual({ route: 'school', reason: 'SYSTEM_CALL' });
    expect(seen).toHaveLength(0);
  });

  it('GET /api/ai/my-routes: {enabled:false} while off, the cached map while on', async () => {
    const { token } = await staff();
    setAiPolicyForTests({ v: 1, enabled: true });
    const seen = stubMis(() => json(200, routesBody('personal')));
    const off = await request(app).get('/api/ai/my-routes').set('Authorization', `Bearer ${token}`).expect(200);
    expect(off.body.data).toMatchObject({ enabled: false, choices: [] });
    expect(seen).toHaveLength(0);

    setAiPolicyForTests(POLICY_ON);
    const on = await request(app).get('/api/ai/my-routes').set('Authorization', `Bearer ${token}`).expect(200);
    expect(on.body.data).toMatchObject({ enabled: true, choices: [{ credentialId: 12, label: 'My Claude' }] });
    expect(seen).toHaveLength(1);
  });
});
