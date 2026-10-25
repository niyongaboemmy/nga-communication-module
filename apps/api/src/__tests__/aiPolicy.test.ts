import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';
import {
  getAiPolicy, tupoAiState, noteAiPolicyVersion, setAiPolicyForTests,
  __resetAiPolicyCache, __ageAiPolicy, AiDisabledError,
} from '../services/aiPolicy.js';
import { generatePlainText } from '../services/aiProviders/index.js';
import { translateMessage } from '../services/translateService.js';

/**
 * The school-wide AI switch (AI_USAGE_CONTROL_PLAN §7): the MIS policy client
 * and the provider chokepoint in front of every model call. MIS is mocked.
 */

const policyBody = (policy: Record<string, unknown>) =>
  new Response(JSON.stringify({ success: true, data: { policy } }), { status: 200 });

function stubMis(handler: () => Response | Promise<Response>) {
  const seen: Array<{ url: string; auth: string | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
    return handler();
  }));
  return seen;
}

beforeEach(() => { __resetAiPolicyCache(); });
afterEach(() => { vi.unstubAllGlobals(); __resetAiPolicyCache(); });

describe('MIS AI policy client', () => {
  it('reads /integrations/ai-policy with the SSO client credentials', async () => {
    const seen = stubMis(() => policyBody({ v: 4, enabled: true }));
    const policy = await getAiPolicy();
    expect(policy).toMatchObject({ v: 4, enabled: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${config.misBaseUrl}/integrations/ai-policy`);
    expect(seen[0]!.auth).toBe(
      `Basic ${Buffer.from(`${config.ssoClientId}:${config.ssoClientSecret}`).toString('base64')}`);
  });

  it('caches for 60 s, then refetches', async () => {
    const seen = stubMis(() => policyBody({ v: 1, enabled: true }));
    await getAiPolicy();
    await getAiPolicy();
    expect(seen).toHaveLength(1);
    __ageAiPolicy(61_000);
    await getAiPolicy();
    expect(seen).toHaveLength(2);
  });

  it('drops the cache when the verify poll reports a new ai_policy_v', async () => {
    let enabled = true;
    const seen = stubMis(() => policyBody({ v: enabled ? 1 : 2, enabled }));
    expect((await tupoAiState()).enabled).toBe(true);
    enabled = false;
    expect(noteAiPolicyVersion(1)).toBe(false);          // same version: nothing to do
    expect((await tupoAiState()).enabled).toBe(true);
    expect(noteAiPolicyVersion(2)).toBe(true);
    expect(await tupoAiState()).toEqual({
      enabled: false, reason: 'GLOBAL_OFF', message: 'AI is turned off for the school.',
    });
    expect(seen).toHaveLength(2);
    expect(noteAiPolicyVersion(null)).toBe(false);        // an older MIS sends none
  });

  it('keeps the last good copy for 15 minutes when MIS fails, then fails closed', async () => {
    let up = true;
    stubMis(() => (up ? policyBody({ v: 1, enabled: true }) : new Response('down', { status: 502 })));
    await getAiPolicy();
    up = false;
    __ageAiPolicy(14 * 60_000);
    expect((await getAiPolicy())?.enabled).toBe(true);
    __ageAiPolicy(16 * 60_000);
    expect(await getAiPolicy()).toBeNull();
    expect((await tupoAiState()).reason).toBe('GLOBAL_OFF');
  });

  it('fails closed with no copy at all when MIS is unreachable', async () => {
    stubMis(() => { throw new Error('ECONNREFUSED'); });
    expect(await getAiPolicy()).toBeNull();
    expect(await tupoAiState()).toMatchObject({ enabled: false, reason: 'GLOBAL_OFF' });
  });

  it('reports APP_OFF when only Tupo is switched off', async () => {
    setAiPolicyForTests({ v: 1, enabled: true, apps: { tupo: false } });
    expect(await tupoAiState()).toMatchObject({ enabled: false, reason: 'APP_OFF' });
    setAiPolicyForTests({ v: 1, enabled: true, apps: { mis: false } });
    expect((await tupoAiState()).enabled).toBe(true);
  });
});

describe('provider chokepoint', () => {
  it('refuses every model call with AiDisabledError when AI is off', async () => {
    setAiPolicyForTests(null);
    await expect(generatePlainText('hello')).rejects.toBeInstanceOf(AiDisabledError);
    await expect(generatePlainText('hello')).rejects.toMatchObject({
      code: 'AI_DISABLED', status: 403, reason: 'GLOBAL_OFF',
    });
  });

  it('lets the call through to the providers when AI is on', async () => {
    setAiPolicyForTests({ v: 1, enabled: true });
    // No provider keys in the test env: the refusal is "not configured", not AI_DISABLED.
    const saved = Object.fromEntries(Object.keys(process.env)
      .filter((k) => k.endsWith('_API_KEY')).map((k) => [k, process.env[k]]));
    for (const k of Object.keys(saved)) delete process.env[k];
    try {
      await expect(generatePlainText('hello')).rejects.not.toBeInstanceOf(AiDisabledError);
    } finally {
      Object.assign(process.env, saved);
    }
  });
});

describe('AI routes when the school has turned AI off', () => {
  const created: string[] = [];

  async function staff() {
    const pool = getPool();
    await seedRbac(pool);
    const id = snowflake();
    const roleId = (await pool.query<{ id: number }>("SELECT id FROM roles WHERE name = 'Staff'")).rows[0]!.id;
    await pool.query(
      `INSERT INTO users (id, mis_user_id, name, email, role, role_id)
       VALUES ($1, $1, 'Teacher', $2, 'staff', $3)`,
      [id, `${id}@amashuri.com`, roleId],
    );
    created.push(id);
    return jwt.sign(
      { id, misUserId: id, name: 'Teacher', email: `${id}@amashuri.com`, role: 'staff' },
      config.jwtSecret, { expiresIn: '10m' },
    );
  }

  afterAll(async () => {
    if (created.length) await getPool().query('DELETE FROM users WHERE id = ANY($1)', [created]).catch(() => {});
    await closeDb();
  });

  it('GET /api/ai/policy says so', async () => {
    const token = await staff();
    setAiPolicyForTests(null);
    const res = await request(app).get('/api/ai/policy')
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.data).toEqual({
      enabled: false, reason: 'GLOBAL_OFF', message: 'AI is turned off for the school.',
    });
    setAiPolicyForTests({ v: 1, enabled: true });
    const on = await request(app).get('/api/ai/policy')
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(on.body.data.enabled).toBe(true);
  });

  it('requires a session', async () => {
    await request(app).get('/api/ai/policy').expect(401);
  });

  it('a Mail AI route answers 403 AI_DISABLED', async () => {
    const token = await staff();
    setAiPolicyForTests({ v: 1, enabled: false });
    const res = await request(app).post('/api/mail/ai/subject')
      .set('Authorization', `Bearer ${token}`)
      .send({ bodyText: 'Fees are due on Friday.' }).expect(403);
    expect(res.body).toEqual({
      success: false, code: 'AI_DISABLED', reason: 'GLOBAL_OFF', message: 'AI is turned off for the school.',
    });

    const status = await request(app).get('/api/mail/ai/status')
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(status.body.data).toMatchObject({ available: false, policy: { enabled: false, reason: 'GLOBAL_OFF' } });
  });

  it('translation refuses without touching a provider', async () => {
    setAiPolicyForTests(null);
    await expect(translateMessage(snowflake(), 'Muraho', 'en')).rejects.toBeInstanceOf(AiDisabledError);
  });
});
