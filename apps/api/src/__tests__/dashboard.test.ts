import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { app } from '../app.js';
import { config } from '../config.js';

/**
 * The realtime admin dashboard.
 *
 * The load-bearing test is scoping: a programme lead's numbers must be built
 * only from the users in their programme, and a super admin's from everyone.
 */

interface AcademicOpts {
  level?: string;
  programIds?: string[]; gradeIds?: string[]; classGroupIds?: string[];
}

async function makeUser(roleName: string | null, ac: AcademicOpts = {}) {
  const pool = getPool();
  const id = snowflake();
  const roleId = roleName
    ? (await pool.query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [roleName])).rows[0]?.id ?? null
    : null;
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id,
                        academic_level, mis_program_ids, mis_grade_ids, mis_class_group_ids,
                        last_seen_at, last_login_at)
     VALUES ($1, $1, $2, $3, 'staff', $4, $5, $6, $7, $8, now(), now())`,
    [id, `U ${id}`, `${id}@amashuri.com`, roleId, ac.level ?? null,
     ac.programIds ?? [], ac.gradeIds ?? [], ac.classGroupIds ?? []],
  );
  const token = jwt.sign(
    { id, misUserId: id, name: 'U', email: `${id}@amashuri.com`, role: 'staff' },
    config.jwtSecret, { expiresIn: '10m' });
  return { id, token };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const nonce = () => randomBytes(8).toString('hex');

/** A conversation + a message from `senderId`, straight into the DB. */
async function seedMessage(senderId: string) {
  const pool = getPool();
  const spaceId = snowflake();
  await pool.query(
    `INSERT INTO spaces (id, slug, name) VALUES ($1, $1, 'S') ON CONFLICT DO NOTHING`, [spaceId]);
  const convId = snowflake();
  await pool.query(
    `INSERT INTO conversations (id, space_id, type, name, member_count, last_seq)
     VALUES ($1, $2, 'group', 'G', 1, 1)`, [convId, spaceId]);
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member')`,
    [convId, senderId]);
  await pool.query(
    `INSERT INTO messages (id, conversation_id, seq, sender_id, type, body, nonce, created_at)
     VALUES ($1, $2, 1, $3, 'text', 'hello', $4, now())`,
    [snowflake(), convId, senderId, nonce()]);
  return convId;
}

beforeEach(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM messages');
  await pool.query('DELETE FROM conversations');
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM roles WHERE is_system = false');
  await seedRbac(pool);
});

afterAll(async () => {
  await getPool().query('DELETE FROM messages');
  await getPool().query('DELETE FROM conversations');
  await getPool().query('DELETE FROM users');
  await closeDb();
});

describe('access control', () => {
  it('refuses a student every dashboard endpoint', async () => {
    const student = await makeUser('Student');
    for (const path of ['/api/dashboard/scope', '/api/dashboard/overview', '/api/dashboard/online']) {
      expect((await request(app).get(path).set(auth(student.token))).status).toBe(403);
    }
  });

  it('lets a staff member in, scoped to themselves', async () => {
    const staff = await makeUser('Staff', { level: 'staff' });
    const res = await request(app).get('/api/dashboard/scope').set(auth(staff.token));
    expect(res.status).toBe(200);
    expect(res.body.data.scope.unrestricted).toBe(false);
  });
});

describe('super admin', () => {
  it('sees the whole institution, unrestricted', async () => {
    const admin = await makeUser('Admin');
    await makeUser('Student');
    await makeUser('Staff');

    const scope = await request(app).get('/api/dashboard/scope').set(auth(admin.token));
    expect(scope.body.data.scope.unrestricted).toBe(true);

    const o = await request(app).get('/api/dashboard/overview').set(auth(admin.token));
    expect(o.status).toBe(200);
    expect(o.body.data.scopedUsers).toBeNull();
    expect(o.body.data.people.total).toBe(3);
    expect(o.body.data).toHaveProperty('chat.messages');
    expect(o.body.data).toHaveProperty('activitySeries');
    expect(Array.isArray(o.body.data.activitySeries)).toBe(true);
  });
});

describe('programme-lead scoping', () => {
  it('counts only users and activity inside the lead’s programme', async () => {
    const lead = await makeUser('Staff', { level: 'program_lead', programIds: ['P1'] });
    const inProgram = await makeUser('Student', { level: 'student', programIds: ['P1'] });
    const alsoInProgram = await makeUser('Student', { level: 'student', programIds: ['P1'] });
    const outsider = await makeUser('Student', { level: 'student', programIds: ['P2'] });

    await seedMessage(inProgram.id);   // in scope  → counted
    await seedMessage(outsider.id);    // out of scope → not counted

    const o = await request(app).get('/api/dashboard/overview').set(auth(lead.token));
    expect(o.status).toBe(200);
    // the lead is themselves a P1 member → lead + 2 students = 3; the P2
    // outsider is excluded.
    expect(o.body.data.scopedUsers).toBe(3);
    expect(o.body.data.people.total).toBe(3);
    expect(o.body.data.chat.messages).toBe(1);          // only the P1 message
    expect(o.body.data.chat.activeSenders).toBe(1);
    void alsoInProgram;
  });

  it('ignores a programme filter outside the lead’s scope', async () => {
    const lead = await makeUser('Staff', { level: 'program_lead', programIds: ['P1'] });
    await makeUser('Student', { level: 'student', programIds: ['P1'] });
    await makeUser('Student', { level: 'student', programIds: ['P2'] });

    // Ask for P2 — not theirs. Should fall back to their own scope (P1), not widen.
    const o = await request(app).get('/api/dashboard/overview?program=P2').set(auth(lead.token));
    expect(o.body.data.scopedUsers).toBe(2); // lead + 1 P1 student
  });
});

describe('class-teacher scoping (privacy fix)', () => {
  /*
   * A class teacher's row carries the programme of their grade in
   * mis_program_ids (membership — so the programme lead counts them) and the
   * grade itself. Neither may widen their OWN view: they see their class
   * groups only, never the rest of the grade or the programme.
   */
  it('sees only their class group, not their grade or programme', async () => {
    const ct = await makeUser('Staff', {
      level: 'class_teacher', programIds: ['P1'], gradeIds: ['G1'], classGroupIds: ['C1'],
    });
    const myStudent = await makeUser('Student', { level: 'student', classGroupIds: ['C1'] });
    const otherTeacherSameGrade = await makeUser('Staff', {
      level: 'class_teacher', programIds: ['P1'], gradeIds: ['G1'], classGroupIds: ['C2'],
    });
    const lead = await makeUser('Staff', { level: 'program_lead', programIds: ['P1'] });
    const studentOtherClass = await makeUser('Student', {
      level: 'student', programIds: ['P1'], gradeIds: ['G1'], classGroupIds: ['C2'],
    });

    await seedMessage(myStudent.id);          // in scope
    await seedMessage(studentOtherClass.id);  // same programme + grade, other class: out

    const scope = await request(app).get('/api/dashboard/scope').set(auth(ct.token));
    expect(scope.body.data.scope.unrestricted).toBe(false);
    expect(scope.body.data.scope.programs).toEqual([]);
    expect(scope.body.data.scope.grades).toEqual([]);
    expect(scope.body.data.scope.classGroups.map((c: { id: string }) => c.id)).toEqual(['C1']);

    const o = await request(app).get('/api/dashboard/overview').set(auth(ct.token));
    expect(o.status).toBe(200);
    expect(o.body.data.scopedUsers).toBe(2);        // themselves + their student
    expect(o.body.data.chat.messages).toBe(1);

    // Asking for the programme or grade does not widen it.
    const widened = await request(app).get('/api/dashboard/overview?program=P1&grade=G1').set(auth(ct.token));
    expect(widened.body.data.scopedUsers).toBe(2);

    const online = await request(app).get('/api/dashboard/online').set(auth(ct.token));
    expect(online.status).toBe(200);
    void otherTeacherSameGrade; void lead;
  });

  it('the programme lead still counts the class teachers of their programme', async () => {
    const lead = await makeUser('Staff', { level: 'program_lead', programIds: ['P1'] });
    await makeUser('Staff', { level: 'class_teacher', programIds: ['P1'], gradeIds: ['G1'], classGroupIds: ['C1'] });
    await makeUser('Staff', { level: 'class_teacher', programIds: ['P2'], gradeIds: ['G9'], classGroupIds: ['C9'] });
    const o = await request(app).get('/api/dashboard/overview').set(auth(lead.token));
    expect(o.body.data.scopedUsers).toBe(2);        // lead + the P1 class teacher
  });

  it('a programme lead who is also a class teacher elsewhere is scoped to the programme they lead', async () => {
    // Leads P1; class teacher of C9 in programme P2 (membership carries P2).
    const lead = await makeUser('Staff', {
      level: 'program_lead', programIds: ['P1', 'P2'], gradeIds: ['G9'], classGroupIds: ['C9'],
    });
    await getPool().query(`UPDATE users SET mis_lead_program_ids = '{P1}' WHERE id = $1`, [lead.id]);
    await makeUser('Staff', { level: 'class_teacher', programIds: ['P1'], classGroupIds: ['C1'] });
    await makeUser('Staff', { level: 'class_teacher', programIds: ['P2'], classGroupIds: ['C8'] });
    await makeUser('Student', { level: 'student', classGroupIds: ['C9'] });
    const o = await request(app).get('/api/dashboard/overview').set(auth(lead.token));
    // lead + P1 teacher + their own C9 student; not the P2/C8 teacher.
    expect(o.body.data.scopedUsers).toBe(3);
  });
});

describe('online roster', () => {
  it('returns a shaped list', async () => {
    const admin = await makeUser('Admin');
    const res = await request(app).get('/api/dashboard/online').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('people');
    expect(Array.isArray(res.body.data.people)).toBe(true);
  });
});
