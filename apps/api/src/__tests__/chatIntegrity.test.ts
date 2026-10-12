import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';

/** B-01: what a client may send, and reads scoped to the caller's conversation. */

async function user(role: string, name: string) {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [role]);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,$4,$5)`,
    [id, name, `${id}@amashuri.com`, role.toLowerCase(), rows[0]!.id]);
  return { id, token: jwt.sign({ id, misUserId: id, name, email: `${id}@amashuri.com`, role: role.toLowerCase() }, config.jwtSecret) };
}
const as = (t: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${t}`),
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
  patch: (p: string, b?: unknown) => request(app).patch(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
  del: (p: string) => request(app).delete(p).set('Authorization', `Bearer ${t}`),
});
const nonce = () => randomBytes(8).toString('hex');

let owner: Awaited<ReturnType<typeof user>>;
let member: Awaited<ReturnType<typeof user>>;
let outsider: Awaited<ReturnType<typeof user>>;
let group: string;
let outsiderConv: string;
const convs: string[] = [];

beforeAll(async () => {
  await seedRbac(getPool());
  owner = await user('Staff', 'Owner');
  member = await user('Student', 'Member');
  outsider = await user('Staff', 'Outsider');
  group = (await as(owner.token).post('/api/chat/conversations', { type: 'group', name: `g-${nonce()}`, memberIds: [member.id] })).body.data.conversation.id;
  outsiderConv = (await as(outsider.token).post('/api/chat/conversations', { type: 'group', name: `o-${nonce()}`, memberIds: [] })).body.data.conversation.id;
  convs.push(group, outsiderConv);
});

afterAll(async () => {
  const pool = getPool();
  for (const t of ['message_reactions', 'message_mentions', 'message_receipts', 'message_saves']) {
    await pool.query(`DELETE FROM ${t} WHERE conversation_id = ANY($1::text[])`, [convs]).catch(() => {});
  }
  await pool.query('DELETE FROM message_edits WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ANY($1::text[]))', [convs]);
  await pool.query('DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE conversation_id = ANY($1::text[]))', [convs]).catch(() => {});
  await pool.query('DELETE FROM polls WHERE conversation_id = ANY($1::text[])', [convs]);
  await pool.query('DELETE FROM messages WHERE conversation_id = ANY($1::text[])', [convs]);
  await pool.query('DELETE FROM conversation_members WHERE conversation_id = ANY($1::text[])', [convs]);
  await pool.query('DELETE FROM conversations WHERE id = ANY($1::text[])', [convs]);
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [[owner.id, member.id, outsider.id]]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[owner.id, member.id, outsider.id]]);
  await closeDb();
});

describe('what a client may send', () => {
  it('refuses system notices and polls posted as plain messages', async () => {
    for (const type of ['system', 'poll', 'nonsense']) {
      const r = await as(member.token).post(`/api/chat/conversations/${group}/messages`, { body: 'OFFICIAL', type, nonce: nonce() });
      expect(r.status).toBe(400);
    }
  });

  it('caps message metadata', async () => {
    const r = await as(member.token).post(`/api/chat/conversations/${group}/messages`, {
      body: 'big', nonce: nonce(), metadata: { blob: 'x'.repeat(5000) },
    });
    expect(r.status).toBe(400);
  });

  it('a meeting card must point at a real meeting the sender may share', async () => {
    const r = await as(member.token).post(`/api/chat/conversations/${group}/messages`, {
      body: 'join', type: 'call_event', nonce: nonce(), metadata: { meet: { meetingId: 'does-not-exist', joinCode: 'evil' } },
    });
    expect(r.status).toBe(403);
  });

  it('the host’s own meeting card goes through, with details taken from the meeting', async () => {
    const meet = await as(owner.token).post('/api/meet', { title: 'Staff briefing' });
    const meeting = meet.body.data?.meeting ?? meet.body.data;
    expect(meeting?.id).toBeTruthy();
    const r = await as(owner.token).post(`/api/chat/conversations/${group}/messages`, {
      body: '📅 Staff briefing', type: 'call_event', nonce: nonce(),
      metadata: { meet: { meetingId: meeting.id, joinCode: 'tampered', title: 'Something else' } },
    });
    expect(r.status).toBe(201);
    expect(r.body.data.message.metadata.meet.joinCode).toBe(meeting.join_code ?? meeting.joinCode);
    expect(r.body.data.message.metadata.meet.title).toBe('Staff briefing');
    await getPool().query('DELETE FROM meeting_participants WHERE meeting_id = $1', [meeting.id]).catch(() => {});
    await getPool().query('DELETE FROM meetings WHERE id = $1', [meeting.id]).catch(() => {});
  });

  it('a moderator can still remove a system notice that was stored earlier', async () => {
    const { rows } = await getPool().query<{ last_seq: string }>(
      'UPDATE conversations SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq', [group]);
    const mid = snowflake();
    await getPool().query(
      `INSERT INTO messages (id, conversation_id, seq, sender_id, type, body, nonce) VALUES ($1,$2,$3,$4,'system','FAKE NOTICE',$5)`,
      [mid, group, rows[0]!.last_seq, member.id, nonce()]);
    expect((await as(owner.token).del(`/api/chat/conversations/${group}/messages/${mid}`)).status).toBe(200);
  });
});

describe('reads are scoped to the caller’s own conversation', () => {
  it('edit history of a message elsewhere is not readable through another conversation', async () => {
    const m = (await as(owner.token).post(`/api/chat/conversations/${group}/messages`, { body: 'PRIVATE ORIGINAL', nonce: nonce() })).body.data.message;
    await as(owner.token).patch(`/api/chat/conversations/${group}/messages/${m.id}`, { body: 'cleaned' });
    const theirs = await as(outsider.token).get(`/api/chat/conversations/${outsiderConv}/messages/${m.id}/history`);
    expect(JSON.stringify(theirs.body)).not.toContain('PRIVATE ORIGINAL');
    const mine = await as(member.token).get(`/api/chat/conversations/${group}/messages/${m.id}/history`);
    expect(JSON.stringify(mine.body)).toContain('PRIVATE ORIGINAL');
  });

  it('reactors and polls of a message elsewhere are not readable', async () => {
    const m = (await as(owner.token).post(`/api/chat/conversations/${group}/messages`, { body: 'react to me', nonce: nonce() })).body.data.message;
    await as(member.token).post(`/api/chat/conversations/${group}/messages/${m.id}/reactions`, { emoji: '👍' });
    const names = await as(outsider.token).get(`/api/chat/conversations/${outsiderConv}/messages/${m.id}/reactions?emoji=${encodeURIComponent('👍')}`);
    expect(names.body.data.names).toEqual([]);

    const poll = await as(owner.token).post(`/api/chat/conversations/${group}/polls`, { question: 'Lunch?', options: ['Rice', 'Beans'] });
    const pollMsg = poll.body.data?.message?.id ?? poll.body.data?.poll?.messageId;
    if (pollMsg) {
      const r = await as(outsider.token).get(`/api/chat/conversations/${outsiderConv}/messages/${pollMsg}/poll`);
      expect(JSON.stringify(r.body)).not.toContain('Lunch?');
    }
  });
});

describe('one rule for posting into a conversation', () => {
  it('an announcement channel is read-only for a student on every path', async () => {
    const ann = (await as(owner.token).post('/api/chat/conversations', {
      type: 'announcement', name: `ann-${nonce()}`, memberIds: [member.id], visibility: 'private',
    })).body.data.conversation.id;
    convs.push(ann);
    const root = (await as(owner.token).post(`/api/chat/conversations/${ann}/messages`, { body: 'Announcement', nonce: nonce() })).body.data.message;
    const S = as(member.token);
    expect((await S.post(`/api/chat/conversations/${ann}/messages`, { body: 'x', nonce: nonce() })).status).toBe(403);
    expect((await S.post(`/api/chat/conversations/${ann}/messages/${root.id}/replies`, { body: 'via thread', nonce: nonce() })).status).toBe(403);
    expect((await S.post(`/api/chat/conversations/${ann}/messages/${root.id}/replies`, { body: 'to channel', alsoSendToChannel: true, nonce: nonce() })).status).toBe(403);
    expect((await S.post(`/api/chat/conversations/${ann}/polls`, { question: 'Q?', options: ['a', 'b'] })).status).toBe(403);
    // Forwarding a message from a group into the announcement channel is posting there.
    const g = (await S.post(`/api/chat/conversations/${group}/messages`, { body: 'forward me', nonce: nonce() })).body.data.message;
    expect((await S.post(`/api/chat/conversations/${group}/messages/${g.id}/forward`, { conversationIds: [ann] })).status).toBe(403);
    // The announcer still can.
    expect((await as(owner.token).post(`/api/chat/conversations/${ann}/messages/${root.id}/replies`, { body: 'ok', nonce: nonce() })).status).toBe(201);
  });
});
