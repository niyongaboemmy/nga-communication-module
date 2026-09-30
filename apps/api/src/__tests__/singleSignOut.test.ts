import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';
import { LOGOUT_EVENT, setJwksFetcher } from '../utils/ssoLogout.js';

/**
 * Single sign-out (nga_central_mis/docs/SINGLE_SIGN_OUT.md): signing out of
 * NGA MIS makes MIS POST a signed logout_token here; every Tupo session of
 * that person issued before then must stop working.
 */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256', use: 'sig' };

const logoutToken = (sub: string, claims: Record<string, unknown> = {}, key: crypto.KeyObject = privateKey) =>
  jwt.sign(
    {
      iss: config.misBaseUrl.replace(/\/$/, ''), aud: config.ssoClientId, jti: crypto.randomUUID(),
      sub, events: { [LOGOUT_EVENT]: {} }, ...claims,
    },
    key,
    { algorithm: 'RS256', keyid: 'k1', expiresIn: 120 },
  );

const backchannel = (body: Record<string, string>) =>
  request(app).post('/api/sso/backchannel-logout').type('form').send(body);

let userId: string;
const misUserId = String(Date.now() % 1_000_000_000);
const session = (iatSecondsAgo = 0) =>
  jwt.sign(
    {
      id: userId, misUserId, name: 'Aline', email: `${userId}@amashuri.com`, role: 'staff',
      iat: Math.floor(Date.now() / 1000) - iatSecondsAgo,
    },
    config.jwtSecret,
    { expiresIn: '1h' },
  );
const probe = (token: string) => request(app).get('/api/notifications').set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  setJwksFetcher(async () => ({ keys: [jwk as never] }));
  userId = snowflake();
  await getPool().query(
    `INSERT INTO users (id, mis_user_id, name, email, role) VALUES ($1, $2, 'Aline', $3, 'staff')`,
    [userId, misUserId, `${userId}@amashuri.com`],
  );
});

afterAll(async () => {
  setJwksFetcher(null);
  await getPool().query('DELETE FROM users WHERE id = $1', [userId]);
  await closeDb();
});

describe('POST /api/sso/backchannel-logout', () => {
  it('ends every session issued before the MIS sign-out', async () => {
    const before = session(60);
    expect((await probe(before)).status).not.toBe(401);

    const res = await backchannel({ logout_token: logoutToken(misUserId) });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');

    const after = await probe(before);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('SESSION_ENDED');
  });

  it('a new sign-in afterwards works', async () => {
    await new Promise((r) => setTimeout(r, 1100));
    expect((await probe(session(0))).status).not.toBe(401);
  });

  it('rejects forged, wrong-audience, replayed and missing tokens', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect((await backchannel({ logout_token: logoutToken(misUserId, {}, other) })).status).toBe(400);
    expect((await backchannel({ logout_token: logoutToken(misUserId, { aud: 'taskmentor_app' }) })).status).toBe(400);
    const once = logoutToken(misUserId);
    expect((await backchannel({ logout_token: once })).status).toBe(200);
    expect((await backchannel({ logout_token: once })).status).toBe(400);
    expect((await backchannel({})).status).toBe(400);
  });

  it('accepts a sign-out for someone who never opened Tupo', async () => {
    expect((await backchannel({ logout_token: logoutToken('77777777') })).status).toBe(200);
  });
});
