import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { getPool, closeDb, seedRbac, resolveUserPermissions, snowflake } from '@tupo/db';
import jwt from 'jsonwebtoken';
import { app } from '../app.js';
import { config } from '../config.js';
import { PERMISSIONS } from '@tupo/shared';

/** Create a user holding the named system role and return a session token. */
async function userWithRole(roleName: string | null) {
  const pool = getPool();
  const id = snowflake();
  const roleId = roleName
    ? (await pool.query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [roleName])).rows[0]?.id ?? null
    : null;
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id)
     VALUES ($1, $1, $2, $3, 'staff', $4)`,
    [id, `Test ${roleName ?? 'Unassigned'}`, `${id}@amashuri.com`, roleId]
  );
  const token = jwt.sign(
    { id, misUserId: id, name: 'Test', email: `${id}@amashuri.com`, role: 'staff' },
    config.jwtSecret, { expiresIn: '10m' }
  );
  return { id, token, roleId };
}

beforeEach(async () => {
  await getPool().query('DELETE FROM audit_log');
  await getPool().query('DELETE FROM users');
  await getPool().query('DELETE FROM roles WHERE is_system = false');
  await seedRbac(getPool());
});

afterAll(async () => { await closeDb(); });

describe('seeded catalog', () => {
  it('seeds every permission in the catalog, grouped into categories', async () => {
    const { rows } = await getPool().query<{ count: string }>('SELECT COUNT(*)::text AS count FROM permissions');
    expect(Number(rows[0]!.count)).toBe(PERMISSIONS.length);

    const { rows: cats } = await getPool().query<{ count: string }>(
      'SELECT COUNT(DISTINCT category)::text AS count FROM permissions'
    );
    expect(Number(cats[0]!.count)).toBeGreaterThanOrEqual(10);
  });

  it('seeds the five system roles with distinct permission sets', async () => {
    const { rows } = await getPool().query<{ name: string; n: string }>(
      `SELECT r.name, COUNT(rp.permission_id)::text AS n FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.is_system GROUP BY r.name ORDER BY r.name`
    );
    const byName = Object.fromEntries(rows.map((r) => [r.name, Number(r.n)]));
    expect(Object.keys(byName).sort()).toEqual(['Admin', 'Moderator', 'Parent', 'Staff', 'Student']);
    expect(byName.Admin).toBe(PERMISSIONS.length);
    expect(byName.Student).toBeLessThan(byName.Staff!);
    expect(byName.Staff).toBeLessThan(byName.Admin!);
  });

  it('is idempotent — re-seeding does not duplicate or drift', async () => {
    const before = await getPool().query('SELECT COUNT(*) FROM role_permissions');
    await seedRbac(getPool());
    const after = await getPool().query('SELECT COUNT(*) FROM role_permissions');
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('does not grant students the ability to start direct messages', async () => {
    // Safeguarding default (SRS FR-USR-6) — an explicit product decision, so
    // it gets an explicit test rather than living only in a seed array.
    const { rows } = await getPool().query(
      `SELECT p.key FROM roles r
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.name = 'Student' AND p.key = 'DM_START'`
    );
    expect(rows).toHaveLength(0);
  });
});

describe('permission resolution', () => {
  it('gives an unassigned user an empty permission set, not a default role', async () => {
    const { id } = await userWithRole(null);
    const resolved = await resolveUserPermissions(getPool(), id);
    expect(resolved).not.toBeNull();
    expect(resolved!.roleName).toBeNull();
    expect(resolved!.permissions.size).toBe(0);
  });

  it('returns null for a user that does not exist (dangling session)', async () => {
    expect(await resolveUserPermissions(getPool(), 'nope')).toBeNull();
  });

  it('resolves an admin to the full catalog', async () => {
    const { id } = await userWithRole('Admin');
    const resolved = await resolveUserPermissions(getPool(), id);
    expect(resolved!.permissions.size).toBe(PERMISSIONS.length);
  });
});

describe('route authorization', () => {
  it('lets an admin read the role list', async () => {
    const { token } = await userWithRole('Admin');
    const res = await request(app).get('/api/roles-permissions/roles').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
  });

  it('refuses a student the role list with 403, not 404', async () => {
    const { token } = await userWithRole('Student');
    const res = await request(app).get('/api/roles-permissions/roles').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('refuses an unassigned user everything permission-gated', async () => {
    const { token } = await userWithRole(null);
    for (const path of ['/api/roles-permissions/roles', '/api/users', '/api/audit']) {
      expect((await request(app).get(path).set('Authorization', `Bearer ${token}`)).status).toBe(403);
    }
  });

  it('still lets any signed-in user read their own resolved permissions', async () => {
    const { token } = await userWithRole('Student');
    const res = await request(app).get('/api/roles-permissions/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.roleName).toBe('Student');
    expect(res.body.data.permissionKeys).toContain('MESSAGE_READ');
    expect(res.body.data.permissionKeys).not.toContain('USERS_MANAGE');
  });

  it('rejects an unknown permission key instead of silently dropping it', async () => {
    const { token } = await userWithRole('Admin');
    const res = await request(app).post('/api/roles-permissions/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad Role', level: 'STAFF', permissionKeys: ['MESSAGE_READ', 'NOT_A_REAL_PERMISSION'] });
    expect(res.status).toBe(400);
  });

  it('refuses to delete a system role', async () => {
    const { token } = await userWithRole('Admin');
    const { rows } = await getPool().query<{ id: number }>("SELECT id FROM roles WHERE name = 'Student'");
    const res = await request(app).delete(`/api/roles-permissions/roles/${rows[0]!.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('refuses to delete a role that still has users', async () => {
    const { token } = await userWithRole('Admin');
    const created = await request(app).post('/api/roles-permissions/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Librarian', level: 'STAFF', permissionKeys: ['MESSAGE_READ'] });
    const roleId = created.body.data.id;

    const victim = await userWithRole(null);
    await request(app).put(`/api/users/${victim.id}/role`).set('Authorization', `Bearer ${token}`).send({ roleId });

    const res = await request(app).delete(`/api/roles-permissions/roles/${roleId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
  });
});

describe('permission changes take effect immediately', () => {
  it('applies a new permission on the very next request, with no re-login', async () => {
    const admin = await userWithRole('Admin');
    const staff = await userWithRole('Staff');

    // Staff cannot read the audit log to begin with.
    expect((await request(app).get('/api/audit').set('Authorization', `Bearer ${staff.token}`)).status).toBe(403);

    const { rows } = await getPool().query<{ id: number }>("SELECT id FROM roles WHERE name = 'Staff'");
    const current = await request(app).get(`/api/roles-permissions/roles/${rows[0]!.id}`)
      .set('Authorization', `Bearer ${admin.token}`);

    await request(app).put(`/api/roles-permissions/roles/${rows[0]!.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ permissionKeys: [...current.body.data.permissionKeys, 'AUDIT_VIEW'] });

    // Same token, no re-login — the permission set is re-read per request.
    expect((await request(app).get('/api/audit').set('Authorization', `Bearer ${staff.token}`)).status).toBe(200);
  });

  it('revokes access just as immediately', async () => {
    const admin = await userWithRole('Admin');
    const staff = await userWithRole('Staff');
    const { rows } = await getPool().query<{ id: number }>("SELECT id FROM roles WHERE name = 'Staff'");

    await request(app).put(`/api/roles-permissions/roles/${rows[0]!.id}`)
      .set('Authorization', `Bearer ${admin.token}`).send({ permissionKeys: [] });

    const res = await request(app).get('/api/roles-permissions/me').set('Authorization', `Bearer ${staff.token}`);
    expect(res.body.data.permissionKeys).toEqual([]);
  });
});

describe('administrator lockout protection', () => {
  it('refuses to strip the last active administrator of their own role', async () => {
    const admin = await userWithRole('Admin');
    const res = await request(app).put(`/api/users/${admin.id}/role`)
      .set('Authorization', `Bearer ${admin.token}`).send({ roleId: null });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('only active administrator');
  });

  it('allows it once a second administrator exists', async () => {
    const admin = await userWithRole('Admin');
    await userWithRole('Admin');
    const res = await request(app).put(`/api/users/${admin.id}/role`)
      .set('Authorization', `Bearer ${admin.token}`).send({ roleId: null });
    expect(res.status).toBe(200);
  });

  it('refuses to let an administrator suspend themselves', async () => {
    const admin = await userWithRole('Admin');
    const res = await request(app).put(`/api/users/${admin.id}/status`)
      .set('Authorization', `Bearer ${admin.token}`).send({ status: 'suspended' });
    expect(res.status).toBe(400);
  });
});

describe('sticky role assignment', () => {
  it('marks a hand-assigned role so a later MIS login cannot undo it', async () => {
    const admin = await userWithRole('Admin');
    const target = await userWithRole('Student');
    const { rows } = await getPool().query<{ id: number }>("SELECT id FROM roles WHERE name = 'Moderator'");

    await request(app).put(`/api/users/${target.id}/role`)
      .set('Authorization', `Bearer ${admin.token}`).send({ roleId: rows[0]!.id });

    const { rows: after } = await getPool().query<{ role_assigned_by_admin: boolean; role_id: number }>(
      'SELECT role_assigned_by_admin, role_id FROM users WHERE id = $1', [target.id]
    );
    expect(after[0]!.role_assigned_by_admin).toBe(true);
    expect(after[0]!.role_id).toBe(rows[0]!.id);
  });
});
