import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { getPool, closeDb } from '@tupo/db';
import { app } from '../app.js';
import { __resetRateLimiter } from '../routes/sso.js';

/** A MIS that behaves. */
function mockMis(overrides: { tokenStatus?: number; tokenBody?: unknown; meBody?: unknown } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/sso/token')) {
      return new Response(JSON.stringify(overrides.tokenBody ?? {
        success: true,
        data: {
          token: 'mis-token-abc',
          user: { user_id: 991, name: 'Aline Uwase', email: 'aline@amashuri.com', username: 'aline', preferred_theme: 'dark' },
          permissions: ['MARK_ATTENDANCE', 'VIEW_RESULTS'],
        },
      }), { status: overrides.tokenStatus ?? 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/users/me')) {
      return new Response(JSON.stringify(overrides.meBody ?? {
        success: true,
        data: {
          profile: { name: 'Aline Uwase', email: 'aline@amashuri.com' },
          permissions: ['MARK_ATTENDANCE', 'VIEW_RESULTS'],
          systems: [{ name: 'TaskMentor' }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  }));
}

beforeEach(async () => {
  __resetRateLimiter();
  vi.unstubAllGlobals();
  await getPool().query('DELETE FROM audit_log');
  await getPool().query('DELETE FROM users');
});

afterAll(async () => { await closeDb(); });

describe('POST /api/sso/exchange', () => {
  it('exchanges a code, creates the user and issues a Tupo session', async () => {
    mockMis();
    const res = await request(app).post('/api/sso/exchange').send({ code: 'valid-code' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.user).toMatchObject({
      misUserId: '991', name: 'Aline Uwase', email: 'aline@amashuri.com', role: 'staff',
    });
    // The MIS token must never be handed to the browser on its own.
    expect(res.body.data.user.misToken).toBeUndefined();
  });

  it("carries the MIS's appearance preference into the session", async () => {
    mockMis();
    const res = await request(app).post('/api/sso/exchange').send({ code: 'valid-code' });
    expect(res.body.data.user.preferredTheme).toBe('dark');
  });

  it("prefers the live /users/me theme over the one baked into the exchange payload", async () => {
    // The exchange says 'dark'; the hydrated profile says the user has since
    // switched to 'light' in the MIS. The live read must win.
    mockMis({
      meBody: {
        success: true,
        data: {
          user: { user_id: 991, preferred_theme: 'light' },
          profile: { name: 'Aline Uwase', email: 'aline@amashuri.com' },
          permissions: ['MARK_ATTENDANCE'],
        },
      },
    });
    const res = await request(app).post('/api/sso/exchange').send({ code: 'valid-code' });
    expect(res.body.data.user.preferredTheme).toBe('light');
  });

  it('is idempotent across repeat logins — one user row, not two', async () => {
    mockMis();
    await request(app).post('/api/sso/exchange').send({ code: 'code-1' });
    await request(app).post('/api/sso/exchange').send({ code: 'code-2' });
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM users');
    expect(rows[0].n).toBe(1);
  });

  it('writes an audit entry for the login', async () => {
    mockMis();
    await request(app).post('/api/sso/exchange').send({ code: 'valid-code' });
    const { rows } = await getPool().query("SELECT action FROM audit_log WHERE action = 'auth.login'");
    expect(rows).toHaveLength(1);
  });

  it('rejects a missing code without calling the MIS', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = await request(app).post('/api/sso/exchange').send({});
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('surfaces a MIS rejection rather than issuing a session anyway', async () => {
    mockMis({ tokenStatus: 400, tokenBody: { success: false, message: 'Invalid authorization code' } });
    const res = await request(app).post('/api/sso/exchange').send({ code: 'expired' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('Invalid authorization code');
  });

  it('returns 502 when the MIS is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const res = await request(app).post('/api/sso/exchange').send({ code: 'any' });
    expect(res.status).toBe(502);
  });

  it('still logs the user in when /users/me fails (degraded hydration)', async () => {
    mockMis({ meBody: { success: false } });
    const res = await request(app).post('/api/sso/exchange').send({ code: 'valid-code' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('staff'); // fell back to exchange permissions
  });

  it('rate-limits brute-forcing of authorization codes', async () => {
    mockMis({ tokenStatus: 400, tokenBody: { success: false, message: 'nope' } });
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await request(app).post('/api/sso/exchange').send({ code: `c${i}` })).status;
    }
    expect(last).toBe(429);
  });
});

describe('protected routes', () => {
  it('reject a request with no token', async () => {
    const res = await request(app).get('/api/sso/me');
    expect(res.status).toBe(401);
  });

  it('reject a forged token', async () => {
    const res = await request(app).get('/api/sso/me').set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
  });

  it('reject a valid token whose user no longer exists', async () => {
    mockMis();
    const login = await request(app).post('/api/sso/exchange').send({ code: 'valid-code' });
    const token = login.body.data.token;
    await getPool().query('DELETE FROM users');

    const res = await request(app).get('/api/sso/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('accept a live session and never leak the MIS token', async () => {
    mockMis();
    const login = await request(app).post('/api/sso/exchange').send({ code: 'valid-code' });
    const res = await request(app).get('/api/sso/me')
      .set('Authorization', `Bearer ${login.body.data.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.misToken).toBeUndefined();
  });
});
