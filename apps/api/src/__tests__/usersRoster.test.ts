import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import jwt from 'jsonwebtoken';
import { app } from '../app.js';
import { config } from '../config.js';

/** F-11: the roster pages, filters and sorts on the server; roles and exports are safe. */

async function roleId(name: string) {
  return (await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [name])).rows[0]!.id;
}

async function user(name: string, role: number | null, extra: { status?: string; lastLogin?: string } = {}) {
  const id = snowflake();
  await getPool().query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id, status, last_login_at)
     VALUES ($1, $1, $2, $3, 'staff', $4, $5, $6)`,
    [id, name, `${id}@amashuri.com`, role, extra.status ?? 'active', extra.lastLogin ?? null]);
  const token = jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' },
    config.jwtSecret, { expiresIn: '10m' });
  return { id, auth: `Bearer ${token}` };
}

let admin: { id: string; auth: string };
beforeEach(async () => {
  await getPool().query('DELETE FROM audit_log');
  await getPool().query('DELETE FROM users');
  await getPool().query('DELETE FROM roles WHERE is_system = false');
  await seedRbac(getPool());
  admin = await user('Aaron Admin', await roleId('Admin'), { lastLogin: '2026-10-01T08:00:00Z' });
});
afterAll(async () => { await closeDb(); });

describe('GET /api/users', () => {
  it('pages with a real total beyond the page size', async () => {
    for (let i = 0; i < 7; i++) await user(`Pupil ${i}`, await roleId('Student'));
    const first = await request(app).get('/api/users?limit=3&offset=0&status=all').set('Authorization', admin.auth);
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(3);
    expect(first.body.total).toBe(8);
    const last = await request(app).get('/api/users?limit=3&offset=6&status=all').set('Authorization', admin.auth);
    expect(last.body.data).toHaveLength(2);
    const names = [...first.body.data, ...last.body.data].map((u: { name: string }) => u.name);
    expect(new Set(names).size).toBe(5);
  });

  it('filters by role, unassigned and status, with counts for the chips', async () => {
    await user('Sam Student', await roleId('Student'));
    await user('Nora None', null);
    await user('Sid Suspended', await roleId('Student'), { status: 'suspended' });
    const students = await request(app).get(`/api/users?role=${await roleId('Student')}&status=all`).set('Authorization', admin.auth);
    expect(students.body.data.map((u: { name: string }) => u.name).sort()).toEqual(['Sam Student', 'Sid Suspended']);
    const none = await request(app).get('/api/users?role=none').set('Authorization', admin.auth);
    expect(none.body.data.map((u: { name: string }) => u.name)).toEqual(['Nora None']);
    const suspended = await request(app).get('/api/users?status=suspended').set('Authorization', admin.auth);
    expect(suspended.body.total).toBe(1);
    // Facets ignore the status filter, so every chip keeps its own number.
    expect(suspended.body.facets).toMatchObject({ all: 4, active: 3, inactive: 1, suspended: 1, unassigned: 1 });
  });

  it('sorts by last sign-in with never-signed-in last', async () => {
    await user('Early', null, { lastLogin: '2026-09-01T08:00:00Z' });
    await user('Never', null);
    const res = await request(app).get('/api/users?sort=last_login&dir=desc').set('Authorization', admin.auth);
    expect(res.body.data.map((u: { name: string }) => u.name)).toEqual(['Aaron Admin', 'Early', 'Never']);
  });

  it('ignores an unknown sort column instead of injecting it', async () => {
    const res = await request(app).get('/api/users?sort=name;DROP TABLE users').set('Authorization', admin.auth);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/users/assignable-roles', () => {
  it('lists every role, marking those beyond the actor', async () => {
    const pool = getPool();
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO roles (name, description, level, is_system) VALUES ('Registrar', '', 'STAFF', false) RETURNING id`);
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = ANY($2::text[])`,
      [rows[0]!.id, ['USERS_MANAGE', 'MESSAGE_READ']]);
    const reg = await user('Rita Registrar', rows[0]!.id);
    const res = await request(app).get('/api/users/assignable-roles').set('Authorization', reg.auth);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.data.map((r: { name: string }) => [r.name, r]));
    expect(byName.Admin.assignable).toBe(false);
    expect(byName.Admin.grantsGovernance).toBe(true);
    expect(byName.Registrar.assignable).toBe(true);
  });

  it('is refused without USERS_MANAGE', async () => {
    const pupil = await user('Pia Pupil', await roleId('Student'));
    const res = await request(app).get('/api/users/assignable-roles').set('Authorization', pupil.auth);
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/users/:id/role', () => {
  it('refuses a change made against a stale view, and records names in the audit', async () => {
    const target = await user('Tom Target', await roleId('Student'));
    const staff = await roleId('Staff');
    const stale = await request(app).put(`/api/users/${target.id}/role`).set('Authorization', admin.auth)
      .send({ roleId: staff, expectedRoleId: await roleId('Parent') });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('ROLE_CHANGED');
    const fresh = await request(app).put(`/api/users/${target.id}/role`).set('Authorization', admin.auth)
      .send({ roleId: staff, expectedRoleId: await roleId('Student') });
    expect(fresh.status).toBe(200);
    const { rows } = await getPool().query(`SELECT metadata FROM audit_log WHERE action = 'user.role.assign'`);
    expect(rows[0].metadata).toMatchObject({ roleNameFrom: 'Student', roleNameTo: 'Staff' });
  });
});

describe('GET /api/users/export.csv', () => {
  it('exports the filtered roster, defuses formulas, and is audited', async () => {
    await user('=HYPERLINK("http://evil")', null);
    await user('Plain Person', await roleId('Student'));
    const res = await request(app).get('/api/users/export.csv?role=none').set('Authorization', admin.auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Name,Email,MIS id,Role,Status,MIS status,Role set by admin,Last sign-in');
    expect(lines).toHaveLength(2);
    expect(lines[1]!.startsWith(`"'=HYPERLINK(""http://evil"")"`)).toBe(true);
    const { rows } = await getPool().query(`SELECT metadata FROM audit_log WHERE action = 'users.export'`);
    expect(rows[0].metadata.rows).toBe(1);
  });

  it('is refused without a users permission', async () => {
    const pupil = await user('Pia Pupil', await roleId('Student'));
    const res = await request(app).get('/api/users/export.csv').set('Authorization', pupil.auth);
    expect(res.status).toBe(403);
  });
});
