import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import * as chat from '@tupo/chat';
import * as mail from '@tupo/mail';
import type { MailCampaignView } from '@tupo/shared';
import { app } from '../app.js';
import { config } from '../config.js';
import { createMeeting } from '../services/meetService.js';

/**
 * Active users only (ACTIVE_USERS_CONTRACTS.md, Tupo section): someone NGA MIS
 * says is not active (users.mis_status INACTIVE / SUSPENDED / REMOVED), or a
 * Tupo administrator suspended, is left out of every list of people, every
 * recipient list and every fan-out. Their history stays.
 */
const tag = `zq${Date.now().toString(36)}`;
const made: string[] = [];

async function person(name: string, opts: { role?: string; misStatus?: string | null; status?: string } = {}) {
  const pool = getPool();
  const id = snowflake();
  const roleId = opts.role
    ? (await pool.query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [opts.role])).rows[0]?.id ?? null
    : null;
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}.${id}@amashuri.com`;
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id, status, mis_status)
     VALUES ($1, $1, $2, $3, 'staff', $4, $5, $6)`,
    [id, `${tag} ${name}`, email, roleId, opts.status ?? 'active', opts.misStatus ?? null],
  );
  made.push(id);
  const token = jwt.sign(
    { id, misUserId: id, name, email, role: 'staff' }, config.jwtSecret, { expiresIn: '10m' },
  );
  return { id, email, token, name: `${tag} ${name}` };
}

const as = (token: string) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: unknown) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body as object),
});

let admin: Awaited<ReturnType<typeof person>>;
let active: Awaited<ReturnType<typeof person>>;
let gone: Awaited<ReturnType<typeof person>>;
let removed: Awaited<ReturnType<typeof person>>;
let suspended: Awaited<ReturnType<typeof person>>;

beforeAll(async () => {
  await seedRbac(getPool());
  admin = await person('Admin Person', { role: 'Admin' });
  active = await person('Active Person', { role: 'Staff', misStatus: 'ACTIVE' });
  gone = await person('Gone Person', { role: 'Staff', misStatus: 'INACTIVE' });
  removed = await person('Removed Person', { role: 'Staff', misStatus: 'REMOVED' });
  suspended = await person('Suspended Person', { role: 'Staff', status: 'suspended' });
});

afterAll(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM meetings WHERE host_id = ANY($1::text[])', [made]);
  await pool.query(`DELETE FROM mail_distribution_lists WHERE name LIKE $1`, [`${tag}%`]);
  await pool.query('DELETE FROM feed_pages WHERE created_by = ANY($1::text[])', [made]).catch(() => {});
  await pool.query(
    `DELETE FROM conversations WHERE id IN (SELECT conversation_id FROM conversation_members WHERE user_id = ANY($1::text[]))`,
    [made],
  ).catch(() => {});
  await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1::text[])', [made]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [made]).catch(() => {});
  await closeDb();
});

const ids = (rows: Array<{ id?: string; userId?: string }>) => rows.map((r) => r.id ?? r.userId);

describe('directories and search list active people only', () => {
  it('chat directory', async () => {
    const res = await as(admin.token).get(`/api/chat/directory?q=${tag}`);
    expect(res.status).toBe(200);
    const found = ids(res.body.data.people ?? res.body.data);
    expect(found).toContain(active.id);
    for (const p of [gone, removed, suspended]) expect(found).not.toContain(p.id);
  });

  it('mail directory', async () => {
    const res = await as(admin.token).get(`/api/mail/directory?q=${tag}`);
    expect(res.status).toBe(200);
    const found = ids(res.body.data.people);
    expect(found).toContain(active.id);
    for (const p of [gone, removed, suspended]) expect(found).not.toContain(p.id);
  });

  it('meet directory', async () => {
    const res = await as(admin.token).get(`/api/meet/directory?q=${tag}`);
    expect(res.status).toBe(200);
    const found = ids(res.body.data);
    expect(found).toContain(active.id);
    for (const p of [gone, removed, suspended]) expect(found).not.toContain(p.id);
  });

  it('global search people section', async () => {
    const res = await as(admin.token).get(`/api/search?q=${tag}&types=person&limit=25`);
    expect(res.status).toBe(200);
    const found = (res.body.data.results.person ?? []).map((r: { id: string }) => r.id.replace('person:', ''));
    expect(found).toContain(active.id);
    for (const p of [gone, removed, suspended]) expect(found).not.toContain(p.id);
  });

  it('admin roster defaults to active, filters by status, and shows mis_status', async () => {
    const list = async (status?: string) => {
      const res = await as(admin.token).get(`/api/users?q=${tag}&limit=200${status ? `&status=${status}` : ''}`);
      expect(res.status).toBe(200);
      return res.body.data as Array<{ id: string; mis_status: string | null; active: boolean }>;
    };
    const def = await list();
    expect(def.map((u) => u.id)).toContain(active.id);
    expect(def.map((u) => u.id)).not.toContain(gone.id);

    const inactive = (await list('inactive')).map((u) => u.id);
    expect(inactive).toEqual(expect.arrayContaining([gone.id, removed.id, suspended.id]));
    expect(inactive).not.toContain(active.id);

    expect((await list('suspended')).map((u) => u.id)).toEqual([suspended.id]);

    const all = await list('all');
    expect(all).toHaveLength(5);
    expect(all.find((u) => u.id === removed.id)).toMatchObject({ mis_status: 'REMOVED', active: false });

    expect((await as(admin.token).get('/api/users?status=nonsense')).status).toBe(400);
  });
});

describe('the person who is no longer active', () => {
  it('cannot use the API: 401 ACCOUNT_INACTIVE', async () => {
    const res = await as(gone.token).get('/api/notifications');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ACCOUNT_INACTIVE');
  });
});

describe('chat', () => {
  it('createConversation drops inactive members', async () => {
    const res = await as(admin.token).post('/api/chat/conversations', {
      type: 'group', name: `${tag} group`, memberIds: [active.id, gone.id, removed.id, suspended.id],
    });
    expect(res.status).toBe(201);
    const members = await chat.memberIdsOf(res.body.data.conversation.id);
    expect(members.sort()).toEqual([admin.id, active.id].sort());
  });

  it('openDirect refuses an inactive peer', async () => {
    const res = await as(admin.token).post('/api/chat/conversations/direct', { userId: gone.id });
    expect(res.status).toBe(409);
    expect((await as(admin.token).post('/api/chat/conversations/direct', { userId: active.id })).status).toBeLessThan(300);
  });

  it('a member who became inactive is flagged in the member list and skipped by fan-out', async () => {
    const res = await as(admin.token).post('/api/chat/conversations', {
      type: 'group', name: `${tag} later`, memberIds: [active.id],
    });
    const convId = res.body.data.conversation.id as string;
    await getPool().query(`UPDATE users SET mis_status = 'INACTIVE' WHERE id = $1`, [active.id]);
    try {
      const members = await chat.listMembers(convId);
      expect(members.find((m) => m.userId === active.id)?.inactive).toBe(true);
      expect(members.find((m) => m.userId === admin.id)?.inactive).toBeUndefined();
      expect(await chat.memberIdsOf(convId)).toEqual([admin.id]);
    } finally {
      await getPool().query(`UPDATE users SET mis_status = 'ACTIVE' WHERE id = $1`, [active.id]);
    }
  });
});

describe('meet', () => {
  it('invites skip inactive people, on the route and in createMeeting', async () => {
    const m = await createMeeting({
      hostId: admin.id, title: `${tag} meeting`,
      scheduledStart: new Date(Date.now() + 86_400_000).toISOString(),
      scheduledEnd: new Date(Date.now() + 90_000_000).toISOString(),
      inviteeIds: [active.id, gone.id],
    });
    const invited = async () => (await getPool().query<{ user_id: string }>(
      'SELECT user_id FROM meeting_invites WHERE meeting_id = $1 ORDER BY user_id', [m.id])).rows.map((r) => r.user_id);
    expect(await invited()).toEqual([active.id]);

    const res = await as(admin.token).post(`/api/meet/${m.id}/invites`, { userIds: [removed.id, suspended.id] });
    expect(res.status).toBe(200);
    expect(res.body.data.invited).toBe(0);
    expect(res.body.data.skipped.sort()).toEqual([removed.id, suspended.id].sort());
    expect(await invited()).toEqual([active.id]);
  });
});

describe('mail', () => {
  it('refuses a raw address that belongs to an inactive internal account, and sends nothing', async () => {
    const before = (await getPool().query('SELECT count(*)::int AS n FROM mail_messages')).rows[0].n;
    const res = await as(admin.token).post('/api/mail/compose', {
      to: [gone.email.toUpperCase()], subject: 'hello', bodyHtml: '<p>hi</p>',
    });
    expect(res.status).toBe(422);
    expect(res.body.message ?? res.body.error).toMatch(/no longer active/);
    expect((await getPool().query('SELECT count(*)::int AS n FROM mail_messages')).rows[0].n).toBe(before);

    const byId = await as(admin.token).post('/api/mail/compose', {
      to: [`userId:${removed.id}`], subject: 'hello', bodyHtml: '<p>hi</p>',
    });
    expect(byId.status).toBe(400);
  });

  it('campaign recipients drop inactive people, from lists and extra addresses', async () => {
    const list = await mail.createList(admin.id, { name: `${tag} list` });
    for (const p of [active, gone, suspended]) {
      await mail.addManualMember(list.id, { address: p.email, name: p.name, userId: p.id });
    }
    await mail.addManualMember(list.id, { address: 'parent@example.org', name: 'Outside Parent' });

    const members = await mail.listMembers(list.id);
    expect(members.find((m) => m.userId === gone.id)?.inactive).toBe(true);
    expect(members.find((m) => m.userId === active.id)?.inactive).toBe(false);

    const recipients = await mail.resolveCampaignRecipients({
      listIds: [list.id],
      extraRecipients: [{ address: removed.email, name: 'x' }, { address: 'guest@example.org', name: 'Guest' }],
    } as unknown as MailCampaignView);
    expect(recipients.map((r) => r.address).sort()).toEqual(
      [active.email, 'guest@example.org', 'parent@example.org'].map((a) => a.toLowerCase()).sort(),
    );
  });
});

describe('feed', () => {
  it('an inactive person cannot be made a page editor', async () => {
    const page = await as(admin.token).post('/api/feed/pages', { name: `${tag} page` });
    expect(page.status).toBe(201);
    const pageId = page.body.data.page.id as string;
    const res = await as(admin.token).post(`/api/feed/pages/${pageId}/editors`, { userId: gone.id, role: 'editor' });
    expect(res.status).toBe(409);
    expect((await as(admin.token).post(`/api/feed/pages/${pageId}/editors`, { userId: active.id, role: 'editor' })).status)
      .toBeLessThan(300);
  });
});
