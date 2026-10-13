import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import jwt from 'jsonwebtoken';
import { app } from '../app.js';
import { config } from '../config.js';

/**
 * A-10: nobody hands out, or takes control over, more power than they hold.
 * A "Registrar" manages users and roles but holds only a slice of the catalog.
 */

const REGISTRAR_KEYS = ['USERS_MANAGE', 'ROLES_PERMISSIONS_MANAGE', 'MESSAGE_READ', 'MESSAGE_SEND'];

async function roleId(name: string) {
  return (await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [name])).rows[0]!.id;
}

async function makeRole(name: string, keys: string[]) {
  const pool = getPool();
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO roles (name, description, level, is_system) VALUES ($1, '', 'STAFF', false) RETURNING id`, [name]);
  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = ANY($2::text[])`,
    [rows[0]!.id, keys]);
  return rows[0]!.id;
}

async function user(role: number | null) {
  const id = snowflake();
  await getPool().query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1, $1, 'T', $2, 'staff', $3)`,
    [id, `${id}@amashuri.com`, role]);
  const token = jwt.sign({ id, misUserId: id, name: 'T', email: `${id}@amashuri.com`, role: 'staff' },
    config.jwtSecret, { expiresIn: '10m' });
  return { id, token, auth: `Bearer ${token}` };
}

let registrarRole: number;
beforeEach(async () => {
  await getPool().query('DELETE FROM audit_log');
  await getPool().query('DELETE FROM users');
  await getPool().query('DELETE FROM roles WHERE is_system = false');
  await seedRbac(getPool());
  registrarRole = await makeRole('Registrar', REGISTRAR_KEYS);
});
afterAll(async () => { await closeDb(); });

describe('assigning roles', () => {
  it('refuses to assign a role that grants more than the actor holds', async () => {
    const reg = await user(registrarRole);
    const target = await user(null);
    const res = await request(app).put(`/api/users/${target.id}/role`).set('Authorization', reg.auth)
      .send({ roleId: await roleId('Admin') });
    expect(res.status).toBe(403);
  });

  it('allows a role within the actor’s own permissions', async () => {
    const reg = await user(registrarRole);
    const target = await user(null);
    const small = await makeRole('Reader', ['MESSAGE_READ']);
    const res = await request(app).put(`/api/users/${target.id}/role`).set('Authorization', reg.auth)
      .send({ roleId: small });
    expect(res.status).toBe(200);
  });

  it('refuses to change the role of someone who holds more', async () => {
    const reg = await user(registrarRole);
    const admin = await user(await roleId('Admin'));
    const res = await request(app).put(`/api/users/${admin.id}/role`).set('Authorization', reg.auth)
      .send({ roleId: null });
    expect(res.status).toBe(403);
  });
});

describe('suspension', () => {
  it('refuses to suspend someone who holds more', async () => {
    const reg = await user(registrarRole);
    const admin = await user(await roleId('Admin'));
    const res = await request(app).put(`/api/users/${admin.id}/status`).set('Authorization', reg.auth)
      .send({ status: 'suspended' });
    expect(res.status).toBe(403);
  });

  it('ends the suspended person’s sessions at once', async () => {
    const admin = await user(await roleId('Admin'));
    const target = await user(await roleId('Staff'));
    expect((await request(app).get('/api/roles-permissions/me').set('Authorization', target.auth)).status).toBe(200);

    const res = await request(app).put(`/api/users/${target.id}/status`).set('Authorization', admin.auth)
      .send({ status: 'suspended' });
    expect(res.status).toBe(200);
    const { rows } = await getPool().query('SELECT 1 FROM session_revocations WHERE user_id = $1', [target.id]);
    expect(rows).toHaveLength(1);
    const after = await request(app).get('/api/roles-permissions/me').set('Authorization', target.auth);
    expect([401, 403]).toContain(after.status);
  });
});

describe('editing roles', () => {
  it('refuses to create a role with permissions the actor lacks', async () => {
    const reg = await user(registrarRole);
    const res = await request(app).post('/api/roles-permissions/roles').set('Authorization', reg.auth)
      .send({ name: 'Sneaky', level: 'STAFF', permissionKeys: ['MESSAGE_READ', 'AUDIT_VIEW'] });
    expect(res.status).toBe(403);
  });

  it('refuses to add a permission the actor lacks to an existing role', async () => {
    const reg = await user(registrarRole);
    const res = await request(app).put(`/api/roles-permissions/roles/${registrarRole}`).set('Authorization', reg.auth)
      .send({ permissionKeys: [...REGISTRAR_KEYS, 'AUDIT_VIEW'] });
    expect(res.status).toBe(403);
  });

  it('lets an actor remove permissions they do not hold themselves', async () => {
    const reg = await user(registrarRole);
    const wide = await makeRole('Wide', ['MESSAGE_READ', 'AUDIT_VIEW']);
    const res = await request(app).put(`/api/roles-permissions/roles/${wide}`).set('Authorization', reg.auth)
      .send({ permissionKeys: ['MESSAGE_READ'] });
    expect(res.status).toBe(200);
  });

  it('never lets the Admin role lose role or user management', async () => {
    const admin = await user(await roleId('Admin'));
    const id = await roleId('Admin');
    const current = await request(app).get(`/api/roles-permissions/roles/${id}`).set('Authorization', admin.auth);
    const keys = (current.body.data.permissionKeys as string[]).filter((k) => k !== 'ROLES_PERMISSIONS_MANAGE');
    const res = await request(app).put(`/api/roles-permissions/roles/${id}`).set('Authorization', admin.auth)
      .send({ permissionKeys: keys });
    expect(res.status).toBe(409);
  });

  it('never lets an actor strip management from their own role', async () => {
    const reg = await user(registrarRole);
    const res = await request(app).put(`/api/roles-permissions/roles/${registrarRole}`).set('Authorization', reg.auth)
      .send({ permissionKeys: ['ROLES_PERMISSIONS_MANAGE', 'MESSAGE_READ'] });
    expect(res.status).toBe(409);
  });

  it('records what changed in the audit log', async () => {
    const admin = await user(await roleId('Admin'));
    const id = await roleId('Staff');
    const current = await request(app).get(`/api/roles-permissions/roles/${id}`).set('Authorization', admin.auth);
    await request(app).put(`/api/roles-permissions/roles/${id}`).set('Authorization', admin.auth)
      .send({ permissionKeys: [...current.body.data.permissionKeys, 'AUDIT_VIEW'] });
    const { rows } = await getPool().query<{ metadata: { diff?: { added: string[]; removed: string[] } } }>(
      `SELECT metadata FROM audit_log WHERE target_id = $1 ORDER BY created_at DESC LIMIT 1`, [String(id)]);
    expect(rows[0]!.metadata.diff).toEqual({ added: ['AUDIT_VIEW'], removed: [] });
  });
});
