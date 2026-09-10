import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { app } from '../app.js';
import { config } from '../config.js';

/**
 * Academic-conduct oversight — a super admin can read any conversation, even a
 * private group or a peer-to-peer DM they are not in, and remove a message that
 * breaks the rules. Both powers are permissioned separately and both are
 * audit-logged.
 */

async function userWithRole(roleName: string | null) {
  const pool = getPool();
  const id = snowflake();
  const roleId = roleName
    ? (await pool.query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [roleName])).rows[0]?.id ?? null
    : null;
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id)
     VALUES ($1, $1, $2, $3, 'staff', $4)`,
    [id, `Test ${roleName ?? 'Unassigned'}`, `${id}@amashuri.com`, roleId],
  );
  const token = jwt.sign(
    { id, misUserId: id, name: 'Test', email: `${id}@amashuri.com`, role: 'staff' },
    config.jwtSecret, { expiresIn: '10m' },
  );
  return { id, token };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const nonce = () => randomBytes(8).toString('hex');

beforeEach(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM messages');
  await pool.query('DELETE FROM conversations');
  await pool.query('DELETE FROM files');
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM roles WHERE is_system = false');
  await seedRbac(pool);
});

afterAll(async () => {
  // conversations.created_by / files.owner_id have no ON DELETE CASCADE, so a
  // later suite's `DELETE FROM users` trips their FK unless this file's rows go.
  await getPool().query('DELETE FROM messages');
  await getPool().query('DELETE FROM conversations');
  await getPool().query('DELETE FROM files');
  await getPool().query('DELETE FROM users');
  await closeDb();
});

/** A ready-to-attach file owned by `ownerId`, inserted straight into the DB. */
async function seedFile(ownerId: string, name = 'evidence.pdf', mime = 'application/pdf') {
  const id = snowflake();
  await getPool().query(
    `INSERT INTO files (id, owner_id, storage_driver, storage_key, original_name, mime_type, size_bytes, status)
     VALUES ($1, $2, 'local', $3, $4, $5, 1024, 'ready')`,
    [id, ownerId, `test/${id}/${name}`, name, mime],
  );
  return id;
}

describe('oversight access control', () => {
  it('refuses a plain staff member the conversation list with 403', async () => {
    const staff = await userWithRole('Staff');
    const res = await request(app).get('/api/oversight/conversations').set(auth(staff.token));
    expect(res.status).toBe(403);
  });

  it('lets an admin list a private group they are not a member of', async () => {
    const admin = await userWithRole('Admin');
    const teacher = await userWithRole('Staff');
    const student = await userWithRole('Student');

    const made = await request(app).post('/api/chat/conversations').set(auth(teacher.token))
      .send({ type: 'group', name: `Secret ${nonce()}`, isPrivate: true, memberIds: [student.id] });
    expect(made.status).toBe(201);
    const convId = made.body.data.conversation.id;

    const list = await request(app).get('/api/oversight/conversations').set(auth(admin.token));
    expect(list.status).toBe(200);
    expect(list.body.data.conversations.some((c: { id: string }) => c.id === convId)).toBe(true);
  });
});

describe('reading a conversation', () => {
  it('reads the messages of a DM between two other people and audit-logs it', async () => {
    const admin = await userWithRole('Admin');
    const a = await userWithRole('Staff');
    const b = await userWithRole('Staff');

    const dm = await request(app).post('/api/chat/conversations/direct').set(auth(a.token))
      .send({ userId: b.id });
    const convId = dm.body.data.conversation.id;
    await request(app).post(`/api/chat/conversations/${convId}/messages`).set(auth(a.token))
      .send({ body: 'meet me behind the gym', nonce: nonce() });

    const res = await request(app).get(`/api/oversight/conversations/${convId}/messages`).set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.messages.some((m: { body: string | null }) => m.body === 'meet me behind the gym')).toBe(true);

    const { rows } = await getPool().query(
      `SELECT actor_id, metadata FROM audit_log WHERE action = 'chat.oversight.conversation.read' AND target_id = $1`,
      [convId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(admin.id);
  });

  it('does not audit-log a plain metadata fetch', async () => {
    const admin = await userWithRole('Admin');
    const a = await userWithRole('Staff');
    const b = await userWithRole('Staff');
    const dm = await request(app).post('/api/chat/conversations/direct').set(auth(a.token)).send({ userId: b.id });
    const convId = dm.body.data.conversation.id;

    await request(app).get(`/api/oversight/conversations/${convId}`).set(auth(admin.token));
    const { rows } = await getPool().query(
      `SELECT 1 FROM audit_log WHERE action LIKE 'chat.oversight%' AND target_id = $1`, [convId],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('removing a message', () => {
  async function seedMessage() {
    const a = await userWithRole('Staff');
    const b = await userWithRole('Staff');
    const dm = await request(app).post('/api/chat/conversations/direct').set(auth(a.token)).send({ userId: b.id });
    const convId = dm.body.data.conversation.id;
    const sent = await request(app).post(`/api/chat/conversations/${convId}/messages`).set(auth(a.token))
      .send({ body: 'something against the rules', nonce: nonce() });
    return { convId, messageId: sent.body.data.message.id, authorId: a.id };
  }

  it('requires a reason', async () => {
    const admin = await userWithRole('Admin');
    const { convId, messageId } = await seedMessage();
    const res = await request(app)
      .post(`/api/oversight/conversations/${convId}/messages/${messageId}/remove`)
      .set(auth(admin.token)).send({});
    expect(res.status).toBe(400);
  });

  it('removes the message, blanks the body, and audit-logs the reason and original text', async () => {
    const admin = await userWithRole('Admin');
    const { convId, messageId, authorId } = await seedMessage();

    const res = await request(app)
      .post(`/api/oversight/conversations/${convId}/messages/${messageId}/remove`)
      .set(auth(admin.token)).send({ reason: 'Bullying or harassment' });
    expect(res.status).toBe(200);

    const { rows: msg } = await getPool().query(
      'SELECT body, deleted_at, deleted_by FROM messages WHERE id = $1', [messageId],
    );
    expect(msg[0].body).toBeNull();
    expect(msg[0].deleted_at).not.toBeNull();
    expect(msg[0].deleted_by).toBe(admin.id);

    const { rows: log } = await getPool().query(
      `SELECT metadata FROM audit_log WHERE action = 'chat.oversight.message.remove' AND target_id = $1`,
      [messageId],
    );
    expect(log).toHaveLength(1);
    expect(log[0].metadata.reason).toBe('Bullying or harassment');
    expect(log[0].metadata.removedText).toBe('something against the rules');
    expect(log[0].metadata.authorId).toBe(authorId);
  });

  it('refuses a second removal of the same message', async () => {
    const admin = await userWithRole('Admin');
    const { convId, messageId } = await seedMessage();
    const url = `/api/oversight/conversations/${convId}/messages/${messageId}/remove`;
    await request(app).post(url).set(auth(admin.token)).send({ reason: 'Spam or off-topic disruption' });
    const again = await request(app).post(url).set(auth(admin.token)).send({ reason: 'Spam or off-topic disruption' });
    expect(again.status).toBe(409);
  });

  it('preserves the original text: oversight still reads a message it removed', async () => {
    const admin = await userWithRole('Admin');
    const { convId, messageId } = await seedMessage();
    await request(app).post(`/api/oversight/conversations/${convId}/messages/${messageId}/remove`)
      .set(auth(admin.token)).send({ reason: 'Bullying or harassment' });

    const page = await request(app).get(`/api/oversight/conversations/${convId}/messages`).set(auth(admin.token));
    const wire = page.body.data.messages.find((m: { id: string }) => m.id === messageId);
    expect(wire.deletedAt).not.toBeNull();
    expect(wire.deletedBy).toBe(admin.id);
    expect(wire.body).toBe('something against the rules');   // revealed, not a blank tombstone

    // The raw column ordinary reads use is still blanked.
    const { rows } = await getPool().query('SELECT body, deleted_body FROM messages WHERE id = $1', [messageId]);
    expect(rows[0].body).toBeNull();
    expect(rows[0].deleted_body).toBe('something against the rules');
  });

  it('reveals a message the SENDER deleted, too', async () => {
    const admin = await userWithRole('Admin');
    const a = await userWithRole('Staff');
    const b = await userWithRole('Staff');
    const dm = await request(app).post('/api/chat/conversations/direct').set(auth(a.token)).send({ userId: b.id });
    const convId = dm.body.data.conversation.id;
    const sent = await request(app).post(`/api/chat/conversations/${convId}/messages`).set(auth(a.token))
      .send({ body: 'wish I had not sent this', nonce: nonce() });
    const messageId = sent.body.data.message.id;

    // The sender deletes their own message through the ordinary chat route.
    await request(app).delete(`/api/chat/conversations/${convId}/messages/${messageId}`).set(auth(a.token));

    // An ordinary reader sees a tombstone…
    const chatView = await request(app).get(`/api/chat/conversations/${convId}/messages`).set(auth(b.token));
    expect(chatView.body.data.messages.find((m: { id: string }) => m.id === messageId).body).toBeNull();

    // …oversight sees what it said.
    const oView = await request(app).get(`/api/oversight/conversations/${convId}/messages`).set(auth(admin.token));
    expect(oView.body.data.messages.find((m: { id: string }) => m.id === messageId).body)
      .toBe('wish I had not sent this');
  });

  it('lets a view-only oversight role read but not remove', async () => {
    const admin = await userWithRole('Admin');
    const created = await request(app).post('/api/roles-permissions/roles').set(auth(admin.token))
      .send({ name: 'Conduct Reviewer', level: 'STAFF', permissionKeys: ['MESSAGE_READ', 'OVERSIGHT_VIEW_ALL'] });
    expect(created.status).toBeLessThan(300);

    const reviewerId = snowflake();
    await getPool().query(
      `INSERT INTO users (id, mis_user_id, name, email, role, role_id)
       VALUES ($1, $1, 'Reviewer', $2, 'staff', $3)`,
      [reviewerId, `${reviewerId}@amashuri.com`, created.body.data.id],
    );
    const reviewerToken = jwt.sign(
      { id: reviewerId, misUserId: reviewerId, name: 'Reviewer', email: `${reviewerId}@amashuri.com`, role: 'staff' },
      config.jwtSecret, { expiresIn: '10m' },
    );

    const { convId, messageId } = await seedMessage();

    const read = await request(app).get(`/api/oversight/conversations/${convId}/messages`).set(auth(reviewerToken));
    expect(read.status).toBe(200);

    const remove = await request(app)
      .post(`/api/oversight/conversations/${convId}/messages/${messageId}/remove`)
      .set(auth(reviewerToken)).send({ reason: 'Threats or violence' });
    expect(remove.status).toBe(403);
  });
});

describe('removing an attachment', () => {
  async function seedMessageWithAttachment() {
    const a = await userWithRole('Staff');
    const b = await userWithRole('Staff');
    const dm = await request(app).post('/api/chat/conversations/direct').set(auth(a.token)).send({ userId: b.id });
    const convId = dm.body.data.conversation.id;
    const fileId = await seedFile(a.id, 'answers.pdf');
    const sent = await request(app).post(`/api/chat/conversations/${convId}/messages`).set(auth(a.token))
      .send({ body: 'see attached', nonce: nonce(), attachments: [fileId] });
    return { convId, messageId: sent.body.data.message.id, fileId, authorId: a.id };
  }

  it('requires a reason', async () => {
    const admin = await userWithRole('Admin');
    const { convId, messageId, fileId } = await seedMessageWithAttachment();
    const res = await request(app)
      .post(`/api/oversight/conversations/${convId}/messages/${messageId}/attachments/${fileId}/remove`)
      .set(auth(admin.token)).send({});
    expect(res.status).toBe(400);
  });

  it('detaches and soft-deletes the file, keeps the message, and audit-logs it', async () => {
    const admin = await userWithRole('Admin');
    const { convId, messageId, fileId, authorId } = await seedMessageWithAttachment();

    const res = await request(app)
      .post(`/api/oversight/conversations/${convId}/messages/${messageId}/attachments/${fileId}/remove`)
      .set(auth(admin.token)).send({ reason: 'Academic dishonesty' });
    expect(res.status).toBe(200);
    expect(res.body.data.remaining).toBe(0);

    const { rows: msg } = await getPool().query(
      'SELECT body, deleted_at, attachments FROM messages WHERE id = $1', [messageId]);
    expect(msg[0].body).toBe('see attached');          // message text untouched
    expect(msg[0].deleted_at).toBeNull();              // message not removed
    expect(msg[0].attachments).toEqual([]);            // file gone from the JSON

    const { rows: att } = await getPool().query(
      'SELECT 1 FROM message_attachments WHERE message_id = $1 AND file_id = $2', [messageId, fileId]);
    expect(att).toHaveLength(0);

    const { rows: file } = await getPool().query('SELECT deleted_at FROM files WHERE id = $1', [fileId]);
    expect(file[0].deleted_at).not.toBeNull();

    const { rows: log } = await getPool().query(
      `SELECT metadata FROM audit_log WHERE action = 'chat.oversight.attachment.remove' AND target_id = $1`,
      [messageId]);
    expect(log).toHaveLength(1);
    expect(log[0].metadata.fileName).toBe('answers.pdf');
    expect(log[0].metadata.reason).toBe('Academic dishonesty');
    expect(log[0].metadata.authorId).toBe(authorId);
  });

  it('404s when the file is not on that message', async () => {
    const admin = await userWithRole('Admin');
    const { convId, messageId } = await seedMessageWithAttachment();
    const res = await request(app)
      .post(`/api/oversight/conversations/${convId}/messages/${messageId}/attachments/999999/remove`)
      .set(auth(admin.token)).send({ reason: 'Sharing personal data' });
    expect(res.status).toBe(404);
  });

  it('refuses a view-only oversight role', async () => {
    const admin = await userWithRole('Admin');
    const created = await request(app).post('/api/roles-permissions/roles').set(auth(admin.token))
      .send({ name: 'Viewer Only', level: 'STAFF', permissionKeys: ['MESSAGE_READ', 'OVERSIGHT_VIEW_ALL'] });
    const viewerId = snowflake();
    await getPool().query(
      `INSERT INTO users (id, mis_user_id, name, email, role, role_id)
       VALUES ($1, $1, 'Viewer', $2, 'staff', $3)`,
      [viewerId, `${viewerId}@amashuri.com`, created.body.data.id]);
    const viewerToken = jwt.sign(
      { id: viewerId, misUserId: viewerId, name: 'Viewer', email: `${viewerId}@amashuri.com`, role: 'staff' },
      config.jwtSecret, { expiresIn: '10m' });

    const { convId, messageId, fileId } = await seedMessageWithAttachment();
    const res = await request(app)
      .post(`/api/oversight/conversations/${convId}/messages/${messageId}/attachments/${fileId}/remove`)
      .set(auth(viewerToken)).send({ reason: 'Academic dishonesty' });
    expect(res.status).toBe(403);
  });

  it('counts attachment removals in the oversight stats', async () => {
    const admin = await userWithRole('Admin');
    const { convId, messageId, fileId } = await seedMessageWithAttachment();
    await request(app)
      .post(`/api/oversight/conversations/${convId}/messages/${messageId}/attachments/${fileId}/remove`)
      .set(auth(admin.token)).send({ reason: 'Sexual or inappropriate content' });

    const stats = await request(app).get('/api/oversight/stats').set(auth(admin.token));
    expect(stats.body.data.stats.attachmentsRemoved).toBe(1);
  });
});
