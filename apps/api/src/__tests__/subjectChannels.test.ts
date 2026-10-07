import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { syncUserSubjects } from '@tupo/chat';
import { app } from '../app.js';
import { config } from '../config.js';

/**
 * Subject channels (the Channels page): membership follows the subjects a
 * person has in the MIS, every subject has a #general, only its teachers add
 * channels, and Chat's endpoints still see them as ordinary conversations.
 */

async function roleId(name: string): Promise<number | null> {
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [name]);
  return rows[0]?.id ?? null;
}

async function user(roleName: string, name: string): Promise<{ id: string; token: string }> {
  const id = snowflake();
  await getPool().query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, roleName.toLowerCase(), await roleId(roleName)],
  );
  const token = jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' },
    config.jwtSecret, { expiresIn: '15m' });
  return { id, token };
}

const api = (token: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`),
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${token}`).send(b ?? {}),
});

let teacher: Awaited<ReturnType<typeof user>>;
let student: Awaited<ReturnType<typeof user>>;
let outsider: Awaited<ReturnType<typeof user>>;
const SUBJECT = `sub${snowflake()}`;
const OTHER = `sub${snowflake()}`;

const channelsOf = async (token: string) =>
  ((await api(token).get('/api/chat/conversations')).body.data.conversations as Array<{ name: string; subjectId: string | null; myRole: string }>)
    .filter((c) => c.subjectId);

beforeAll(async () => {
  await seedRbac(getPool());
  teacher = await user('Staff', 'Tia');
  student = await user('Student', 'Stu');
  outsider = await user('Student', 'Oli');
  await syncUserSubjects(teacher.id, [{ id: SUBJECT, name: 'Web UI', code: 'WUI', role: 'teacher' }]);
  await syncUserSubjects(student.id, [
    { id: SUBJECT, name: 'Web UI', code: 'WUI', role: 'student' },
    { id: OTHER, name: 'Biology', code: 'BIO', role: 'student' },
  ]);
});

afterAll(async () => {
  await closeDb();
});

describe('subject channels', () => {
  it('gives every subject a #general with its teachers as admins and students as members', async () => {
    const t = await channelsOf(teacher.token);
    expect(t.filter((c) => c.subjectId === SUBJECT).map((c) => [c.name, c.myRole])).toEqual([['general', 'admin']]);
    const s = await channelsOf(student.token);
    expect(s.filter((c) => c.subjectId === SUBJECT).map((c) => [c.name, c.myRole])).toEqual([['general', 'member']]);
    expect(s.some((c) => c.subjectId === OTHER && c.name === 'general')).toBe(true);
  });

  it('lists my subjects, and only teachers may add channels', async () => {
    const mine = (await api(teacher.token).get('/api/chat/subjects')).body.data.subjects;
    expect(mine).toEqual([expect.objectContaining({ id: SUBJECT, myRole: 'teacher', canCreateChannels: true })]);
    const theirs = (await api(student.token).get('/api/chat/subjects')).body.data.subjects;
    expect(theirs.find((x: { id: string }) => x.id === SUBJECT)).toMatchObject({ myRole: 'student', canCreateChannels: false });

    expect((await api(student.token).post(`/api/chat/subjects/${SUBJECT}/channels`, { name: 'mine' })).status).toBe(403);
    expect((await api(outsider.token).post(`/api/chat/subjects/${SUBJECT}/channels`, { name: 'mine' })).status).toBe(403);
  });

  it("a teacher's new channel has the whole subject in it, and names are unique per subject", async () => {
    const res = await api(teacher.token).post(`/api/chat/subjects/${SUBJECT}/channels`, { name: 'Homework', topic: 'Deadlines' });
    expect(res.status).toBe(201);
    expect(res.body.data.conversation).toMatchObject({ name: 'homework', subjectId: SUBJECT, myRole: 'owner' });
    expect((await channelsOf(student.token)).map((c) => c.name)).toContain('homework');
    expect((await channelsOf(outsider.token)).length).toBe(0);
    expect((await api(teacher.token).post(`/api/chat/subjects/${SUBJECT}/channels`, { name: 'homework' })).status).toBe(409);
  });

  it('leaving a subject in the MIS takes you out of its channels at the next sync', async () => {
    await syncUserSubjects(student.id, [{ id: OTHER, name: 'Biology', code: 'BIO', role: 'student' }]);
    const s = await channelsOf(student.token);
    expect(s.some((c) => c.subjectId === SUBJECT)).toBe(false);
    expect(s.some((c) => c.subjectId === OTHER)).toBe(true);
  });
});
