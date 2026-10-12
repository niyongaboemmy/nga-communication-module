import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import jwt from 'jsonwebtoken';
import { app } from '../app.js';
import { config } from '../config.js';
import { setRelationshipsTransport, type MisRelationships } from '../services/mentorshipService.js';

/**
 * Mentorship from NGA MIS (2026-10-12). A student could not reach their mentor:
 * MIS hid the page, and Tupo would not let a student start a DM (no DM_START).
 * Tupo now asks MIS who mentors whom, shows the mentor's profile, and lets a
 * student and their own mentor open a chat — nobody else, and never past a block.
 */

const MENTOR_MIS = 7001;
const STUDENT_MIS = 7002;
const OTHER_STUDENT_MIS = 7003;

const person = (user_id: number, name: string, user_type: string, extra: Record<string, unknown> = {}) => ({
  user_id, name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@nga.ac.rw`, user_type,
  avatar: { md: `https://api.amashuri.com/avatars/${user_id}/1/md.webp?s=x` }, cover: null,
  academic_year_id: 9, academic_year_name: '2026 - 2027', assigned_at: '2026-09-01T08:00:00.000Z', ...extra,
});

const RELATIONSHIPS: Record<number, MisRelationships> = {
  [STUDENT_MIS]: {
    user_id: STUDENT_MIS,
    mentor: person(MENTOR_MIS, 'Grace Mukamana', 'TEACHER', { phone: '+250788000111' }) as any,
    mentees: [],
  },
  [MENTOR_MIS]: {
    user_id: MENTOR_MIS,
    mentor: null,
    mentees: [person(STUDENT_MIS, 'Eric Habimana', 'STUDENT', { class_group_name: 'S4 MCB', registration_number: 'NGA001' }) as any],
  },
  [OTHER_STUDENT_MIS]: { user_id: OTHER_STUDENT_MIS, mentor: null, mentees: [] },
};

let misCalls = 0;
let misDown = false;

async function signedIn(misUserId: number, name: string, roleName: string, role: string) {
  const pool = getPool();
  const id = snowflake();
  const roleId = (await pool.query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [roleName])).rows[0]?.id ?? null;
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, String(misUserId), name, `${id}@nga.ac.rw`, role, roleId],
  );
  const token = jwt.sign({ id, misUserId: String(misUserId), name, email: `${id}@nga.ac.rw`, role },
    config.jwtSecret, { expiresIn: '10m' });
  return { id, token };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(() => {
  config.ssoClientId = 'tupo';
  config.ssoClientSecret = 'test-secret';
});

beforeEach(async () => {
  misCalls = 0;
  misDown = false;
  setRelationshipsTransport(async (url, headers) => {
    misCalls++;
    if (misDown) throw new Error('connect ECONNREFUSED');
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('tupo:test-secret').toString('base64')}`);
    const id = Number(url.split('/').pop());
    return { status: 200, body: { success: true, data: RELATIONSHIPS[id] ?? { user_id: id, mentor: null, mentees: [] } } };
  });
  const pool = getPool();
  await pool.query('DELETE FROM user_blocks');
  await pool.query('DELETE FROM messages');
  await pool.query('DELETE FROM conversations');
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM roles WHERE is_system = false');
  await seedRbac(pool);
});

afterAll(async () => {
  setRelationshipsTransport(null);
  await getPool().query('DELETE FROM messages');
  await getPool().query('DELETE FROM conversations');
  await getPool().query('DELETE FROM users');
  await closeDb();
});

describe('GET /api/chat/mentorship', () => {
  it("shows a student their mentor's full profile, creating the mentor's Tupo account if needed", async () => {
    const student = await signedIn(STUDENT_MIS, 'Eric Habimana', 'Student', 'student');
    const res = await request(app).get('/api/chat/mentorship').set(auth(student.token));
    expect(res.status).toBe(200);
    const mentor = res.body.data.mentor;
    expect(mentor).toMatchObject({
      misUserId: MENTOR_MIS,
      name: 'Grace Mukamana',
      userType: 'TEACHER',
      email: 'grace.mukamana@nga.ac.rw',
      phone: '+250788000111',
      academicYearName: '2026 - 2027',
      avatarUrl: expect.stringContaining(`/avatars/${MENTOR_MIS}/`),
    });
    expect(mentor.tupoUserId).toBeTruthy();
    expect(mentor.profile).toMatchObject({ id: mentor.tupoUserId, presence: 'offline', directConversationId: null });
    expect(res.body.data.mentees).toEqual([]);

    // The mentor never signed in: their row is a staff mirror, not an admin.
    const { rows } = await getPool().query('SELECT role, last_login_at FROM users WHERE mis_user_id = $1', [String(MENTOR_MIS)]);
    expect(rows[0]).toMatchObject({ role: 'staff', last_login_at: null });
  });

  it('shows a mentor their mentees without echoing contact details', async () => {
    const mentor = await signedIn(MENTOR_MIS, 'Grace Mukamana', 'Staff', 'staff');
    const res = await request(app).get('/api/chat/mentorship').set(auth(mentor.token));
    expect(res.status).toBe(200);
    expect(res.body.data.mentor).toBeNull();
    expect(res.body.data.mentees).toHaveLength(1);
    expect(res.body.data.mentees[0]).toMatchObject({
      misUserId: STUDENT_MIS, name: 'Eric Habimana', classGroupName: 'S4 MCB', registrationNumber: 'NGA001',
      email: null, phone: null,
    });
  });

  it('asks MIS once a minute per person, not on every request', async () => {
    const student = await signedIn(STUDENT_MIS, 'Eric Habimana', 'Student', 'student');
    await request(app).get('/api/chat/mentorship').set(auth(student.token));
    await request(app).get('/api/chat/mentorship').set(auth(student.token));
    expect(misCalls).toBe(1);
  });

  it('answers 503 when MIS cannot be reached', async () => {
    misDown = true;
    const student = await signedIn(STUDENT_MIS, 'Eric Habimana', 'Student', 'student');
    const res = await request(app).get('/api/chat/mentorship').set(auth(student.token));
    expect(res.status).toBe(503);
  });
});

describe('Opening a DM between a student and their mentor', () => {
  it('a student with no DM_START can open a chat with their own mentor, and the mentor sees it', async () => {
    const student = await signedIn(STUDENT_MIS, 'Eric Habimana', 'Student', 'student');
    const mentor = await signedIn(MENTOR_MIS, 'Grace Mukamana', 'Staff', 'staff');
    const res = await request(app).post('/api/chat/conversations/direct').set(auth(student.token)).send({ userId: mentor.id });
    expect(res.status).toBe(200);
    const conversationId = res.body.data.conversation.id;

    const sent = await request(app).post(`/api/chat/conversations/${conversationId}/messages`)
      .set(auth(student.token)).send({ body: 'Hello, can we meet this week?', nonce: 'n1' });
    expect(sent.status).toBe(201);

    const list = await request(app).get('/api/chat/conversations').set(auth(mentor.token));
    expect(list.body.data.conversations.map((c: any) => c.id)).toContain(conversationId);
  });

  it('works through the mentor account Tupo created before the mentor ever signed in', async () => {
    const student = await signedIn(STUDENT_MIS, 'Eric Habimana', 'Student', 'student');
    const page = await request(app).get('/api/chat/mentorship').set(auth(student.token));
    const res = await request(app).post('/api/chat/conversations/direct').set(auth(student.token))
      .send({ userId: page.body.data.mentor.tupoUserId });
    expect(res.status).toBe(200);
  });

  it('a student still cannot open a chat with anyone else', async () => {
    const student = await signedIn(STUDENT_MIS, 'Eric Habimana', 'Student', 'student');
    const stranger = await signedIn(OTHER_STUDENT_MIS, 'Someone Else', 'Staff', 'staff');
    const res = await request(app).post('/api/chat/conversations/direct').set(auth(student.token)).send({ userId: stranger.id });
    expect(res.status).toBe(403);
  });

  it('a block still wins over mentorship', async () => {
    const student = await signedIn(STUDENT_MIS, 'Eric Habimana', 'Student', 'student');
    const mentor = await signedIn(MENTOR_MIS, 'Grace Mukamana', 'Staff', 'staff');
    await getPool().query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)', [mentor.id, student.id]);
    const res = await request(app).post('/api/chat/conversations/direct').set(auth(student.token)).send({ userId: mentor.id });
    expect(res.status).toBe(403);
  });

  it('fails closed when MIS is down: the ordinary rules apply', async () => {
    misDown = true;
    const student = await signedIn(STUDENT_MIS, 'Eric Habimana', 'Student', 'student');
    const mentor = await signedIn(MENTOR_MIS, 'Grace Mukamana', 'Staff', 'staff');
    const res = await request(app).post('/api/chat/conversations/direct').set(auth(student.token)).send({ userId: mentor.id });
    expect(res.status).toBe(403);
  });
});
