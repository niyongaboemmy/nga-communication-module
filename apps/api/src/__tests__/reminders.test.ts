import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { reminders } from '@tupo/notify';
import { app } from '../app.js';
import { config } from '../config.js';

/**
 * Meeting reminders → the MIS Reminder Hub.
 *
 * The transport is mocked; everything else is real — the meet routes, the
 * PostgreSQL audience query, the sweep. What is asserted is what would have
 * gone over the wire.
 */

type Sent = reminders.ReminderRequest;
let sent: Sent[] = [];
let respond: (req: Sent) => reminders.ReminderResponse = okResponse;

function okResponse(req: Sent): reminders.ReminderResponse {
  if (req.method === 'DELETE') return { status: 200, body: { success: true } };
  const items = (req.body as { items: reminders.ReminderItem[] }).items;
  return {
    status: 200,
    body: { success: true, data: { results: items.map((i) => ({ external_id: i.external_id, ok: true })) } },
  };
}

const TEST_CONFIG = {
  enabled: true,
  misBaseUrl: 'https://mis.test',
  clientId: 'tupo',
  clientSecret: 's3cret:with-colon',
  appPublicUrl: 'https://tupo.test',
};

let nextMisId = 9000;

/** A user whose MIS id is deliberately NOT their Tupo id. */
async function user(roleName: string | null = 'Staff', opts: { status?: string } = {}) {
  const pool = getPool();
  const id = snowflake();
  const misUserId = String(nextMisId++);
  const roleId = roleName
    ? (await pool.query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [roleName])).rows[0]?.id ?? null
    : null;
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id, status)
     VALUES ($1, $2, 'Test', $3, 'staff', $4, $5)`,
    [id, misUserId, `${id}@amashuri.com`, roleId, opts.status ?? 'active'],
  );
  const token = jwt.sign(
    { id, misUserId, name: 'Test', email: `${id}@amashuri.com`, role: 'staff' },
    config.jwtSecret, { expiresIn: '10m' },
  );
  return { id, misUserId: Number(misUserId), token };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const inHours = (h: number) => new Date(Date.now() + h * 3.6e6);

async function settle(): Promise<void> {
  await reminders.flushReminderSyncs();
}

const puts = () => sent.filter((s) => s.method === 'PUT');
const deletes = () => sent.filter((s) => s.method === 'DELETE');
const lastItem = () => {
  const p = puts().at(-1);
  return (p?.body as { items: reminders.ReminderItem[] } | undefined)?.items[0];
};

beforeEach(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM meetings');
  await pool.query('DELETE FROM meeting_events');
  await pool.query('DELETE FROM files');
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM roles WHERE is_system = false');
  await seedRbac(pool);
  sent = [];
  respond = okResponse;
  reminders.configureReminders({
    config: TEST_CONFIG,
    transport: async (req) => { sent.push(req); return respond(req); },
  });
});

afterEach(async () => {
  await settle();
  reminders.resetReminders();
});

afterAll(async () => {
  await getPool().query('DELETE FROM files').catch(() => {});
  await getPool().query('DELETE FROM meetings').catch(() => {});
  await closeDb();
});

/* ================================================================== *
 * Building an item — pure
 * ================================================================== */

describe('decideMeetingReminder', () => {
  const now = new Date('2026-10-01T06:00:00Z');
  const row = (over: Partial<reminders.ReminderMeetingRow> = {}): reminders.ReminderMeetingRow => ({
    id: '1234', title: '  Staff briefing ', status: 'scheduled', join_code: 'bcd-fghj-kmn',
    // 10:00 in Kigali (UTC+2), stored as an instant.
    scheduled_start: new Date('2026-10-01T10:00:00+02:00'),
    scheduled_end: new Date('2026-10-01T11:30:00+02:00'),
    ...over,
  });

  it('describes a scheduled meeting in UTC, with the join link and MIS ids', () => {
    const d = reminders.decideMeetingReminder(row(), ['42', '7', '42', 'not-a-number', '', null, '0'],
      { appPublicUrl: 'https://tupo.amashuri.com' }, now);
    expect(d).toEqual({
      action: 'sync',
      item: {
        source_app: 'tupo',
        source_type: 'meeting',
        external_id: 'meeting-1234',
        title: 'Staff briefing',
        starts_at: '2026-10-01T08:00:00.000Z',
        ends_at: '2026-10-01T09:30:00.000Z',
        link: 'https://tupo.amashuri.com/app/meet/bcd-fghj-kmn',
        location: null,
        critical: false,
        audience_user_ids: [42, 7],
      },
    });
  });

  it('sends no end when there is none, or when it is not after the start', () => {
    const cfg = { appPublicUrl: 'https://x' };
    const a = reminders.decideMeetingReminder(row({ scheduled_end: null }), ['1'], cfg, now);
    const b = reminders.decideMeetingReminder(
      row({ scheduled_end: new Date('2026-10-01T07:00:00Z') }), ['1'], cfg, now);
    expect(a.action === 'sync' && a.item.ends_at).toBeNull();
    expect(b.action === 'sync' && b.item.ends_at).toBeNull();
  });

  it('skips instant, live, past and unscheduled meetings', () => {
    const cfg = { appPublicUrl: 'https://x' };
    expect(reminders.decideMeetingReminder(row({ status: 'live' }), ['1'], cfg, now).action).toBe('skip');
    expect(reminders.decideMeetingReminder(row({ scheduled_start: null }), ['1'], cfg, now).action).toBe('skip');
    expect(reminders.decideMeetingReminder(
      row({ scheduled_start: new Date('2026-10-01T05:59:00Z') }), ['1'], cfg, now).action).toBe('skip');
  });

  it('withdraws cancelled and ended meetings, and one with nobody left to remind', () => {
    const cfg = { appPublicUrl: 'https://x' };
    expect(reminders.decideMeetingReminder(row({ status: 'cancelled' }), ['1'], cfg, now).action).toBe('cancel');
    expect(reminders.decideMeetingReminder(row({ status: 'ended' }), ['1'], cfg, now).action).toBe('cancel');
    expect(reminders.decideMeetingReminder(row(), ['guest', null], cfg, now).action).toBe('cancel');
  });

  it('caps the audience at the Hub limit', () => {
    const ids = Array.from({ length: 5100 }, (_, i) => String(i + 1));
    const d = reminders.decideMeetingReminder(row(), ids, { appPublicUrl: 'https://x' }, now);
    expect(d.action === 'sync' && d.item.audience_user_ids.length).toBe(5000);
  });
});

describe('reminderConfigFromEnv', () => {
  const base = { NODE_ENV: 'production', SSO_CLIENT_ID: 'tupo', SSO_CLIENT_SECRET: 'x' };

  it('is on with credentials, and reads the same variables as the API config', () => {
    const c = reminders.reminderConfigFromEnv({
      ...base, NGA_MIS_BASE_URL: 'https://api.amashuri.com/', APP_PUBLIC_URL: 'https://tupo.amashuri.com/',
    });
    expect(c).toMatchObject({
      enabled: true, misBaseUrl: 'https://api.amashuri.com', appPublicUrl: 'https://tupo.amashuri.com',
      clientId: 'tupo', clientSecret: 'x',
    });
  });

  it('falls back to the first CORS origin for the public URL, as the API does', () => {
    const c = reminders.reminderConfigFromEnv({ ...base, CORS_ORIGINS: 'https://a.test, https://b.test' });
    expect(c.appPublicUrl).toBe('https://a.test');
  });

  it('is off when switched off, under test, or without a real secret', () => {
    expect(reminders.reminderConfigFromEnv({ ...base, REMINDERS_SYNC: 'false' }).enabled).toBe(false);
    expect(reminders.reminderConfigFromEnv({ ...base, NODE_ENV: 'test' }).enabled).toBe(false);
    expect(reminders.reminderConfigFromEnv({ ...base, SSO_CLIENT_SECRET: '' }).enabled).toBe(false);
    expect(reminders.reminderConfigFromEnv({ ...base, SSO_CLIENT_SECRET: 'placeholder_client_secret' }).enabled)
      .toBe(false);
  });
});

/* ================================================================== *
 * The meet routes
 * ================================================================== */

describe('scheduling a meeting', () => {
  it('sends one item, authenticated as the SSO client, with MIS ids of host + invitees', async () => {
    const host = await user();
    const a = await user();
    const b = await user();
    const start = inHours(24);

    const res = await request(app).post('/api/meet').set(auth(host.token))
      .send({ title: 'Parents evening', scheduledStart: start.toISOString(), inviteeIds: [a.id, b.id] })
      .expect(201);
    await settle();

    expect(puts()).toHaveLength(1);
    const req = puts()[0]!;
    expect(req.url).toBe('https://mis.test/reminders/sources/batch');
    // Split on the first colon only, MIS-side — a colon in the secret survives.
    expect(req.headers.Authorization)
      .toBe(`Basic ${Buffer.from('tupo:s3cret:with-colon').toString('base64')}`);

    const item = lastItem()!;
    expect(item).toMatchObject({
      source_app: 'tupo', source_type: 'meeting',
      external_id: `meeting-${res.body.data.id}`,
      title: 'Parents evening',
      starts_at: start.toISOString(),
      link: `https://tupo.test/app/meet/${res.body.data.join_code}`,
      critical: false,
    });
    expect([...item.audience_user_ids].sort()).toEqual([host.misUserId, a.misUserId, b.misUserId].sort());
    // Never Tupo's own ids.
    for (const id of [host.id, a.id, b.id]) expect(item.audience_user_ids).not.toContain(Number(id));
  });

  it('sends nothing for an instant meeting', async () => {
    const host = await user();
    await request(app).post('/api/meet/instant').set(auth(host.token)).send({}).expect(201);
    await request(app).post('/api/meet').set(auth(host.token)).send({ title: 'Now' }).expect(201);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('never fails the request when the MIS is down', async () => {
    const host = await user();
    respond = () => { throw new Error('ECONNREFUSED'); };
    await request(app).post('/api/meet').set(auth(host.token))
      .send({ scheduledStart: inHours(2).toISOString() }).expect(201);
    await settle();
    expect(puts()).toHaveLength(1);
  });

  it('sends nothing when disabled (the default under NODE_ENV=test)', async () => {
    reminders.resetReminders();
    const host = await user();
    await request(app).post('/api/meet').set(auth(host.token))
      .send({ scheduledStart: inHours(2).toISOString() }).expect(201);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('includes current members of the conversation it was scheduled from, not past ones or suspended accounts', async () => {
    const pool = getPool();
    const host = await user();
    const member = await user();
    const leaver = await user();
    const suspended = await user('Staff', { status: 'suspended' });
    const spaceId = snowflake();
    const convId = snowflake();
    await pool.query(`INSERT INTO spaces (id, slug, name) VALUES ($1, $1, 'S')`, [spaceId]);
    await pool.query(
      `INSERT INTO conversations (id, space_id, type, name, member_count, last_seq)
       VALUES ($1, $2, 'group', 'Year 9 staff', 3, 0)`, [convId, spaceId]);
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, left_at)
       VALUES ($1, $2, NULL), ($1, $3, NULL), ($1, $4, now()), ($1, $5, NULL)`,
      [convId, host.id, member.id, leaver.id, suspended.id]);

    await request(app).post('/api/meet').set(auth(host.token))
      .send({ scheduledStart: inHours(3).toISOString(), conversationId: convId }).expect(201);
    await settle();

    expect([...lastItem()!.audience_user_ids].sort()).toEqual([host.misUserId, member.misUserId].sort());
  });
});

describe('changing a meeting', () => {
  async function scheduled() {
    const host = await user();
    const guest = await user();
    const res = await request(app).post('/api/meet').set(auth(host.token))
      .send({ title: 'Board', scheduledStart: inHours(5).toISOString(), inviteeIds: [guest.id] })
      .expect(201);
    await settle();
    sent = [];
    return { host, guest, id: res.body.data.id as string };
  }

  it('re-sends on reschedule, with the new time', async () => {
    const { host, id } = await scheduled();
    const later = inHours(48);
    await request(app).patch(`/api/meet/${id}`).set(auth(host.token))
      .send({ scheduledStart: later.toISOString() }).expect(200);
    await settle();
    expect(lastItem()).toMatchObject({ external_id: `meeting-${id}`, starts_at: later.toISOString() });
  });

  it('re-sends on rename', async () => {
    const { host, id } = await scheduled();
    await request(app).put(`/api/meet/${id}/name`).set(auth(host.token)).send({ title: 'Board (moved)' }).expect(200);
    await settle();
    expect(lastItem()?.title).toBe('Board (moved)');
  });

  it('re-sends with a new invitee, and without someone who declined', async () => {
    const { host, guest, id } = await scheduled();
    const extra = await user();
    await request(app).post(`/api/meet/${id}/invites`).set(auth(host.token))
      .send({ userIds: [extra.id] }).expect(200);
    await settle();
    expect(lastItem()!.audience_user_ids).toContain(extra.misUserId);

    await request(app).put(`/api/meet/${id}/invites/me`).set(auth(guest.token))
      .send({ response: 'declined' }).expect(200);
    await settle();
    expect(lastItem()!.audience_user_ids).not.toContain(guest.misUserId);
    expect(lastItem()!.audience_user_ids).toContain(host.misUserId);
  });

  it('withdraws on cancel, and a 404 from the Hub is fine', async () => {
    const { host, id } = await scheduled();
    respond = (req) => (req.method === 'DELETE' ? { status: 404, body: { success: false } } : okResponse(req));
    await request(app).delete(`/api/meet/${id}`).set(auth(host.token)).expect(200);
    await settle();
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0]!.url).toBe(`https://mis.test/reminders/sources/tupo/meeting/meeting-${id}`);
    expect(deletes()[0]!.headers.Authorization).toMatch(/^Basic /);
  });

  it('withdraws on cancel through PATCH status', async () => {
    const { host, id } = await scheduled();
    await request(app).patch(`/api/meet/${id}`).set(auth(host.token)).send({ status: 'cancelled' }).expect(200);
    await settle();
    expect(puts()).toHaveLength(0);
    expect(deletes().map((d) => d.url)).toEqual([`https://mis.test/reminders/sources/tupo/meeting/meeting-${id}`]);
  });

  it('withdraws on a real delete', async () => {
    const { host, id } = await scheduled();
    await request(app).delete(`/api/meet/${id}?purge=true`).set(auth(host.token)).expect(200);
    await settle();
    expect(deletes().map((d) => d.url)).toEqual([`https://mis.test/reminders/sources/tupo/meeting/meeting-${id}`]);
  });

  it('syncMeeting on a purged meeting withdraws it', async () => {
    await expect(reminders.syncMeeting('gone')).resolves.toBe('cancelled');
    expect(deletes()[0]!.url).toBe('https://mis.test/reminders/sources/tupo/meeting/meeting-gone');
  });

  it('syncMeeting reports an item the Hub rejected', async () => {
    const { id } = await scheduled();
    respond = (req) => ({
      status: 200,
      body: { success: true, data: { results: [{ external_id: `meeting-${id}`, ok: false, error: 'title is required' }] } },
    });
    await expect(reminders.syncMeeting(id)).rejects.toThrow(/title is required/);
  });
});

/* ================================================================== *
 * The sweep
 * ================================================================== */

describe('runReminderSweep', () => {
  async function insertMeeting(hostId: string, start: Date, status = 'scheduled', title = 'M') {
    const id = snowflake();
    await getPool().query(
      `INSERT INTO meetings (id, host_id, title, room_name, join_code, status, scheduled_start)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, hostId, title, `tupo-${id}`, `c-${id}`, status, start],
    );
    return id;
  }

  it('re-sends upcoming meetings in batches of 200, and ignores the rest', async () => {
    const host = await user();
    for (let i = 0; i < 205; i++) await insertMeeting(host.id, inHours(1 + i / 10));
    await insertMeeting(host.id, inHours(24 * 15));          // beyond 14 days
    await insertMeeting(host.id, inHours(-1));               // already started
    await insertMeeting(host.id, inHours(2), 'live');        // live

    const result = await reminders.runReminderSweep();

    expect(result).toMatchObject({ status: 'ok', considered: 205, synced: 205, batches: 2, rejected: 0 });
    expect(puts().map((p) => (p.body as { items: unknown[] }).items.length)).toEqual([200, 5]);
    for (const p of puts()) expect(p.headers.Authorization).toMatch(/^Basic /);
  });

  it('withdraws recently cancelled meetings still ahead, and carries on past a failed batch', async () => {
    const host = await user();
    await insertMeeting(host.id, inHours(3));
    const cancelled = await insertMeeting(host.id, inHours(4), 'cancelled');
    respond = (req) => (req.method === 'PUT' ? { status: 503, body: { message: 'down' } } : okResponse(req));

    const result = await reminders.runReminderSweep();

    expect(result.rejected).toBe(1);
    expect(result.errors[0]).toMatch(/HTTP 503 down/);
    expect(result.cancelled).toBe(1);
    expect(deletes().map((d) => d.url)).toEqual([`https://mis.test/reminders/sources/tupo/meeting/meeting-${cancelled}`]);
  });

  it('is a no-op when disabled', async () => {
    reminders.configureReminders({ config: { enabled: false, disabledReason: 'REMINDERS_SYNC is off' } });
    const host = await user();
    await insertMeeting(host.id, inHours(3));
    expect(await reminders.runReminderSweep()).toMatchObject({ status: 'disabled' });
    expect(sent).toHaveLength(0);
  });
});
