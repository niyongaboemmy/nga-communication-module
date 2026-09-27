import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import jwt from 'jsonwebtoken';
import { app } from '../app.js';
import { config } from '../config.js';
import { upsertMisUser } from '../services/userService.js';

/**
 * Phase 0 access-control fixes:
 *  - an admin's role change keeps `users.role` and `academic_level` in step
 *    with `role_id`, so a demoted admin loses the admin-only reach those
 *    columns grant (dashboard scope, contact rules, feed audiences);
 *  - a MIS login does not re-promote someone an admin pinned to a non-admin role;
 *  - a bulk send over the approval threshold always waits for a second person.
 */

interface UserOpts {
  role?: string;
  academicLevel?: string | null;
  programIds?: string[]; gradeIds?: string[]; classGroupIds?: string[];
  pinned?: boolean;
}

async function makeUser(roleName: string | null, opts: UserOpts = {}) {
  const pool = getPool();
  const id = snowflake();
  const roleId = roleName
    ? (await pool.query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [roleName])).rows[0]?.id ?? null
    : null;
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id, role_assigned_by_admin,
                        academic_level, mis_program_ids, mis_grade_ids, mis_class_group_ids)
     VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, `U ${id}`, `${id}@amashuri.com`, opts.role ?? 'staff', roleId, opts.pinned ?? false,
     opts.academicLevel ?? null, opts.programIds ?? [], opts.gradeIds ?? [], opts.classGroupIds ?? []],
  );
  const token = jwt.sign(
    { id, misUserId: id, name: 'U', email: `${id}@amashuri.com`, role: opts.role ?? 'staff' },
    config.jwtSecret, { expiresIn: '10m' });
  return { id, token, roleId };
}

const roleIdOf = async (name: string) =>
  (await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [name])).rows[0]!.id;

const readUser = async (id: string) => (await getPool().query<{
  role: string; role_id: number | null; academic_level: string | null; role_assigned_by_admin: boolean;
}>('SELECT role, role_id, academic_level, role_assigned_by_admin FROM users WHERE id = $1', [id])).rows[0]!;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function cleanup() {
  const pool = getPool();
  await pool.query('DELETE FROM mail_campaigns');
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM roles WHERE is_system = false');
}

beforeEach(async () => {
  await cleanup();
  await seedRbac(getPool());
});

afterAll(async () => {
  await cleanup();
  await closeDb();
});

describe('PUT /api/users/:id/role keeps users.role and academic_level in step', () => {
  it('demoting an admin to Staff drops the admin label and the super_admin scope', async () => {
    const actor = await makeUser('Admin', { role: 'admin', academicLevel: 'super_admin' });
    const target = await makeUser('Admin', {
      role: 'admin', academicLevel: 'super_admin', pinned: true,
      programIds: ['p1'], gradeIds: ['g1'], classGroupIds: ['c1'],
    });

    // Before: unrestricted dashboard.
    const before = await request(app).get('/api/dashboard/scope').set(auth(target.token));
    expect(before.body.data.scope.unrestricted).toBe(true);

    const res = await request(app).put(`/api/users/${target.id}/role`)
      .set(auth(actor.token)).send({ roleId: await roleIdOf('Staff') });
    expect(res.status).toBe(200);

    const row = await readUser(target.id);
    expect(row.role).toBe('staff');
    expect(row.role_id).toBe(await roleIdOf('Staff'));
    // Placement arrays are kept; the level comes back from them, not super_admin.
    expect(row.academic_level).toBe('class_teacher');

    const after = await request(app).get('/api/dashboard/scope').set(auth(target.token));
    expect(after.status).toBe(200);
    expect(after.body.data.scope.unrestricted).toBe(false);
    expect(after.body.data.scope.level).toBe('class_teacher');
  });

  it('a demoted admin with only a programme placement becomes a programme lead', async () => {
    const actor = await makeUser('Admin', { role: 'admin' });
    const target = await makeUser('Admin', {
      role: 'admin', academicLevel: 'super_admin', programIds: ['p1'],
    });
    await request(app).put(`/api/users/${target.id}/role`)
      .set(auth(actor.token)).send({ roleId: await roleIdOf('Staff') }).expect(200);
    expect((await readUser(target.id)).academic_level).toBe('program_lead');
  });

  it('a demoted admin with no placement falls back to the coarse role', async () => {
    const actor = await makeUser('Admin', { role: 'admin' });
    const target = await makeUser('Admin', { role: 'admin', academicLevel: 'super_admin' });
    await request(app).put(`/api/users/${target.id}/role`)
      .set(auth(actor.token)).send({ roleId: await roleIdOf('Student') }).expect(200);
    const row = await readUser(target.id);
    expect(row.role).toBe('student');
    expect(row.academic_level).toBe('student');
  });

  it('promoting to Admin sets the admin label and super_admin level', async () => {
    const actor = await makeUser('Admin', { role: 'admin' });
    const target = await makeUser('Staff', { role: 'staff', academicLevel: 'class_teacher', gradeIds: ['g1'] });
    await request(app).put(`/api/users/${target.id}/role`)
      .set(auth(actor.token)).send({ roleId: await roleIdOf('Admin') }).expect(200);
    const row = await readUser(target.id);
    expect(row.role).toBe('admin');
    expect(row.academic_level).toBe('super_admin');
    expect(row.role_assigned_by_admin).toBe(true);
  });

  it('a custom or Moderator role is labelled by its level, and a non-admin level is left alone', async () => {
    const actor = await makeUser('Admin', { role: 'admin' });
    const target = await makeUser('Staff', { role: 'staff', academicLevel: 'program_lead', programIds: ['p1'] });
    await request(app).put(`/api/users/${target.id}/role`)
      .set(auth(actor.token)).send({ roleId: await roleIdOf('Moderator') }).expect(200);
    const row = await readUser(target.id);
    expect(row.role).toBe('staff');
    expect(row.academic_level).toBe('program_lead');
  });

  it('removing the role marks the user unassigned', async () => {
    const actor = await makeUser('Admin', { role: 'admin' });
    const target = await makeUser('Staff', { role: 'staff', academicLevel: 'staff', pinned: true });
    await request(app).put(`/api/users/${target.id}/role`)
      .set(auth(actor.token)).send({ roleId: null }).expect(200);
    const row = await readUser(target.id);
    expect(row.role).toBe('unassigned');
    expect(row.role_id).toBeNull();
    expect(row.academic_level).toBe('staff');
  });
});

describe('upsertMisUser respects an admin-pinned non-admin role', () => {
  const misSuperAdmin = {
    level: 'super_admin' as const, placementLevel: 'class_teacher' as const,
    programIds: ['p1'], gradeIds: ['g1'], classGroupIds: ['c1'],
    programNames: ['P'], gradeNames: ['G'], classGroupNames: ['C'],
  };

  it('a MIS SUPER_ADMIN pinned to Staff is not re-promoted at login', async () => {
    const target = await makeUser('Staff', { role: 'staff', pinned: true, academicLevel: 'class_teacher' });
    const session = await upsertMisUser({
      misUserId: target.id, name: 'U', email: `${target.id}@amashuri.com`,
      derivedRole: 'admin', forceAdmin: false, academic: misSuperAdmin,
    });
    expect(session.role).toBe('staff');
    const row = await readUser(target.id);
    expect(row.role).toBe('staff');
    expect(row.role_id).toBe(await roleIdOf('Staff'));
    expect(row.academic_level).toBe('class_teacher');
  });

  it('a stale role label from before the fix is corrected from the pinned role row', async () => {
    // Demoted under the old route: role_id moved, the text column did not.
    const target = await makeUser('Staff', { role: 'admin', pinned: true, academicLevel: 'super_admin' });
    const session = await upsertMisUser({
      misUserId: target.id, name: 'U', email: `${target.id}@amashuri.com`,
      derivedRole: 'admin', forceAdmin: false,
      academic: { ...misSuperAdmin, placementLevel: undefined, gradeIds: [], classGroupIds: [] },
    });
    expect(session.role).toBe('staff');
    const row = await readUser(target.id);
    expect(row.role).toBe('staff');
    // No placementLevel supplied: derived from the arrays (programme only).
    expect(row.academic_level).toBe('program_lead');
  });

  it('an unpinned MIS SUPER_ADMIN still lands as admin / super_admin (unchanged)', async () => {
    const target = await makeUser(null, { role: 'unassigned' });
    const session = await upsertMisUser({
      misUserId: target.id, name: 'U', email: `${target.id}@amashuri.com`,
      derivedRole: 'admin', forceAdmin: false, academic: misSuperAdmin,
    });
    expect(session.role).toBe('admin');
    expect((await readUser(target.id)).academic_level).toBe('super_admin');
  });
});

describe('bulk mail approval is four-eyes', () => {
  const recipients = (n: number) => Array.from({ length: n }, (_, i) => ({
    address: `r${i}@example.org`, name: `R ${i}`,
  }));

  async function createCampaign(token: string, n: number) {
    const res = await request(app).post('/api/mail/campaigns').set(auth(token)).send({
      name: 'Term notice', subject: 'Term notice', bodyHtml: '<p>Hello {{name}}</p>',
      extraRecipients: recipients(n),
    });
    expect(res.status).toBe(201);
    return res.body.data.campaign.id as string;
  }

  it('an approver sending over the threshold goes to pending approval, not auto-approved', async () => {
    const sender = await makeUser('Admin', { role: 'admin' });
    const id = await createCampaign(sender.token, 201);

    const res = await request(app).post(`/api/mail/campaigns/${id}/submit`).set(auth(sender.token));
    expect(res.status).toBe(200);
    expect(res.body.data.campaign.status).toBe('pending_approval');
    expect(res.body.data.campaign.approvedBy).toBeNull();
  });

  it('the sender cannot approve their own campaign; another approver can', async () => {
    const sender = await makeUser('Admin', { role: 'admin' });
    const other = await makeUser('Moderator', { role: 'staff' });
    const id = await createCampaign(sender.token, 201);
    await request(app).post(`/api/mail/campaigns/${id}/submit`).set(auth(sender.token)).expect(200);

    const self = await request(app).post(`/api/mail/campaigns/${id}/approve`).set(auth(sender.token));
    expect(self.status).toBe(403);
    expect(self.body.error ?? self.body.message ?? JSON.stringify(self.body)).toMatch(/own bulk send/i);

    const { rows } = await getPool().query<{ status: string }>(
      'SELECT status FROM mail_campaigns WHERE id = $1', [id]);
    expect(rows[0]!.status).toBe('pending_approval');

    const ok = await request(app).post(`/api/mail/campaigns/${id}/approve`).set(auth(other.token));
    expect(ok.status).toBe(200);
    expect(ok.body.data.campaign.status).toBe('approved');
    expect(ok.body.data.campaign.approvedBy).toBe(other.id);
  });

  it('a send at or under the threshold still goes straight out', async () => {
    const sender = await makeUser('Admin', { role: 'admin' });
    const id = await createCampaign(sender.token, 5);
    const res = await request(app).post(`/api/mail/campaigns/${id}/submit`).set(auth(sender.token));
    expect(res.body.data.campaign.status).toBe('approved');
  });
});
