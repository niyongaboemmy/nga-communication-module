import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, closeDb, snowflake } from '@tupo/db';
import { profileMedia } from '@tupo/notify';

/**
 * The worker's avatars:sync: everyone's NGA photo + cover from MIS, so other people's
 * lists show a photo changed in MIS without waiting for its owner to open Tupo.
 * The MIS call is mocked; the database is real.
 */
const CFG = { misBaseUrl: 'https://mis.test', clientId: 'tupo', clientSecret: 's3cret' };
const A = (id: number, v: number) => ({
  version: v,
  sm: `https://api.amashuri.com/avatars/${id}/${v}/sm.webp?s=x`,
  md: `https://api.amashuri.com/avatars/${id}/${v}/md.webp?s=x`,
  lg: `https://api.amashuri.com/avatars/${id}/${v}/lg.webp?s=x`,
});
const C = (id: number) => ({ version: 1, md: `https://api.amashuri.com/covers/${id}/1/md.webp?s=c`, lg: `https://api.amashuri.com/covers/${id}/1/lg.webp?s=c` });

async function addUser(misUserId: string, avatarUrl: string | null = null) {
  const id = snowflake();
  await getPool().query(
    `INSERT INTO users (id, mis_user_id, name, email, avatar_url, role) VALUES ($1, $2, $3, $4, $5, 'staff')`,
    [id, misUserId, `User ${misUserId}`, `u${misUserId}@x.rw`, avatarUrl],
  );
  return id;
}
const row = async (id: string) =>
  (await getPool().query('SELECT avatar_url, cover_url FROM users WHERE id = $1', [id])).rows[0];
const misStatus = async (id: string) =>
  (await getPool().query('SELECT mis_status FROM users WHERE id = $1', [id])).rows[0].mis_status as string | null;

beforeEach(async () => {
  await getPool().query('DELETE FROM audit_log');
  await getPool().query('DELETE FROM users');
});
afterAll(async () => { await closeDb(); });

describe('profile media sync from MIS', () => {
  it('writes new photos and covers, clears removed ones, and leaves unknown people alone', async () => {
    const withNew = await addUser('101');
    const removed = await addUser('102', A(102, 5).md);
    const unknown = await addUser('103', A(103, 7).md);
    const notMis = await addUser('someone@x.rw', 'https://example.com/keep.png');

    const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
    const result = await profileMedia.runProfileMediaSync({
      config: CFG,
      transport: async (url, init) => {
        calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        return {
          status: 200,
          body: { success: true, data: { users: [
            { user_id: 101, avatar: A(101, 9), cover: C(101) },
            { user_id: 102, avatar: null, cover: null },
            // 103 is not answered for: not "no photo".
          ] } },
        };
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://mis.test/users/profile-media/lookup');
    expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('tupo:s3cret').toString('base64')}`);
    expect(calls[0]!.body.user_ids.sort()).toEqual([101, 102, 103]);

    expect(await row(withNew)).toEqual({ avatar_url: A(101, 9).md, cover_url: C(101).lg });
    expect(await row(removed)).toEqual({ avatar_url: null, cover_url: null });
    expect((await row(unknown)).avatar_url).toBe(A(103, 7).md);
    expect((await row(notMis)).avatar_url).toBe('https://example.com/keep.png');
    expect(result).toMatchObject({ checked: 2, avatarsUpdated: 2, coversUpdated: 1, errors: [] });
  });

  it('a second run with nothing new changes nothing', async () => {
    await addUser('201', A(201, 3).md);
    const transport = async () => ({ status: 200, body: { data: { users: [{ user_id: 201, avatar: A(201, 3), cover: null }] } } });
    const result = await profileMedia.runProfileMediaSync({ config: CFG, transport });
    expect(result).toMatchObject({ checked: 1, avatarsUpdated: 0, coversUpdated: 0 });
  });

  it('ignores links that are not http(s)', async () => {
    const id = await addUser('301');
    await profileMedia.runProfileMediaSync({
      config: CFG,
      transport: async () => ({ status: 200, body: { data: { users: [{ user_id: 301, avatar: { md: 'javascript:alert(1)' }, cover: null }] } } }),
    });
    expect((await row(id)).avatar_url).toBeNull();
  });

  it('keeps going when MIS refuses or is unreachable, and does nothing without credentials', async () => {
    const id = await addUser('401', A(401, 1).md);
    let r = await profileMedia.runProfileMediaSync({ config: CFG, transport: async () => ({ status: 401, body: {} }) });
    expect(r.errors[0]).toMatch(/401/);
    r = await profileMedia.runProfileMediaSync({ config: CFG, transport: async () => { throw new Error('ECONNREFUSED'); } });
    expect(r.errors[0]).toMatch(/ECONNREFUSED/);
    expect((await row(id)).avatar_url).toBe(A(401, 1).md);

    r = await profileMedia.runProfileMediaSync({ config: { ...CFG, clientSecret: '' }, transport: async () => { throw new Error('should not be called'); } });
    expect(r.skipped).toMatch(/SSO_CLIENT/);
  });

  it('asks in batches of 500', async () => {
    for (let i = 0; i < 501; i++) {
      await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role) VALUES ($1, $2, 'x', $3, 'staff')`, [snowflake(), String(1000 + i), `b${i}@x.rw`]);
    }
    const sizes: number[] = [];
    await profileMedia.runProfileMediaSync({
      config: CFG,
      transport: async (_url, init) => { sizes.push(JSON.parse(init.body).user_ids.length); return { status: 200, body: { data: { users: [] } } }; },
    });
    expect(sizes).toEqual([500, 1]);
  });

  it('records each MIS status, and an id MIS no longer returns becomes REMOVED', async () => {
    const active = await addUser('501');
    const disabled = await addUser('502');
    const gone = await addUser('503');
    const suspended = await addUser('504');
    await getPool().query(`UPDATE users SET mis_status = 'ACTIVE' WHERE id = $1`, [gone]);
    const r = await profileMedia.runProfileMediaSync({
      config: CFG,
      transport: async () => ({ status: 200, body: { data: { users: [
        { user_id: 501, avatar: null, cover: null, status: 'ACTIVE' },
        { user_id: 502, avatar: null, cover: null, status: 'INACTIVE' },
        { user_id: 504, avatar: null, cover: null, status: 'suspended' },
        // 503 is absent: deleted in MIS.
      ] } } }),
    });
    expect(await misStatus(active)).toBe('ACTIVE');
    expect(await misStatus(disabled)).toBe('INACTIVE');
    expect(await misStatus(gone)).toBe('REMOVED');
    expect(await misStatus(suspended)).toBe('SUSPENDED');
    expect(r.statusesUpdated).toBe(4);

    // Re-activated in MIS: back to ACTIVE on the next sweep.
    await profileMedia.runProfileMediaSync({
      config: CFG,
      transport: async () => ({ status: 200, body: { data: { users: [
        { user_id: 501, status: 'ACTIVE' }, { user_id: 502, status: 'ACTIVE' },
        { user_id: 503, status: 'ACTIVE' }, { user_id: 504, status: 'ACTIVE' },
      ] } } }),
    });
    for (const id of [active, disabled, gone, suspended]) expect(await misStatus(id)).toBe('ACTIVE');
  });

  it('an older MIS that sends no status leaves mis_status alone, even for absent ids', async () => {
    const answered = await addUser('601');
    const absent = await addUser('602');
    await getPool().query(`UPDATE users SET mis_status = 'INACTIVE' WHERE id = $1`, [answered]);
    const r = await profileMedia.runProfileMediaSync({
      config: CFG,
      transport: async () => ({ status: 200, body: { data: { users: [{ user_id: 601, avatar: null, cover: null }] } } }),
    });
    expect(await misStatus(answered)).toBe('INACTIVE');
    expect(await misStatus(absent)).toBeNull();
    expect(r.statusesUpdated).toBe(0);
  });

  it('can re-check just the given MIS ids', async () => {
    await addUser('701');
    const target = await addUser('702');
    const asked: number[][] = [];
    await profileMedia.runProfileMediaSync({
      config: CFG,
      misUserIds: ['702'],
      transport: async (_u, init) => {
        asked.push(JSON.parse(init.body).user_ids);
        return { status: 200, body: { data: { users: [{ user_id: 702, status: 'INACTIVE' }] } } };
      },
    });
    expect(asked).toEqual([[702]]);
    expect(await misStatus(target)).toBe('INACTIVE');
  });
});
