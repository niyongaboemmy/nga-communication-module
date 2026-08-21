import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';

/**
 * A signed-in user. `misToken` is what the theme routes need to reach the MIS
 * on the caller's behalf — omit it to model a session minted before the MIS
 * token was nested in, which must still work locally.
 */
async function signedInUser(opts: { misToken?: string | null; theme?: 'light' | 'dark' } = {}) {
  const pool = getPool();
  const id = snowflake();
  const roleId = (await pool.query<{ id: number }>(
    "SELECT id FROM roles WHERE name = 'Staff'"
  )).rows[0]?.id ?? null;

  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id, preferred_theme)
     VALUES ($1, $1, 'Theme Tester', $2, 'staff', $3, $4)`,
    [id, `${id}@amashuri.com`, roleId, opts.theme ?? null]
  );

  const claims: Record<string, unknown> = {
    id, misUserId: id, name: 'Theme Tester', email: `${id}@amashuri.com`, role: 'staff',
  };
  if (opts.misToken !== null) claims.misToken = opts.misToken ?? 'mis-token-abc';

  return { id, token: jwt.sign(claims, config.jwtSecret, { expiresIn: '10m' }) };
}

/** A MIS that answers the two endpoints these routes use. */
function mockMis(opts: { theme?: 'light' | 'dark'; patchStatus?: number; unreachable?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    if (opts.unreachable) throw new Error('ECONNREFUSED');

    if (url.endsWith('/users/me/theme')) {
      return new Response(
        JSON.stringify({ success: true, message: 'Theme preference updated successfully' }),
        { status: opts.patchStatus ?? 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.endsWith('/users/me')) {
      return new Response(JSON.stringify({
        success: true,
        data: { user: { user_id: 991, preferred_theme: opts.theme ?? 'dark' }, profile: {} },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  }));
  return calls;
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  await getPool().query('DELETE FROM audit_log');
  await getPool().query('DELETE FROM users');
  await seedRbac(getPool());
});

afterAll(async () => { await closeDb(); });

describe('PATCH /api/users/me/theme', () => {
  it('saves the choice locally and pushes it to the MIS', async () => {
    const calls = mockMis();
    const { id, token } = await signedInUser({ theme: 'light' });

    const res = await request(app)
      .patch('/api/users/me/theme')
      .set('Authorization', `Bearer ${token}`)
      .send({ theme: 'dark' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ theme: 'dark', misSynced: true });

    const { rows } = await getPool().query('SELECT preferred_theme FROM users WHERE id = $1', [id]);
    expect(rows[0].preferred_theme).toBe('dark');

    const push = calls.find((c) => c.method === 'PATCH');
    expect(push?.url).toContain('/users/me/theme');
    expect(push?.body).toEqual({ theme: 'dark' });
  });

  it('still saves locally when the MIS is unreachable, and says so', async () => {
    mockMis({ unreachable: true });
    const { id, token } = await signedInUser({ theme: 'light' });

    const res = await request(app)
      .patch('/api/users/me/theme')
      .set('Authorization', `Bearer ${token}`)
      .send({ theme: 'dark' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ theme: 'dark', misSynced: false });
    const { rows } = await getPool().query('SELECT preferred_theme FROM users WHERE id = $1', [id]);
    expect(rows[0].preferred_theme).toBe('dark');
  });

  it('rejects anything that is not light or dark', async () => {
    mockMis();
    const { token } = await signedInUser();
    const res = await request(app)
      .patch('/api/users/me/theme')
      .set('Authorization', `Bearer ${token}`)
      .send({ theme: 'neon' });
    expect(res.status).toBe(400);
  });

  it('requires a session', async () => {
    const res = await request(app).patch('/api/users/me/theme').send({ theme: 'dark' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/users/me/theme', () => {
  it('reports the MIS value and adopts it locally', async () => {
    mockMis({ theme: 'dark' });
    const { id, token } = await signedInUser({ theme: 'light' });

    const res = await request(app).get('/api/users/me/theme').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ theme: 'dark', source: 'mis' });
    const { rows } = await getPool().query('SELECT preferred_theme FROM users WHERE id = $1', [id]);
    expect(rows[0].preferred_theme).toBe('dark');
  });

  it('falls back to the stored copy rather than flipping the UI when the MIS is down', async () => {
    mockMis({ unreachable: true });
    const { token } = await signedInUser({ theme: 'dark' });

    const res = await request(app).get('/api/users/me/theme').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ theme: 'dark', source: 'local' });
  });

  it('defaults to light for a user who has never chosen', async () => {
    mockMis({ unreachable: true });
    const { token } = await signedInUser();
    const res = await request(app).get('/api/users/me/theme').set('Authorization', `Bearer ${token}`);
    expect(res.body.data.theme).toBe('light');
  });
});
