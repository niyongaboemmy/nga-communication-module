import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { randomBytes } from 'node:crypto';
import { app } from '../app.js';
import { config } from '../config.js';
import type { AccessSnapshot, CapabilityEntry } from '../vendor/nga-access/index.js';
import { __resetMisBearerAuth, __misBearerState } from '../middleware/misBearerAuth.js';
import { __resetAccessSnapshots } from '../access/snapshot.js';
import { parseSummaryInput, todayIn } from '../services/homeSummaryService.js';

/**
 * POST /api/integration/home-summary — the MIS Home page's view of Tupo.
 *
 * Runs against the real test database with the MIS mocked at `fetch`: the
 * endpoint is authenticated by the user's own MIS token (verified at MIS
 * /auth/verify), maps them by users.mis_user_id, and must never create a user
 * or write anything.
 */

// ── MIS mock ────────────────────────────────────────────────────────────────
const tokens = new Map<string, string>();                 // MIS token -> MIS user id
const snapshots = new Map<string, AccessSnapshot>();      // MIS token -> v2 snapshot
let verifyCalls = 0;
let misDown = false;
/** When set, /auth/verify answers with this instead of looking the token up. */
let verifyOverride: (() => Response) | null = null;

function installMis() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const bearer = ((init?.headers as Record<string, string> | undefined)?.Authorization ?? '').replace(/^Bearer /, '');
    if (url.endsWith('/auth/verify')) {
      verifyCalls++;
      if (misDown) throw new Error('ECONNREFUSED');
      if (verifyOverride) return verifyOverride();
      const userId = tokens.get(bearer);
      if (!userId) return new Response(JSON.stringify({ success: false, message: 'Invalid token' }), { status: 401 });
      return new Response(JSON.stringify({ success: true, data: { userId: Number(userId), access_version: 1 } }), { status: 200 });
    }
    if (url.includes('/access/me')) {
      const s = snapshots.get(bearer);
      return s
        ? new Response(JSON.stringify({ success: true, data: s }), { status: 200 })
        : new Response('{}', { status: 503 });
    }
    return new Response('{}', { status: 200 });
  }));
}

// ── fixtures ────────────────────────────────────────────────────────────────
let nextMis = 8100;
const spaceIds: string[] = [];

async function makeUser(roleName: string | null, name = 'User') {
  const pool = getPool();
  const id = snowflake();
  const misId = String(nextMis++);
  const roleId = roleName
    ? (await pool.query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [roleName])).rows[0]?.id ?? null
    : null;
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1, $2, $3, $4, 'staff', $5)`,
    [id, misId, name, `${id}@amashuri.com`, roleId],
  );
  const misToken = `mis-${misId}-${randomBytes(4).toString('hex')}`;
  tokens.set(misToken, misId);
  return { id, misId, misToken, name };
}

async function conversation(type: 'dm' | 'group', name: string | null,
  members: Array<{ userId: string; unread?: number; mentions?: number }>) {
  const pool = getPool();
  const spaceId = snowflake();
  spaceIds.push(spaceId);
  await pool.query(`INSERT INTO spaces (id, slug, name) VALUES ($1, $1, 'S')`, [spaceId]);
  const convId = snowflake();
  await pool.query(
    `INSERT INTO conversations (id, space_id, type, name, member_count) VALUES ($1, $2, $3, $4, $5)`,
    [convId, spaceId, type, name, members.length]);
  for (const m of members) {
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, unread_count, unread_mentions)
       VALUES ($1, $2, $3, $4)`, [convId, m.userId, m.unread ?? 0, m.mentions ?? 0]);
  }
  return convId;
}

async function meeting(hostId: string, title: string, o: {
  status: 'live' | 'scheduled' | 'ended'; startsInMin?: number; startsAt?: string; invite?: string[];
  declined?: string[];
}) {
  const id = snowflake();
  const code = `c-${randomBytes(5).toString('hex')}`;
  await getPool().query(
    `INSERT INTO meetings (id, host_id, title, room_name, join_code, status, scheduled_start, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, hostId, title, `room-${id}`, code, o.status,
     o.startsAt ? new Date(o.startsAt)
       : o.startsInMin !== undefined ? new Date(Date.now() + o.startsInMin * 60_000) : null,
     o.status === 'live' ? new Date() : null]);
  for (const u of o.invite ?? []) {
    await getPool().query(`INSERT INTO meeting_invites (meeting_id, user_id) VALUES ($1, $2)`, [id, u]);
  }
  for (const u of o.declined ?? []) {
    await getPool().query(
      `INSERT INTO meeting_invites (meeting_id, user_id, response) VALUES ($1, $2, 'declined')`, [id, u]);
  }
  return { id, code };
}

async function campaign(senderId: string, subject: string, status = 'pending_approval', createdBy = senderId) {
  await getPool().query(
    `INSERT INTO mail_campaigns (id, subject, from_user_id, created_by, status, requires_approval)
     VALUES ($1, $2, $3, $5, $4, true)`, [snowflake(), subject, senderId, status, createdBy]);
}

async function report(reporterId: string) {
  await getPool().query(
    `INSERT INTO feed_reports (id, target_type, target_id, reporter_id, reason) VALUES ($1, 'post', $2, $3, 'spam')`,
    [snowflake(), snowflake(), reporterId]);
}

async function notification(userId: string, kind: string, title: string, o: { read?: boolean; daysAgo?: number } = {}) {
  await getPool().query(
    `INSERT INTO notifications (id, user_id, kind, title, link, read_at, created_at)
     VALUES ($1, $2, $3, $4, '/app/mail', $5, now() - make_interval(days => $6))`,
    [snowflake(), userId, kind, title, o.read ? new Date() : null, o.daysAgo ?? 0]);
}

async function mailTo(userId: string, senderId: string) {
  const pool = getPool();
  const threadId = snowflake();
  const messageId = snowflake();
  await pool.query(`INSERT INTO mail_threads (id, subject) VALUES ($1, 'Hello')`, [threadId]);
  await pool.query(
    `INSERT INTO mail_messages (id, thread_id, from_user_id, subject, sent_at) VALUES ($1, $2, $3, 'Hello', now())`,
    [messageId, threadId, senderId]);
  await pool.query(
    `INSERT INTO mail_recipients (id, message_id, thread_id, user_id, address, kind, folder, is_read)
     VALUES ($1, $2, $3, $4, 'me@amashuri.com', 'to', 'inbox', false)`, [snowflake(), messageId, threadId, userId]);
}

const pageIds: string[] = [];

/** A feed page plus an announcement on it; who it reaches is up to the caller. */
async function announcement(authorId: string, body: string, o: {
  audience?: string; timelineFor?: string[]; mandatoryFollowers?: string[]; viewedBy?: string[];
  type?: string; status?: string; daysAgo?: number; deleted?: boolean;
} = {}) {
  const pool = getPool();
  const pageId = snowflake();
  pageIds.push(pageId);
  const mandatory = (o.mandatoryFollowers ?? []).length > 0;
  await pool.query(
    `INSERT INTO feed_pages (id, slug, name, kind, mandatory, created_by) VALUES ($1, $1, 'School Office', 'official', $2, $3)`,
    [pageId, mandatory, authorId]);
  const postId = snowflake();
  await pool.query(
    `INSERT INTO feed_posts (id, page_id, author_id, body, type, audience, status, published_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(days => $8), $9)`,
    [postId, pageId, authorId, body, o.type ?? 'announcement', o.audience ?? 'everyone', o.status ?? 'published',
     o.daysAgo ?? 0, o.deleted ? new Date() : null]);
  for (const u of o.timelineFor ?? []) {
    await pool.query(
      `INSERT INTO feed_timeline (user_id, post_id, page_id, reason) VALUES ($1, $2, $3, 'follow')`, [u, postId, pageId]);
  }
  for (const u of o.mandatoryFollowers ?? []) {
    await pool.query(
      `INSERT INTO feed_page_followers (page_id, user_id, source) VALUES ($1, $2, 'mandatory')`, [pageId, u]);
  }
  for (const u of o.viewedBy ?? []) {
    await pool.query(`INSERT INTO feed_post_views (post_id, user_id) VALUES ($1, $2)`, [postId, u]);
  }
  return postId;
}

async function scheduledMessage(senderId: string, convId: string, state: string, o: { daysAgo?: number } = {}) {
  await getPool().query(
    `INSERT INTO scheduled_messages (id, conversation_id, sender_id, body, send_at, state)
     VALUES ($1, $2, $3, 'Reminder', now() - make_interval(days => $5), $4)`,
    [snowflake(), convId, senderId, state, o.daysAgo ?? 0]);
}

async function invite(meetingId: string, userId: string, response: string) {
  await getPool().query(
    `INSERT INTO meeting_invites (meeting_id, user_id, response) VALUES ($1, $2, $3)`, [meetingId, userId, response]);
}

// ── contract ────────────────────────────────────────────────────────────────
const TIERS = ['blocking', 'slipping', 'tidy'];
const DEPTHS = ['summary', 'detail', 'write'];
const SEVERITIES = ['info', 'success', 'warning', 'critical'];
const isIso = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
const isAbsolute = (v: unknown) => typeof v === 'string' && /^https?:\/\/[^/]/.test(v);

/**
 * The HOME_SUMMARY_SPEC response shape, checked field by field. Returns the
 * problems found (empty = valid) so a failure names every one of them.
 */
function validateHomeSummary(d: any): string[] {
  const errs: string[] = [];
  const need = (cond: unknown, msg: string) => { if (!cond) errs.push(msg); };
  need(d && typeof d === 'object', 'body is an object');
  if (!d || typeof d !== 'object') return errs;
  need(d.version === 1, 'version 1');
  need(d.source === 'tupo', 'source tupo');
  need(isIso(d.generated_at), 'generated_at ISO');
  need(typeof d.provisioned === 'boolean', 'provisioned bool');
  need(isAbsolute(d.app_url), 'app_url absolute');
  need(Array.isArray(d.items), 'items array');
  need(Array.isArray(d.tiles) && d.tiles.length <= 3, 'tiles ≤ 3');
  need(Array.isArray(d.updates) && d.updates.length <= 10, 'updates ≤ 10');
  need(d.today_marks === undefined, 'no today_marks (D&A only)');

  const ids = new Set<string>();
  for (const [i, it] of (Array.isArray(d.items) ? d.items : []).entries()) {
    const at = `items[${i}]`;
    need(typeof it.id === 'string' && it.id.startsWith(`tupo:${it.kind}:`), `${at}.id`);
    need(!ids.has(it.id), `${at}.id unique`); ids.add(it.id);
    need(it.source === 'tupo', `${at}.source`);
    need(typeof it.kind === 'string' && it.kind.length > 0, `${at}.kind`);
    need(TIERS.includes(it.tier), `${at}.tier`);
    need(typeof it.lens === 'string' && it.lens.length > 0, `${at}.lens`);
    need(Array.isArray(it.via) && it.via.every((v: unknown) => typeof v === 'number'), `${at}.via`);
    need(DEPTHS.includes(it.depth), `${at}.depth`);
    need(Number.isInteger(it.count) && it.count > 0, `${at}.count`);
    need(typeof it.title === 'string' && it.title.length > 0, `${at}.title`);
    need(Array.isArray(it.entities) && it.entities.length <= 8
      && it.entities.every((e: unknown) => typeof e === 'string'), `${at}.entities ≤ 8 strings`);
    if (it.depth === 'summary') need(Array.isArray(it.entities) && it.entities.length === 0, `${at} summary => entities []`);
    need(typeof it.why === 'string' && it.why.length > 0, `${at}.why`);
    need(it.cta && typeof it.cta.label === 'string' && it.cta.external === true && isAbsolute(it.cta.href)
      && it.cta.href.startsWith(d.app_url), `${at}.cta`);
    for (const k of ['due_at', 'waiting_since']) {
      if (it[k] !== undefined && it[k] !== null) need(isIso(it[k]), `${at}.${k} ISO`);
    }
  }
  for (const [i, t] of (Array.isArray(d.tiles) ? d.tiles : []).entries()) {
    need(typeof t.id === 'string' && t.source === 'tupo' && typeof t.lens === 'string' && typeof t.label === 'string', `tiles[${i}]`);
  }
  const updateIds = new Set<string>();
  let seenRead = false;
  for (const [i, u] of (Array.isArray(d.updates) ? d.updates : []).entries()) {
    const at = `updates[${i}]`;
    need(typeof u.id === 'string' && !updateIds.has(u.id), `${at}.id unique`); updateIds.add(u.id);
    need(u.source === 'tupo', `${at}.source`);
    need(typeof u.kind === 'string' && !u.kind.startsWith('chat.'), `${at}.kind (no chat.*)`);
    need(typeof u.title === 'string', `${at}.title`);
    need(u.body === undefined || u.body === null || typeof u.body === 'string', `${at}.body`);
    need(SEVERITIES.includes(u.severity), `${at}.severity`);
    need(isIso(u.created_at) && Date.now() - Date.parse(u.created_at) <= 7 * 86_400_000 + 60_000, `${at}.created_at ≤ 7 days`);
    need(typeof u.read === 'boolean', `${at}.read`);
    if (u.read) seenRead = true; else need(!seenRead, `${at} unread before read`);
    need(u.href === undefined || u.href === null || (isAbsolute(u.href) && u.href.startsWith(d.app_url)), `${at}.href`);
  }
  if (d.provisioned) {
    const c = d.comms;
    need(c && typeof c === 'object', 'comms present when provisioned');
    if (c) {
      for (const k of ['chat_unread', 'mentions', 'mail_unread']) need(Number.isInteger(c[k]) && c[k] >= 0, `comms.${k}`);
      need(Array.isArray(c.meetings), 'comms.meetings');
      const mids = new Set<string>();
      for (const [i, m] of (Array.isArray(c.meetings) ? c.meetings : []).entries()) {
        need(typeof m.id === 'string' && !mids.has(m.id), `meetings[${i}].id unique`); mids.add(m.id);
        need(typeof m.title === 'string' && isIso(m.starts_at) && typeof m.live === 'boolean'
          && isAbsolute(m.href) && m.href.startsWith(d.app_url), `meetings[${i}]`);
      }
    }
  } else {
    need(d.items?.length === 0 && d.tiles?.length === 0 && d.updates?.length === 0, 'unprovisioned => empty lists');
  }
  return errs;
}

/** Every 200 in this suite goes through the contract check. */
function checked(res: request.Response): request.Response {
  if (res.status === 200) expect(validateHomeSummary(res.body.data)).toEqual([]);
  return res;
}

const summary = async (misToken: string, body: object = {}) => checked(
  await request(app).post('/api/integration/home-summary').set('Authorization', `Bearer ${misToken}`).send(body));

type Item = { kind: string; tier: string; count: number; lens: string; depth: string; entities: string[]; cta: { href: string } };
const item = (res: request.Response, kind: string): Item | undefined =>
  (res.body.data.items as Item[]).find((i) => i.kind === kind);

async function cleanup() {
  const pool = getPool();
  await pool.query('DELETE FROM notifications');
  if (pageIds.length) await pool.query('DELETE FROM feed_pages WHERE id = ANY($1::text[])', [pageIds.splice(0)]);
  await pool.query('DELETE FROM feed_reports');
  await pool.query('DELETE FROM mail_campaigns');
  await pool.query('DELETE FROM mail_recipients');
  await pool.query('DELETE FROM mail_messages');
  await pool.query('DELETE FROM mail_threads');
  await pool.query('DELETE FROM meetings');
  await pool.query('DELETE FROM conversations');
  if (spaceIds.length) await pool.query('DELETE FROM spaces WHERE id = ANY($1::text[])', [spaceIds.splice(0)]);
  await pool.query('DELETE FROM access_shadow_diffs');
  await pool.query('DELETE FROM users');
}

const savedMode = process.env.ACCESS_V2_MODE;

beforeEach(async () => {
  await cleanup();
  await seedRbac(getPool());
  tokens.clear();
  snapshots.clear();
  verifyCalls = 0;
  misDown = false;
  verifyOverride = null;
  __resetMisBearerAuth();
  __resetAccessSnapshots();
  installMis();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (savedMode === undefined) delete process.env.ACCESS_V2_MODE; else process.env.ACCESS_V2_MODE = savedMode;
});

afterAll(async () => {
  await cleanup();
  await closeDb();
});

// ────────────────────────────────────────────────────────────────────────────
describe('authentication', () => {
  it('answers 401 MIS_TOKEN_INVALID with no token, without calling the MIS', async () => {
    const res = await request(app).post('/api/integration/home-summary').send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MIS_TOKEN_INVALID');
    expect(verifyCalls).toBe(0);
  });

  it('answers 401 when the MIS rejects the token', async () => {
    const res = await summary('not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MIS_TOKEN_INVALID');
  });

  it('does not accept a Tupo session token in place of a MIS token', async () => {
    const u = await makeUser('Staff');
    const jwt = (await import('jsonwebtoken')).default;
    const tupoToken = jwt.sign({ id: u.id, misUserId: u.misId, name: 'x', email: '', role: 'staff' }, config.jwtSecret);
    expect((await summary(tupoToken)).status).toBe(401);
  });

  it('answers 503 when the MIS is unreachable', async () => {
    const u = await makeUser('Staff');
    misDown = true;
    const res = await summary(u.misToken);
    expect(res.status).toBe(503);
  });

  it('caches the verification, so a second call does not hit the MIS again', async () => {
    const u = await makeUser('Staff');
    expect((await summary(u.misToken)).status).toBe(200);
    expect((await summary(u.misToken)).status).toBe(200);
    expect(verifyCalls).toBe(1);
  });

  it('rate-limits one MIS user at 30 a minute', async () => {
    const u = await makeUser('Staff');
    for (let i = 0; i < 30; i++) expect((await summary(u.misToken)).status).toBe(200);
    expect((await summary(u.misToken)).status).toBe(429);
  });

  it('accepts GET with no body', async () => {
    const u = await makeUser('Staff');
    const res = checked(await request(app).get('/api/integration/home-summary').set('Authorization', `Bearer ${u.misToken}`));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ version: 1, source: 'tupo', provisioned: true });
  });
});

describe('provisioning', () => {
  it('answers provisioned:false for a MIS user who never signed in to Tupo — and creates nobody', async () => {
    tokens.set('mis-stranger', '424242');
    const before = (await getPool().query('SELECT count(*)::int AS n FROM users')).rows[0].n;

    const res = await summary('mis-stranger');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      version: 1, source: 'tupo', provisioned: false, items: [], tiles: [], updates: [],
      app_url: config.appPublicUrl,
    });
    expect(res.body.data.comms).toBeUndefined();
    const after = (await getPool().query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    expect(after).toBe(before);
  });

  it('refuses a suspended account', async () => {
    const u = await makeUser('Staff');
    await getPool().query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [u.id]);
    expect((await summary(u.misToken)).status).toBe(403);
  });
});

describe('comms and personal signals', () => {
  it('reports chat, mention and mail counts plus today\'s meetings', async () => {
    const me = await makeUser('Staff', 'Me');
    const peer = await makeUser('Staff', 'Grace Peer');
    await conversation('dm', null, [{ userId: me.id, unread: 3 }, { userId: peer.id }]);
    await conversation('group', 'S3 Maths', [{ userId: me.id, unread: 5, mentions: 2 }, { userId: peer.id }]);
    await mailTo(me.id, peer.id);
    const live = await meeting(peer.id, 'Staff briefing', { status: 'live', invite: [me.id] });
    await meeting(me.id, 'Parents evening', { status: 'scheduled', startsInMin: 5 });

    const res = await summary(me.misToken, { tz: 'UTC' });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.provisioned).toBe(true);
    expect(d.comms).toMatchObject({ chat_unread: 8, mentions: 2, mail_unread: 1 });
    expect(d.comms.meetings.map((m: { title: string }) => m.title)).toEqual(['Staff briefing', 'Parents evening']);
    expect(d.comms.meetings[0]).toMatchObject({ live: true, href: `${config.appPublicUrl}/app/meet/${live.code}` });

    const m01 = item(res, 'M-01')!;
    expect(m01).toMatchObject({ tier: 'slipping', count: 5, lens: 'SELF', depth: 'detail' });
    expect(m01.entities).toEqual(expect.arrayContaining(['S3 Maths', 'Grace Peer']));

    const m02 = item(res, 'M-02')!;
    expect(m02).toMatchObject({ tier: 'blocking', count: 2 });
    expect(m02.cta.href).toBe(`${config.appPublicUrl}/app/meet`);
    // Blocking sorts first.
    expect(d.items[0].kind).toBe('M-02');
  });

  it('M-01 is tidy with DMs but no mentions; M-02 is slipping for a meeting about to start', async () => {
    const me = await makeUser('Staff');
    const peer = await makeUser('Staff');
    await conversation('dm', null, [{ userId: me.id, unread: 1 }, { userId: peer.id }]);
    const soon = await meeting(peer.id, 'Dept meeting', { status: 'scheduled', startsInMin: 10, invite: [me.id] });
    await meeting(peer.id, 'Much later', { status: 'scheduled', startsInMin: 120, invite: [me.id] });

    const res = await summary(me.misToken);
    expect(item(res, 'M-01')).toMatchObject({ tier: 'tidy', count: 1 });
    const m02 = item(res, 'M-02')!;
    expect(m02).toMatchObject({ tier: 'slipping', count: 1, entities: ['Dept meeting'] });
    expect(m02.cta.href).toBe(`${config.appPublicUrl}/app/meet/${soon.code}`);
  });

  it('never shows another person\'s chats or meetings', async () => {
    const me = await makeUser('Staff');
    const other = await makeUser('Staff');
    const third = await makeUser('Staff');
    await conversation('dm', null, [{ userId: other.id, unread: 4 }, { userId: third.id }]);
    await conversation('group', 'Private', [{ userId: other.id, mentions: 3, unread: 3 }]);
    await meeting(other.id, 'Not mine', { status: 'live', invite: [third.id] });
    await mailTo(other.id, third.id);

    const res = await summary(me.misToken);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.comms).toEqual({ chat_unread: 0, mentions: 0, mail_unread: 0, meetings: [] });
  });

  it('lists recent notifications, unread first, without chat kinds or anything older than 7 days', async () => {
    const me = await makeUser('Staff');
    await notification(me.id, 'mail.received', 'Read mail', { read: true });
    await notification(me.id, 'meet.live', 'Briefing has started');
    await notification(me.id, 'chat.dm', 'A DM');
    await notification(me.id, 'mail.received', 'Old mail', { daysAgo: 9 });

    const res = await summary(me.misToken);
    const updates = res.body.data.updates as Array<{ title: string; read: boolean; severity: string; href: string }>;
    expect(updates.map((u) => u.title)).toEqual(['Briefing has started', 'Read mail']);
    expect(updates[0]).toMatchObject({ read: false, severity: 'warning', href: `${config.appPublicUrl}/app/mail` });
  });
});

describe('approval and moderation queues', () => {
  it('P-07: an approver sees campaigns waiting on them, but never their own', async () => {
    const approver = await makeUser('Moderator');
    const sender = await makeUser('Moderator');
    await campaign(sender.id, 'Term 2 fees reminder');
    await campaign(approver.id, 'My own send');
    await campaign(sender.id, 'Already approved', 'approved');

    const res = await summary(approver.misToken, {
      lenses: [{ key: 'SCHOOL', type: 'SCHOOL', class_group_ids: null }, { key: 'SELF', type: 'SELF', class_group_ids: [] }],
    });
    const p07 = item(res, 'P-07')!;
    expect(p07).toMatchObject({ tier: 'blocking', count: 1, lens: 'SCHOOL', depth: 'detail', entities: ['Term 2 fees reminder'] });
    expect(p07.cta.href).toBe(`${config.appPublicUrl}/app/mail/campaigns`);

    // The sender sees only the approver's send, not their own.
    const own = item(await summary(sender.misToken), 'P-07')!;
    expect(own.entities).toEqual(['My own send']);
  });

  it('P-07 and O-05 are hidden from someone without MAIL_APPROVE / MODERATION_QUEUE_VIEW', async () => {
    const staff = await makeUser('Staff');
    const sender = await makeUser('Moderator');
    await campaign(sender.id, 'Fees');
    await report(sender.id);

    const res = await summary(staff.misToken);
    expect(item(res, 'P-07')).toBeUndefined();
    expect(item(res, 'O-05')).toBeUndefined();
  });

  it('O-05: a moderator sees a count of open reports, never the content', async () => {
    const mod = await makeUser('Moderator');
    const reporter = await makeUser('Student');
    await report(reporter.id);
    await report(reporter.id);

    const res = await summary(mod.misToken);
    expect(item(res, 'O-05')).toMatchObject({ tier: 'slipping', count: 2, depth: 'summary', entities: [], lens: 'SELF' });
  });

  it('summary-depth access (v2 enforce) sends counts only — no campaign names', async () => {
    process.env.ACCESS_V2_MODE = 'enforce';
    const approver = await makeUser('Moderator');
    const sender = await makeUser('Moderator');
    await campaign(sender.id, 'Confidential subject');
    const summaryGrant: CapabilityEntry[] = [{ depth: 'summary', scope: { all: true }, via: [7] }];
    snapshots.set(approver.misToken, {
      v: 1, app: 'tupo', core: '1.0.0',
      user: { id: Number(approver.misId), persona: 'STAFF', school_id: 1 },
      year: 5, caps: { MAIL_APPROVE: summaryGrant }, grants: {}, home: null, systems: ['tupo'],
      generated_at: new Date().toISOString(),
    } as AccessSnapshot);

    const res = await summary(approver.misToken);
    expect(res.status).toBe(200);
    expect(item(res, 'P-07')).toMatchObject({ count: 1, depth: 'summary', entities: [] });
    // Enforce swaps in the v2 set: MODERATION_QUEUE_VIEW is not held there.
    expect(item(res, 'O-05')).toBeUndefined();
  });
});

describe('quick reminders', () => {
  it('M-03: unread inbox mail is a tidy item linking to mail, with no subjects (no extra query)', async () => {
    const me = await makeUser('Staff');
    const peer = await makeUser('Staff');
    await mailTo(me.id, peer.id);
    await mailTo(me.id, peer.id);
    const res = await summary(me.misToken);
    expect(item(res, 'M-03')).toMatchObject({
      tier: 'tidy', count: 2, lens: 'SELF', depth: 'detail', entities: [],
      cta: { href: `${config.appPublicUrl}/app/mail` },
    });
    expect(res.body.data.comms.mail_unread).toBe(2);
  });

  it('M-03: read mail and other people\'s mail do not count', async () => {
    const me = await makeUser('Staff');
    const other = await makeUser('Staff');
    await mailTo(other.id, me.id);
    await mailTo(me.id, other.id);
    await getPool().query(`UPDATE mail_recipients SET is_read = true WHERE user_id = $1`, [me.id]);
    expect(item(await summary(me.misToken), 'M-03')).toBeUndefined();
  });

  it('M-04: pending invitations to upcoming meetings; slipping within 24 h, single meeting deep-links', async () => {
    const me = await makeUser('Staff');
    const host = await makeUser('Staff');
    const later = await meeting(host.id, 'Termly review', { status: 'scheduled', startsInMin: 3 * 24 * 60, invite: [me.id] });
    let res = await summary(me.misToken);
    let m04 = item(res, 'M-04')! as Item & { due_at: string };
    expect(m04).toMatchObject({ tier: 'tidy', count: 1, lens: 'SELF', depth: 'detail', entities: ['Termly review'] });
    expect(m04.cta.href).toBe(`${config.appPublicUrl}/app/meet/${later.code}`);

    await meeting(host.id, 'Dept sync', { status: 'scheduled', startsInMin: 120, invite: [me.id] });
    res = await summary(me.misToken);
    m04 = item(res, 'M-04')! as Item & { due_at: string };
    expect(m04).toMatchObject({ tier: 'slipping', count: 2, entities: ['Dept sync', 'Termly review'] });
    expect(m04.cta.href).toBe(`${config.appPublicUrl}/app/meet`);
    expect(Date.parse(m04.due_at) - Date.now()).toBeGreaterThan(110 * 60_000);
    expect(Date.parse(m04.due_at) - Date.now()).toBeLessThan(121 * 60_000);
  });

  it('M-04: answered, past, live, cancelled, hosted and other people\'s invitations are not shown', async () => {
    const me = await makeUser('Staff');
    const host = await makeUser('Staff');
    const other = await makeUser('Staff');
    const declined = await meeting(host.id, 'Declined', { status: 'scheduled', startsInMin: 60 });
    await invite(declined.id, me.id, 'declined');
    const accepted = await meeting(host.id, 'Accepted', { status: 'scheduled', startsInMin: 60 });
    await invite(accepted.id, me.id, 'accepted');
    const tentative = await meeting(host.id, 'Tentative', { status: 'scheduled', startsInMin: 60 });
    await invite(tentative.id, me.id, 'tentative');
    await meeting(host.id, 'Already started', { status: 'scheduled', startsInMin: -30, invite: [me.id] });
    await meeting(host.id, 'Live', { status: 'live', invite: [me.id] });
    const cancelled = await meeting(host.id, 'Cancelled', { status: 'scheduled', startsInMin: 60, invite: [me.id] });
    await getPool().query(`UPDATE meetings SET status = 'cancelled' WHERE id = $1`, [cancelled.id]);
    await meeting(me.id, 'Mine', { status: 'scheduled', startsInMin: 60, invite: [me.id] });
    await meeting(host.id, 'Not for me', { status: 'scheduled', startsInMin: 60, invite: [other.id] });
    expect(item(await summary(me.misToken), 'M-04')).toBeUndefined();
  });

  it('M-06: failed scheduled messages of the last week, labelled by conversation', async () => {
    const me = await makeUser('Staff');
    const peer = await makeUser('Staff', 'Grace Peer');
    const dm = await conversation('dm', null, [{ userId: me.id }, { userId: peer.id }]);
    const group = await conversation('group', 'S3 Maths', [{ userId: me.id }, { userId: peer.id }]);
    await scheduledMessage(me.id, dm, 'failed');
    await scheduledMessage(me.id, group, 'failed', { daysAgo: 2 });
    const m06 = item(await summary(me.misToken), 'M-06')!;
    expect(m06).toMatchObject({
      tier: 'slipping', count: 2, lens: 'SELF', depth: 'detail',
      cta: { href: `${config.appPublicUrl}/app/chat` },
    });
    expect(m06.entities).toEqual(['Grace Peer', 'S3 Maths']);
  });

  it('M-06: pending, sent, cancelled, old and other people\'s scheduled messages are not shown', async () => {
    const me = await makeUser('Staff');
    const peer = await makeUser('Staff');
    const conv = await conversation('group', 'G', [{ userId: me.id }, { userId: peer.id }]);
    await scheduledMessage(me.id, conv, 'pending');
    await scheduledMessage(me.id, conv, 'sent');
    await scheduledMessage(me.id, conv, 'cancelled');
    await scheduledMessage(me.id, conv, 'failed', { daysAgo: 10 });
    await scheduledMessage(peer.id, conv, 'failed');
    expect(item(await summary(me.misToken), 'M-06')).toBeUndefined();
  });

  it('F-01: unseen announcements from the timeline and from mandatory pages, newest first', async () => {
    const me = await makeUser('Staff');
    const office = await makeUser('Staff');
    await announcement(office.id, '<p>Sports day moved to <b>Friday</b> &amp; uniforms</p><p>Details inside</p>',
      { timelineFor: [me.id], daysAgo: 2 });
    await announcement(office.id, 'Term dates\nfor 2027', { mandatoryFollowers: [me.id], daysAgo: 1 });
    const res = await summary(me.misToken);
    const f01 = item(res, 'F-01')! as Item & { waiting_since: string };
    expect(f01).toMatchObject({
      tier: 'slipping', count: 2, lens: 'SELF', depth: 'detail',
      entities: ['Term dates', 'Sports day moved to Friday & uniforms'],
      cta: { href: `${config.appPublicUrl}/app/feed` },
    });
    expect(Date.now() - Date.parse(f01.waiting_since)).toBeGreaterThan(47 * 3_600_000);
  });

  it('F-01: one unseen announcement links straight to the post; a long first line is trimmed', async () => {
    const me = await makeUser('Staff');
    const office = await makeUser('Staff');
    const postId = await announcement(office.id, 'x'.repeat(200), { timelineFor: [me.id] });
    const f01 = item(await summary(me.misToken), 'F-01')!;
    expect(f01.count).toBe(1);
    expect(f01.cta.href).toBe(`${config.appPublicUrl}/app/feed/post/${postId}`);
    expect(f01.entities[0]!.length).toBeLessThanOrEqual(80);
  });

  it('F-01: viewed, old, deleted, draft, ordinary, own, unaddressed and out-of-audience posts are not shown', async () => {
    const me = await makeUser('Student');
    const office = await makeUser('Staff');
    const other = await makeUser('Staff');
    await announcement(office.id, 'Already read', { timelineFor: [me.id], viewedBy: [me.id] });
    await announcement(office.id, 'Old news', { timelineFor: [me.id], daysAgo: 20 });
    await announcement(office.id, 'Deleted', { timelineFor: [me.id], deleted: true });
    await announcement(office.id, 'Draft', { timelineFor: [me.id], status: 'draft' });
    await announcement(office.id, 'Just a post', { timelineFor: [me.id], type: 'standard' });
    await announcement(me.id, 'My own', { timelineFor: [me.id] });
    await announcement(office.id, 'For someone else', { timelineFor: [other.id] });
    await announcement(office.id, 'Staff only', { timelineFor: [me.id], audience: 'staff' });
    await announcement(office.id, 'Parents only', { mandatoryFollowers: [me.id], audience: 'parents' });
    const res = await summary(me.misToken);
    expect(item(res, 'F-01')).toBeUndefined();
    // Staff see every band, so the same staff-only post does reach a staff member.
    await announcement(office.id, 'Staff only', { timelineFor: [other.id], audience: 'staff' });
    expect(item(await summary(other.misToken), 'F-01')).toMatchObject({ count: 2 });
  });

  it('P-08: my rejected drafts and failed sends, never anyone else\'s', async () => {
    const me = await makeUser('Moderator');
    const other = await makeUser('Moderator');
    await campaign(me.id, 'Fees reminder', 'draft');
    await getPool().query(`UPDATE mail_campaigns SET rejected_reason = 'Wrong amount' WHERE subject = 'Fees reminder'`);
    await campaign(me.id, 'Trip letter', 'failed');
    await campaign(me.id, 'Plain draft', 'draft');
    await campaign(me.id, 'Delivered', 'sent');
    await campaign(me.id, 'Old failure', 'failed');
    await getPool().query(`UPDATE mail_campaigns SET updated_at = now() - interval '30 days' WHERE subject = 'Old failure'`);
    await campaign(other.id, 'Theirs', 'failed');
    const p08 = item(await summary(me.misToken), 'P-08')! as Item & { title: string };
    expect(p08).toMatchObject({
      tier: 'slipping', count: 2, lens: 'SELF', depth: 'detail',
      cta: { href: `${config.appPublicUrl}/app/mail/campaigns` },
    });
    expect(p08.entities.sort()).toEqual(['Fees reminder', 'Trip letter']);
    expect(p08.title).toBe('1 bulk mail send sent back by an approver and 1 bulk mail send failed');
  });

  it('P-08 is hidden from someone who cannot open the campaigns screen', async () => {
    const staff = await makeUser('Staff');
    await campaign(staff.id, 'Somehow mine', 'failed');
    expect(item(await summary(staff.misToken), 'P-08')).toBeUndefined();
  });

  it('a busy account orders the new reminders by tier: blocking, then slipping, then tidy', async () => {
    const me = await makeUser('Moderator');
    const host = await makeUser('Staff');
    const peer = await makeUser('Staff');
    await meeting(host.id, 'Live now', { status: 'live', invite: [me.id] });
    await meeting(host.id, 'Next week', { status: 'scheduled', startsInMin: 7 * 24 * 60, invite: [me.id] });
    await mailTo(me.id, peer.id);
    await announcement(peer.id, 'Notice', { timelineFor: [me.id] });
    const kinds = ((await summary(me.misToken)).body.data.items as Item[]).map((i) => `${i.kind}:${i.tier}`);
    expect(kinds).toEqual(['M-02:blocking', 'F-01:slipping', 'M-04:tidy', 'M-03:tidy']);
  });
});

describe('read-only', () => {
  it('does not mark anything read or write any row', async () => {
    const me = await makeUser('Moderator');
    const peer = await makeUser('Staff');
    await conversation('group', 'G', [{ userId: me.id, unread: 2, mentions: 1 }]);
    await notification(me.id, 'mail.received', 'New mail');
    await mailTo(me.id, peer.id);
    const snap = async () => (await getPool().query(`
      SELECT (SELECT count(*) FROM users)::int AS users,
             (SELECT count(*) FROM notifications WHERE read_at IS NULL)::int AS unread_notes,
             (SELECT sum(unread_count) FROM conversation_members)::int AS unread_chat,
             (SELECT count(*) FROM mail_recipients WHERE NOT is_read)::int AS unread_mail,
             (SELECT count(*) FROM audit_log)::int AS audits`)).rows[0];

    const before = await snap();
    expect((await summary(me.misToken)).status).toBe(200);
    expect(await snap()).toEqual(before);
  });
});

describe('input parsing', () => {
  it('falls back to Kigali today for a bad date or zone, and keeps valid lens hints', () => {
    const p = parseSummaryInput({ date: 'yesterday', tz: 'Mars/Olympus', lenses: [{ key: 'SCHOOL', type: 'school', class_group_ids: null }, 'junk'] });
    expect(p.tz).toBe('Africa/Kigali');
    expect(p.date).toBe(todayIn('Africa/Kigali'));
    expect(p.lenses).toEqual([{ key: 'SCHOOL', type: 'SCHOOL', class_group_ids: null }]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Hardening: each case below pins down one reviewed failure mode.
// ────────────────────────────────────────────────────────────────────────────

const json = (status: number, body: unknown) =>
  () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('hardening: MIS verification and the token cache', () => {
  it('keys the cache on the whole token: two tokens sharing a long prefix stay two people', async () => {
    const a = await makeUser('Staff', 'Alice');
    const b = await makeUser('Staff', 'Bob');
    const prefix = 'x'.repeat(300);
    tokens.set(`${prefix}A`, a.misId);
    tokens.set(`${prefix}B`, b.misId);
    await notification(a.id, 'mail.received', 'For Alice');

    expect((await summary(`${prefix}A`)).body.data.updates.map((u: { title: string }) => u.title)).toEqual(['For Alice']);
    expect((await summary(`${prefix}B`)).body.data.updates).toEqual([]);
    expect(verifyCalls).toBe(2);
  });

  it('never caches a MIS 401: the same token is asked about again next time', async () => {
    const u = await makeUser('Staff');
    tokens.delete(u.misToken);
    expect((await summary(u.misToken)).status).toBe(401);
    expect((await summary(u.misToken)).status).toBe(401);
    expect(verifyCalls).toBe(2);
  });

  it('stops honouring a revoked token once the 60 s cache entry expires', async () => {
    const u = await makeUser('Staff');
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    expect((await summary(u.misToken)).status).toBe(200);
    tokens.delete(u.misToken);                         // revoked at the MIS

    clock.mockReturnValue(t0 + 59_000);
    expect((await summary(u.misToken)).status).toBe(200);   // still cached
    clock.mockReturnValue(t0 + 61_000);
    expect((await summary(u.misToken)).status).toBe(401);
  });

  it.each([404, 429, 500, 502, 503])('answers 503 (not 401) for a MIS %i, and does not cache it', async (status) => {
    const u = await makeUser('Staff');
    verifyOverride = json(status, { success: false, message: 'upstream' });
    const res = await summary(u.misToken);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MIS_UNREACHABLE');
    verifyOverride = null;
    expect((await summary(u.misToken)).status).toBe(200);
    expect(verifyCalls).toBe(2);
  });

  it('answers 503 for a MIS 200 whose body is not JSON (a proxy error page), and does not cache it', async () => {
    const u = await makeUser('Staff');
    verifyOverride = json(200, '<html>Bad gateway</html>');
    expect((await summary(u.misToken)).status).toBe(503);
    verifyOverride = null;
    expect((await summary(u.misToken)).status).toBe(200);
  });

  it('treats a MIS 200 that names no usable user id as an invalid token', async () => {
    for (const userId of [{ id: 1 }, [1], true, '', null]) {
      verifyOverride = json(200, { success: true, data: { userId } });
      const res = await summary('some-token');
      expect(res.status).toBe(401);
    }
  });

  it('error bodies carry no internals: no MIS URL, stack or driver message', async () => {
    const u = await makeUser('Staff');
    misDown = true;
    const down = await summary(u.misToken);
    expect(down.status).toBe(503);
    const text = JSON.stringify(down.body);
    expect(text).not.toContain(config.misBaseUrl);
    expect(text).not.toMatch(/ECONNREFUSED|stack|at \w+ \(/);
    expect(Object.keys(down.body).sort()).toEqual(['code', 'message', 'success']);
  });

  it('rate-limits per MIS user after auth: bad tokens and other users do not spend my budget', async () => {
    const me = await makeUser('Staff');
    const other = await makeUser('Staff');
    for (let i = 0; i < 40; i++) expect((await summary(`bad-${i}`)).status).toBe(401);
    for (let i = 0; i < 30; i++) expect((await summary(other.misToken)).status).toBe(200);
    expect((await summary(me.misToken)).status).toBe(200);
  });

  it('keeps the rate window bounded while a user keeps hammering past the limit', async () => {
    const u = await makeUser('Staff');
    for (let i = 0; i < 60; i++) await summary(u.misToken);
    expect(__misBearerState().rateEntries(u.misId)).toBeLessThanOrEqual(31);
  });
});

describe('hardening: scope', () => {
  it('lens hints never widen access: a SCHOOL lens does not show P-07 / O-05 to plain staff', async () => {
    const staff = await makeUser('Staff');
    const sender = await makeUser('Moderator');
    await campaign(sender.id, 'Fees');
    await report(sender.id);
    const res = await summary(staff.misToken, {
      lenses: [
        { key: 'SCHOOL', type: 'SCHOOL', class_group_ids: null },
        { key: 'PROGRAM:1', type: 'PROGRAM', class_group_ids: [1, 2, 3] },
        { key: 'CLASS_GROUP:1', type: 'CLASS_GROUP', class_group_ids: [1] },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it('P-07 leaves out a campaign sent in the viewer\'s own name, even if someone else drafted it', async () => {
    const approver = await makeUser('Moderator');
    const assistant = await makeUser('Moderator');
    await campaign(approver.id, 'Head teacher letter', 'pending_approval', assistant.id);
    const res = await summary(approver.misToken);
    expect(item(res, 'P-07')).toBeUndefined();
  });

  it('meetings: a declined invite, an ended meeting and someone else\'s meeting are not listed', async () => {
    const me = await makeUser('Staff');
    const host = await makeUser('Staff');
    await meeting(host.id, 'Declined', { status: 'live', declined: [me.id] });
    await meeting(host.id, 'Declined soon', { status: 'scheduled', startsInMin: 5, declined: [me.id] });
    await meeting(me.id, 'Over', { status: 'ended', startsInMin: -30 });
    await meeting(host.id, 'Not invited', { status: 'scheduled', startsInMin: 5 });
    const res = await summary(me.misToken);
    expect(res.body.data.comms.meetings).toEqual([]);
    expect(item(res, 'M-02')).toBeUndefined();
  });
});

describe('hardening: time zones', () => {
  // The date the MIS asks about, in Kigali (UTC+2): 2030-03-15.
  const kigaliDay = { date: '2030-03-15', tz: 'Africa/Kigali' };

  it('"today" is the Kigali day, not the UTC one', async () => {
    const me = await makeUser('Staff');
    await meeting(me.id, 'Late 23:30 Kigali', { status: 'scheduled', startsAt: '2030-03-15T21:30:00Z' });
    await meeting(me.id, 'Early 00:30 Kigali', { status: 'scheduled', startsAt: '2030-03-14T22:30:00Z' });
    await meeting(me.id, 'Next day 00:30 Kigali', { status: 'scheduled', startsAt: '2030-03-15T22:30:00Z' });
    await meeting(me.id, 'Previous day 23:30 Kigali', { status: 'scheduled', startsAt: '2030-03-14T21:30:00Z' });

    const res = await summary(me.misToken, kigaliDay);
    expect(res.body.data.comms.meetings.map((m: { title: string }) => m.title))
      .toEqual(['Early 00:30 Kigali', 'Late 23:30 Kigali']);
  });

  it('defaults to today in Kigali when no date is sent', async () => {
    const me = await makeUser('Staff');
    const today = todayIn('Africa/Kigali');
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    // 23:59 Kigali today / 00:01 Kigali tomorrow.
    await meeting(me.id, 'Tonight', { status: 'scheduled', startsAt: `${today}T21:59:00Z` });
    await meeting(me.id, 'Tomorrow', { status: 'scheduled', startsAt: `${tomorrow}T22:01:00Z` });
    const titles = (await summary(me.misToken)).body.data.comms.meetings.map((m: { title: string }) => m.title);
    expect(titles).toContain('Tonight');
    expect(titles).not.toContain('Tomorrow');
  });

  it('reads a UTC-offset zone the way Intl does (east of UTC is +)', async () => {
    const me = await makeUser('Staff');
    await meeting(me.id, 'Late', { status: 'scheduled', startsAt: '2030-03-15T21:30:00Z' });
    await meeting(me.id, 'Early', { status: 'scheduled', startsAt: '2030-03-14T22:30:00Z' });
    const res = await summary(me.misToken, { date: '2030-03-15', tz: '+02:00' });
    expect(res.status).toBe(200);
    expect(res.body.data.comms.meetings.map((m: { title: string }) => m.title)).toEqual(['Early', 'Late']);
  });

  it.each([
    ['an impossible date', { date: '2026-02-31' }],
    ['a zone Intl knows but Postgres may not', { tz: 'US/Pacific-New' }],
    ['a date far out of range', { date: '0000-01-01' }],
  ])('tolerates %s (no 500)', async (_label, body) => {
    const me = await makeUser('Staff');
    const res = await summary(me.misToken, body);
    expect(res.status).toBe(200);
  });
});

describe('hardening: signal rules', () => {
  it('M-02 window: 14 min in is "soon", 16 min is not; a live meeting is blocking', async () => {
    const me = await makeUser('Staff');
    await meeting(me.id, 'In 14', { status: 'scheduled', startsInMin: 14 });
    await meeting(me.id, 'In 16', { status: 'scheduled', startsInMin: 16 });
    let m02 = item(await summary(me.misToken), 'M-02')!;
    expect(m02).toMatchObject({ tier: 'slipping', count: 1, entities: ['In 14'] });

    const host = await makeUser('Staff');
    await meeting(host.id, 'Live one', { status: 'live', invite: [me.id] });
    m02 = item(await summary(me.misToken), 'M-02')!;
    expect(m02).toMatchObject({ tier: 'blocking', count: 2 });
    expect(m02.entities[0]).toBe('Live one');
  });

  it('counts past the entity cap: 25 meetings -> count 25, 8 chips, plural title', async () => {
    const me = await makeUser('Staff');
    for (let i = 0; i < 25; i++) await meeting(me.id, `M${i}`, { status: 'scheduled', startsInMin: 5 });
    const m02 = item(await summary(me.misToken), 'M-02')! as Item & { title: string };
    expect(m02.count).toBe(25);
    expect(m02.entities).toHaveLength(8);
    expect(m02.title).toMatch(/^25 meetings /);
  });

  it('M-01 counts every unread DM, not only the first 50 conversations', async () => {
    const me = await makeUser('Staff');
    const peer = await makeUser('Staff');
    await bulkDms(me.id, peer.id, 60);
    const m01 = item(await summary(me.misToken), 'M-01')! as Item & { title: string };
    expect(m01.count).toBe(60);
    expect(m01.title).toBe('60 unread direct messages');
    expect(m01.entities.length).toBeLessThanOrEqual(8);
  });

  it('P-07 counts every pending campaign, not only the first 100; singular title for one', async () => {
    const approver = await makeUser('Moderator');
    const sender = await makeUser('Moderator');
    await getPool().query(
      `INSERT INTO mail_campaigns (id, subject, from_user_id, created_by, status, requires_approval)
       SELECT 'bulk-' || g, 'Send ' || g, $1, $1, 'pending_approval', true FROM generate_series(1, 120) g`, [sender.id]);
    let p07 = item(await summary(approver.misToken), 'P-07')! as Item & { title: string };
    expect(p07.count).toBe(120);
    expect(p07.entities).toHaveLength(8);
    expect(p07.title).toBe('120 bulk mail sends waiting for your approval');

    await getPool().query(`DELETE FROM mail_campaigns WHERE id <> 'bulk-1'`);
    p07 = item(await summary(approver.misToken), 'P-07')! as Item & { title: string };
    expect(p07.title).toBe('1 bulk mail send waiting for your approval');
  });

  it('item, update and meeting ids are stable across calls and unique within one', async () => {
    const me = await makeUser('Moderator');
    const peer = await makeUser('Staff');
    await conversation('group', 'G', [{ userId: me.id, unread: 2, mentions: 1 }]);
    await meeting(me.id, 'Soon', { status: 'scheduled', startsInMin: 5 });
    await campaign(peer.id, 'Fees');
    await report(peer.id);
    for (let i = 0; i < 3; i++) await notification(me.id, 'mail.received', `N${i}`);
    const body = { lenses: [{ key: 'SCHOOL', type: 'SCHOOL', class_group_ids: null }] };
    const ids = (d: any) => [...d.items.map((i: any) => i.id), ...d.updates.map((u: any) => u.id),
      ...d.comms.meetings.map((m: any) => m.id)];
    const first = ids((await summary(me.misToken, body)).body.data);
    const second = ids((await summary(me.misToken, body)).body.data);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
    expect(first).toEqual(expect.arrayContaining(['tupo:M-01:SELF', 'tupo:M-02:SELF', 'tupo:P-07:SCHOOL', 'tupo:O-05:SCHOOL']));
  });

  it('updates: at most 10, every unread one before any read one', async () => {
    const me = await makeUser('Staff');
    for (let i = 0; i < 6; i++) await notification(me.id, 'mail.received', `Read ${i}`, { read: true });
    for (let i = 0; i < 12; i++) await notification(me.id, 'feed.comment', `Unread ${i}`, { daysAgo: 1 });
    await notification(me.id, 'chat.mention', 'Chat');
    const updates = (await summary(me.misToken)).body.data.updates as Array<{ read: boolean }>;
    expect(updates).toHaveLength(10);
    expect(updates.every((u) => !u.read)).toBe(true);
  });

  it('an empty account answers with empty everything', async () => {
    const me = await makeUser('Staff');
    const d = (await summary(me.misToken)).body.data;
    expect(d).toMatchObject({ provisioned: true, items: [], tiles: [], updates: [],
      comms: { chat_unread: 0, mentions: 0, mail_unread: 0, meetings: [] } });
  });
});

describe('hardening: lenient input', () => {
  it.each([
    ['lenses as a string', { lenses: 'SCHOOL' }],
    ['lenses full of junk', { lenses: [null, 1, 'x', { key: 5 }, { key: 'K', type: 9 }, { key: 'K', type: 'SCHOOL', class_group_ids: 'all' }] }],
    ['numbers where strings go', { date: 20260927, tz: 3 }],
    ['nested objects', { date: { $gt: '' }, tz: ['Africa/Kigali'] }],
    ['SQL in every string', { date: "2026-09-27'; DROP TABLE users; --", tz: "UTC'; DELETE FROM users; --",
      lenses: [{ key: "'; DROP TABLE users; --", type: 'SCHOOL', class_group_ids: null }] }],
  ])('%s -> 200', async (_label, body) => {
    const me = await makeUser('Moderator');
    const res = await summary(me.misToken, body);
    expect(res.status).toBe(200);
    expect((await getPool().query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBeGreaterThan(0);
  });

  it('a body that is not JSON is a 400, not a 500', async () => {
    const me = await makeUser('Staff');
    const res = await request(app).post('/api/integration/home-summary')
      .set('Authorization', `Bearer ${me.misToken}`).set('Content-Type', 'application/json').send('{"lenses":');
    expect(res.status).toBe(400);
  });

  it('truncates oversized hint arrays: 50 lenses, 500 class groups per lens, short keys and types', () => {
    const p = parseSummaryInput({
      lenses: Array.from({ length: 500 }, (_, i) => ({
        key: `K${i}${'k'.repeat(200)}`, type: 't'.repeat(200),
        class_group_ids: Array.from({ length: 5_000 }, (_, j) => j),
      })),
    });
    expect(p.lenses).toHaveLength(50);
    for (const l of p.lenses) {
      expect(l.key.length).toBeLessThanOrEqual(64);
      expect(l.type.length).toBeLessThanOrEqual(32);
      expect(l.class_group_ids!.length).toBeLessThanOrEqual(500);
    }
  });

  it('keeps only whole positive class-group ids', () => {
    const p = parseSummaryInput({ lenses: [{ key: 'K', type: 'PROGRAM', class_group_ids: [9, '12', 1.5, -3, true, null, 'x', 41] }] });
    expect(p.lenses[0]!.class_group_ids).toEqual([9, 12, 41]);
  });
});

describe('hardening: performance', () => {
  it('the query count does not grow with the data (no N+1), and 200-row fixtures stay fast', async () => {
    const empty = await makeUser('Moderator');
    const busy = await makeUser('Moderator');
    const peer = await makeUser('Staff');
    const pool = getPool();

    const countQueries = async (token: string) => {
      const spy = vi.spyOn(pool, 'query');
      const started = Date.now();
      const res = await summary(token, { lenses: [{ key: 'SCHOOL', type: 'SCHOOL', class_group_ids: null }] });
      const ms = Date.now() - started;
      const n = spy.mock.calls.length;
      spy.mockRestore();
      expect(res.status).toBe(200);
      return { n, ms, res };
    };
    const baseline = await countQueries(empty.misToken);

    await bulkDms(busy.id, peer.id, 200);
    await pool.query(
      `INSERT INTO notifications (id, user_id, kind, title, link, created_at)
       SELECT 'perf-n-' || g, $1, 'mail.received', 'N ' || g, '/app/mail', now() - make_interval(mins => g)
         FROM generate_series(1, 200) g`, [busy.id]);
    await pool.query(
      `INSERT INTO meetings (id, host_id, title, room_name, join_code, status, scheduled_start)
       SELECT 'perf-m-' || g, $1, 'Meeting ' || g, 'perf-room-' || g, 'perf-code-' || g, 'scheduled',
              now() + make_interval(mins => g % 10)
         FROM generate_series(1, 200) g`, [busy.id]);
    await pool.query(
      `INSERT INTO mail_campaigns (id, subject, from_user_id, created_by, status, requires_approval)
       SELECT 'perf-c-' || g, 'Send ' || g, $1, $1, 'pending_approval', true FROM generate_series(1, 200) g`, [peer.id]);
    await pool.query(
      `INSERT INTO feed_reports (id, target_type, target_id, reporter_id, reason)
       SELECT 'perf-r-' || g, 'post', 'perf-t-' || g, $1, 'spam' FROM generate_series(1, 200) g`, [peer.id]);

    await pool.query(
      `INSERT INTO meetings (id, host_id, title, room_name, join_code, status, scheduled_start)
       SELECT 'perf-i-' || g, $1, 'Invite ' || g, 'perf-iroom-' || g, 'perf-icode-' || g, 'scheduled',
              now() + make_interval(days => 2, mins => g)
         FROM generate_series(1, 200) g`, [peer.id]);
    await pool.query(
      `INSERT INTO meeting_invites (meeting_id, user_id) SELECT 'perf-i-' || g, $1 FROM generate_series(1, 200) g`,
      [busy.id]);
    await pool.query(
      `INSERT INTO mail_campaigns (id, subject, from_user_id, created_by, status, rejected_reason)
       SELECT 'perf-own-' || g, 'Mine ' || g, $1, $1, 'draft', 'No' FROM generate_series(1, 200) g`, [busy.id]);
    const perfConv = await conversation('group', 'Perf', [{ userId: busy.id }, { userId: peer.id }]);
    await pool.query(
      `INSERT INTO scheduled_messages (id, conversation_id, sender_id, body, send_at, state)
       SELECT 'perf-s-' || g, $1, $2, 'B', now() - make_interval(mins => g), 'failed' FROM generate_series(1, 200) g`,
      [perfConv, busy.id]);
    const perfPage = snowflake();
    pageIds.push(perfPage);
    await pool.query(`INSERT INTO feed_pages (id, slug, name, mandatory) VALUES ($1, $1, 'Perf', true)`, [perfPage]);
    await pool.query(`INSERT INTO feed_page_followers (page_id, user_id) VALUES ($1, $2)`, [perfPage, busy.id]);
    await pool.query(
      `INSERT INTO feed_posts (id, page_id, author_id, body, type, published_at)
       SELECT 'perf-p-' || g, $1, $2, 'Notice ' || g, 'announcement', now() - make_interval(mins => g)
         FROM generate_series(1, 200) g`, [perfPage, peer.id]);
    for (let i = 0; i < 3; i++) await mailTo(busy.id, peer.id);

    const loaded = await countQueries(busy.misToken);
    expect(loaded.n).toBe(baseline.n);
    expect(loaded.n).toBeLessThanOrEqual(15);
    expect(loaded.ms).toBeLessThan(2_000);
    const d = loaded.res.body.data;
    expect(item(loaded.res, 'M-01')!.count).toBe(200);
    expect(item(loaded.res, 'M-02')!.count).toBe(200);
    expect(item(loaded.res, 'P-07')!.count).toBe(200);
    expect(item(loaded.res, 'O-05')!.count).toBe(200);
    expect(item(loaded.res, 'M-03')!.count).toBe(3);
    expect(item(loaded.res, 'M-04')!.count).toBe(200);
    expect(item(loaded.res, 'M-06')!.count).toBe(200);
    expect(item(loaded.res, 'F-01')!.count).toBe(200);
    expect(item(loaded.res, 'P-08')!.count).toBe(200);
    expect(d.updates).toHaveLength(10);
    expect(d.comms.meetings.length).toBeLessThanOrEqual(10);
  });
});

/** `n` one-message DMs between two people, inserted in one statement each. */
async function bulkDms(userId: string, peerId: string, n: number) {
  const pool = getPool();
  const spaceId = snowflake();
  spaceIds.push(spaceId);
  await pool.query(`INSERT INTO spaces (id, slug, name) VALUES ($1, $1, 'S')`, [spaceId]);
  await pool.query(
    `INSERT INTO conversations (id, space_id, type, member_count)
     SELECT $1 || '-' || g, $1, 'dm', 2 FROM generate_series(1, $2::int) g`, [spaceId, n]);
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, unread_count, unread_mentions)
     SELECT $1 || '-' || g, $3, 1, 0 FROM generate_series(1, $2::int) g
     UNION ALL
     SELECT $1 || '-' || g, $4, 0, 0 FROM generate_series(1, $2::int) g`, [spaceId, n, userId, peerId]);
}

describe('hardening: second review', () => {
  it('bounds the MIS /auth/verify call with a timeout (a hung MIS cannot hold the request open)', async () => {
    const u = await makeUser('Staff');
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await summary(u.misToken);
    const verify = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/auth/verify'));
    expect(verify?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('a hung MIS verify answers 503, not a hang', async () => {
    const u = await makeUser('Staff');
    vi.stubGlobal('fetch', vi.fn((url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith('/auth/verify')) return Promise.resolve(new Response('{}', { status: 200 }));
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }));
    const saved = process.env.MIS_VERIFY_TIMEOUT_MS;
    process.env.MIS_VERIFY_TIMEOUT_MS = '50';
    try {
      const res = await summary(u.misToken);
      expect(res.status).toBe(503);
    } finally {
      if (saved === undefined) delete process.env.MIS_VERIFY_TIMEOUT_MS; else process.env.MIS_VERIFY_TIMEOUT_MS = saved;
    }
  });

  it('reads the bearer like the other satellites: any case, surrounding spaces, oversized refused unasked', async () => {
    const u = await makeUser('Staff');
    const send = (header: string) => request(app).post('/api/integration/home-summary').set('Authorization', header).send({});
    expect(checked(await send(`bearer ${u.misToken}`)).status).toBe(200);
    expect(checked(await send(`Bearer   ${u.misToken}  `)).status).toBe(200);
    const before = verifyCalls;
    const res = await send(`Bearer ${'x'.repeat(5000)}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MIS_TOKEN_INVALID');
    expect(verifyCalls).toBe(before);
  });

  it('M-01 labels an unnamed group chat as a group, never as a direct message', async () => {
    const me = await makeUser('Staff');
    const other = await makeUser('Staff', 'Peer Person');
    await conversation('group', null, [{ userId: me.id, mentions: 2 }, { userId: other.id }]);
    const m01 = item(await summary(me.misToken), 'M-01')!;
    expect(m01.entities).toEqual(['Group chat']);
  });
});
