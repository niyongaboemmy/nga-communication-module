import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, snowflake } from '@tupo/db';
import { __resetFallbacks, localFallbackCounts } from '@tupo/tenancy';
import { app } from '../app.js';
import { config } from '../config.js';
import { LOGOUT_EVENT, setJwksFetcher } from '../utils/ssoLogout.js';
import { __resetSchoolCaches } from '../routes/sso.js';

/**
 * One person, several schools (TENANT_SWITCHING_PLAN.md §4.2, Appendix A):
 * verify-mis answers SCHOOL_CHANGED, a sid-scoped back-channel logout ends one
 * browser session only, and the header/switch-school proxies fail open.
 */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256', use: 'sig' };

const logoutToken = (sub: string, claims: Record<string, unknown> = {}) =>
  jwt.sign(
    { iss: config.misBaseUrl.replace(/\/$/, ''), aud: config.ssoClientId, jti: crypto.randomUUID(), sub, events: { [LOGOUT_EVENT]: {} }, ...claims },
    privateKey, { algorithm: 'RS256', keyid: 'k1', expiresIn: 120 },
  );
const backchannel = (token: string) => request(app).post('/api/sso/backchannel-logout').type('form').send({ logout_token: token });

const SID_A = 'sidAAAAAAAAAA';
const SID_B = 'sidBBBBBBBBBB';
let userId: string;
const misUserId = String(800_000_000 + (Date.now() % 100_000_000));

/** A Tupo session whose nested MIS token carries `sid` (or none). */
const session = (sid: string | null, iatSecondsAgo = 30) => jwt.sign(
  {
    id: userId, misUserId, name: 'Aline', email: `${userId}@amashuri.com`, role: 'staff', tid: 1,
    misToken: jwt.sign({ sub: misUserId, tid: 1, ...(sid ? { sid } : {}) }, 'mis-secret'),
    iat: Math.floor(Date.now() / 1000) - iatSecondsAgo,
  },
  config.jwtSecret, { expiresIn: '1h' },
);
const probe = (token: string) => request(app).get('/api/notifications').set('Authorization', `Bearer ${token}`);

const realFetch = globalThis.fetch;
/** Stub MIS: `routes` maps a path prefix to [status, body]. Anything else goes to the real fetch. */
function stubMis(routes: Record<string, [number, unknown]>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(config.misBaseUrl)) {
      const path = url.slice(config.misBaseUrl.length);
      calls.push(path);
      for (const [prefix, [status, body]] of Object.entries(routes)) {
        if (path.startsWith(prefix)) return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }
    return realFetch(input as never, init);
  }));
  return calls;
}

beforeAll(async () => {
  setJwksFetcher(async () => ({ keys: [jwk as never] }));
  userId = snowflake();
  await getPool().query(
    `INSERT INTO users (id, mis_user_id, name, email, role) VALUES ($1, $2, 'Aline', $3, 'staff')`,
    [userId, misUserId, `${userId}@amashuri.com`],
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSchoolCaches();
});

afterAll(async () => {
  setJwksFetcher(null);
  await getPool().query('DELETE FROM users WHERE id = $1', [userId]);
  await closeDb();
});

describe('verify-mis: SCHOOL_CHANGED', () => {
  it('answers 409 when the shared nga_school cookie names another school (no MIS call)', async () => {
    const calls = stubMis({ '/auth/verify': [200, { success: true, data: { userId: Number(misUserId) } }] });
    const res = await request(app).get('/api/sso/verify-mis')
      .set('Authorization', `Bearer ${session(SID_A)}`)
      .set('Cookie', `other=1; nga_school=2.${SID_A}`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SCHOOL_CHANGED', tid: 2 });
    expect(calls).toEqual([]);
  });

  it('answers 409 when MIS says the session is in another school now (currentTid)', async () => {
    stubMis({ '/auth/verify': [200, { success: true, data: { userId: Number(misUserId), currentTid: 2, tenant: { tid: 1 } } }] });
    const res = await request(app).get('/api/sso/verify-mis').set('Authorization', `Bearer ${session(SID_A)}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SCHOOL_CHANGED');
  });

  it('stays valid for the same school, a missing cookie and an older MIS', async () => {
    stubMis({ '/auth/verify': [200, { success: true, data: { userId: Number(misUserId), tenant: { tid: 1 } } }] });
    const same = await request(app).get('/api/sso/verify-mis')
      .set('Authorization', `Bearer ${session(SID_A)}`).set('Cookie', `nga_school=1.${SID_A}`);
    expect(same.status).toBe(200);
    stubMis({ '/auth/verify': [200, { success: true, data: { userId: Number(misUserId) } }] });
    const old = await request(app).get('/api/sso/verify-mis')
      .set('Authorization', `Bearer ${session(SID_A)}`).set('Cookie', 'nga_school=garbage');
    expect(old.status).toBe(200);
  });
});

describe('back-channel logout with sid (contract A.3)', () => {
  it('ends only that browser session and sessions without a sid; other devices stay signed in', async () => {
    const a = session(SID_A);
    const b = session(SID_B);
    const none = session(null);
    for (const t of [a, b, none]) expect((await probe(t)).status).toBe(200);

    // Push subscriptions: one made in each browser session, one from before sids.
    await getPool().query(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, mis_sid) VALUES
         ($1, $4, 'https://push.test/a', 'k', 'a', $5), ($2, $4, 'https://push.test/b', 'k', 'a', $6), ($3, $4, 'https://push.test/n', 'k', 'a', NULL)`,
      [snowflake(), snowflake(), snowflake(), userId, SID_A, SID_B],
    );

    expect((await backchannel(logoutToken(misUserId, { tid: 1, sid: SID_A }))).status).toBe(200);

    const ra = await probe(a);
    expect(ra.status).toBe(401);
    expect(ra.body.code).toBe('SESSION_ENDED');
    expect((await probe(none)).status).toBe(401);
    expect((await probe(b)).status).toBe(200);

    await new Promise((r) => setTimeout(r, 200)); // subscription removal runs in the background
    const { rows } = await getPool().query<{ endpoint: string }>(
      'SELECT endpoint FROM push_subscriptions WHERE user_id = $1 ORDER BY endpoint', [userId]);
    expect(rows.map((r) => r.endpoint)).toEqual(['https://push.test/b']);

    // A new sign-in in the same browser session afterwards works.
    await new Promise((r) => setTimeout(r, 1100));
    expect((await probe(session(SID_A, 0))).status).toBe(200);
  });

  it('without sid, every session of the person in that school ends, as before', async () => {
    const b = session(SID_B);
    expect((await probe(b)).status).toBe(200);
    expect((await backchannel(logoutToken(misUserId, { tid: 1 }))).status).toBe(200);
    expect((await probe(b)).status).toBe(401);
  });

  it('a logout without tid is counted as a payload_no_tid fallback', async () => {
    __resetFallbacks();
    expect((await backchannel(logoutToken('55555555'))).status).toBe(200);
    expect(localFallbackCounts().counts.payload_no_tid).toBe(1);
  });
});

describe('header school and "Switch school"', () => {
  const fresh = () => session(SID_B, 0);

  it('lists the person\'s schools and offers switching from two', async () => {
    await new Promise((r) => setTimeout(r, 1100)); // after the logouts above
    stubMis({
      '/auth/my-schools': [200, { success: true, data: { schools: [
        { tid: 1, slug: 'nga', name: 'NGA', logoUrl: 'https://mis.test/l1.png', status: 'ACTIVE', current: true, roles: ['TEACHER'] },
        { tid: 2, slug: 'nga2', name: 'New Generation Academy', logoUrl: null, status: 'ACTIVE', current: false, roles: [] },
      ] } }],
    });
    const res = await request(app).get('/api/sso/my-schools').set('Authorization', `Bearer ${fresh()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.canSwitch).toBe(true);
    expect(res.body.data.schools.map((s: { tid: number }) => s.tid)).toEqual([1, 2]);
  });

  it('an MIS 401 (stale MIS token) or a missing endpoint hides the item, never signs out', async () => {
    stubMis({ '/auth/my-schools': [401, { success: false }] });
    const res = await request(app).get('/api/sso/my-schools').set('Authorization', `Bearer ${fresh()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ schools: [], canSwitch: false });
  });

  it('names the current school from MIS branding, falling back to the registry name', async () => {
    stubMis({ '/tenant/branding': [200, { success: true, data: { tid: 1, name: 'NGA', school_name: 'NGA Coding Academy', logoUrl: 'https://mis.test/logo.png' } }] });
    const res = await request(app).get('/api/sso/school').set('Authorization', `Bearer ${fresh()}`);
    expect(res.body.data).toMatchObject({ tid: 1, name: 'NGA Coding Academy', logoUrl: 'https://mis.test/logo.png' });
    __resetSchoolCaches();
    stubMis({});
    const down = await request(app).get('/api/sso/school').set('Authorization', `Bearer ${fresh()}`);
    expect(down.body.data).toMatchObject({ tid: 1, logoUrl: null });
    expect(typeof down.body.data.name).toBe('string');
  });
});
