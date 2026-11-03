import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import jwt from 'jsonwebtoken';
import { app } from '../app.js';
import { config } from '../config.js';

/** F-12: saves are made against a version; name and description are editable. */

async function roleId(name: string) {
  return (await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [name])).rows[0]!.id;
}
async function admin() {
  const id = snowflake();
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,'A',$2,'admin',$3)`,
    [id, `${id}@amashuri.com`, await roleId('Admin')]);
  return `Bearer ${jwt.sign({ id, misUserId: id, name: 'A', email: `${id}@amashuri.com`, role: 'admin' }, config.jwtSecret, { expiresIn: '10m' })}`;
}
async function custom(name = 'Librarian') {
  const { rows } = await getPool().query<{ id: number }>(
    `INSERT INTO roles (name, description, level, is_system) VALUES ($1, 'Books', 'STAFF', false) RETURNING id`, [name]);
  return rows[0]!.id;
}

let auth: string;
beforeEach(async () => {
  await getPool().query('DELETE FROM audit_log');
  await getPool().query('DELETE FROM users');
  await getPool().query('DELETE FROM roles WHERE is_system = false');
  await seedRbac(getPool());
  auth = await admin();
});
afterAll(async () => { await closeDb(); });

describe('PUT /api/roles-permissions/roles/:id', () => {
  it('reports a save made against an older version, with the current role', async () => {
    const id = await custom();
    const first = await request(app).get(`/api/roles-permissions/roles/${id}`).set('Authorization', auth);
    const v1 = first.body.data.version;
    expect(typeof v1).toBe('string');
    const a = await request(app).put(`/api/roles-permissions/roles/${id}`).set('Authorization', auth)
      .send({ permissionKeys: ['MESSAGE_READ'], expectedVersion: v1 });
    expect(a.status).toBe(200);
    expect(a.body.data.version).not.toBe(v1);
    const b = await request(app).put(`/api/roles-permissions/roles/${id}`).set('Authorization', auth)
      .send({ permissionKeys: ['MESSAGE_SEND'], expectedVersion: v1 });
    expect(b.status).toBe(409);
    expect(b.body.code).toBe('ROLE_STALE');
    expect(b.body.data.permissionKeys).toEqual(['MESSAGE_READ']);
    // Saving over it on purpose, against the version now on screen.
    const c = await request(app).put(`/api/roles-permissions/roles/${id}`).set('Authorization', auth)
      .send({ permissionKeys: ['MESSAGE_SEND'], expectedVersion: b.body.data.version });
    expect(c.status).toBe(200);
    expect(c.body.data.permissionKeys).toEqual(['MESSAGE_SEND']);
  });

  it('renames a custom role and edits its description, recorded in the audit', async () => {
    const id = await custom();
    const res = await request(app).put(`/api/roles-permissions/roles/${id}`).set('Authorization', auth)
      .send({ name: '  Library staff ', description: 'Runs the library' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Library staff', description: 'Runs the library' });
    const { rows } = await getPool().query(`SELECT metadata FROM audit_log WHERE action = 'role.update'`);
    expect(rows[0].metadata.renamed).toEqual({ from: 'Librarian', to: 'Library staff' });
    expect(rows[0].metadata.description).toEqual({ from: 'Books', to: 'Runs the library' });
  });

  it('keeps a system role\'s name but lets its description change', async () => {
    const staff = await roleId('Staff');
    expect((await request(app).put(`/api/roles-permissions/roles/${staff}`).set('Authorization', auth)
      .send({ name: 'Teachers' })).status).toBe(400);
    expect((await request(app).put(`/api/roles-permissions/roles/${staff}`).set('Authorization', auth)
      .send({ description: 'Teaching and support staff' })).status).toBe(200);
  });

  it('refuses a duplicate name, an empty name and an over-long description', async () => {
    const id = await custom();
    await custom('Bursar');
    expect((await request(app).put(`/api/roles-permissions/roles/${id}`).set('Authorization', auth).send({ name: 'bursar' })).status).toBe(409);
    expect((await request(app).put(`/api/roles-permissions/roles/${id}`).set('Authorization', auth).send({ name: '   ' })).status).toBe(400);
    expect((await request(app).put(`/api/roles-permissions/roles/${id}`).set('Authorization', auth).send({ description: 'x'.repeat(301) })).status).toBe(400);
  });
});
