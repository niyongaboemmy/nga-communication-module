import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { app } from '../app.js';
import { config } from '../config.js';
import type { AccessSnapshot, CapabilityEntry, Depth, ScopeEntry } from '../vendor/nga-access/index.js';
import { __resetAccessSnapshots } from '../access/snapshot.js';
import { __resetShadowThrottle } from '../access/shadow.js';

/**
 * Access control v2 adoption (Phase 7), end to end against the real test
 * database with the MIS mocked at `fetch`:
 *
 *   off      nothing changes and MIS /access/* is never called
 *   shadow   responses are the legacy ones; disagreements land in access_shadow_diffs
 *   enforce  the snapshot decides: scoped dashboard (summary vs detail), contact
 *            policy, restricted oversight + central audit, MIS approver pool
 */

// ── MIS mock ────────────────────────────────────────────────────────────────
const snapshots = new Map<string, AccessSnapshot | number>();   // bearer token -> snapshot | HTTP status
let accessCalls: string[] = [];
let audits: Array<Record<string, unknown>> = [];
let holders: Array<{ user_id: number; depth: Depth | null; via: number[] }> | null = null;

function installMis() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const authz = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
    if (url.startsWith(config.misBaseUrl) && url.includes('/access/')) accessCalls.push(url);
    if (url.includes('/access/me')) {
      const s = snapshots.get(authz.replace(/^Bearer /, ''));
      if (s === undefined) return new Response('{}', { status: 503 });
      if (typeof s === 'number') return new Response('{}', { status: s });
      return new Response(JSON.stringify({ success: true, data: s }), { status: 200 });
    }
    if (url.includes('/access/audit')) {
      audits.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ success: true }), { status: 201 });
    }
    if (url.includes('/access/holders')) {
      if (!holders) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ success: true, data: holders }), { status: 200 });
    }
    // Anything else (realtime internal emits, link previews...) — accept quietly.
    return new Response('{}', { status: 200 });
  }));
}

// ── fixtures ────────────────────────────────────────────────────────────────
let nextMis = 5000;

interface UserOpts {
  role?: string;
  level?: string | null;
  programIds?: string[]; gradeIds?: string[]; classGroupIds?: string[];
  persona?: string | null;
  teach?: string[];
  students?: string[];
}

async function makeUser(roleName: string | null, o: UserOpts = {}) {
  const pool = getPool();
  const id = snowflake();
  const misId = String(nextMis++);
  const roleId = roleName
    ? (await pool.query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [roleName])).rows[0]?.id ?? null
    : null;
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id, academic_level,
                        mis_program_ids, mis_grade_ids, mis_class_group_ids,
                        access_persona, access_teach_class_group_ids, access_student_ids,
                        last_seen_at, last_login_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now())`,
    [id, misId, `U ${misId}`, `${id}@amashuri.com`, o.role ?? 'staff', roleId, o.level ?? null,
     o.programIds ?? [], o.gradeIds ?? [], o.classGroupIds ?? [],
     o.persona ?? null, o.teach ?? [], o.students ?? []],
  );
  const misToken = `mis-${misId}`;
  const token = jwt.sign(
    { id, misUserId: misId, name: `U ${misId}`, email: `${id}@amashuri.com`, role: o.role ?? 'staff', misToken },
    config.jwtSecret, { expiresIn: '10m' });
  return { id, misId, misToken, token };
}

const READS = new Set(['MESSAGE_READ', 'CHANNEL_VIEW', 'DIRECTORY_VIEW', 'PRESENCE_VIEW', 'FILE_DOWNLOAD',
  'FEED_VIEW', 'MAIL_READ', 'DASHBOARD_VIEW', 'OVERSIGHT_VIEW_ALL']);

/** Give a user a v2 snapshot: keys held at `scope` (default SELF). */
function grant(u: { misId: string; misToken: string }, keys: string[], opts: {
  scope?: ScopeEntry; persona?: string; extra?: Record<string, CapabilityEntry[]>;
} = {}) {
  const caps: Record<string, CapabilityEntry[]> = {};
  for (const k of keys) {
    caps[k] = [{ depth: READS.has(k) ? 'detail' : null, scope: opts.scope ?? { self: Number(u.misId) }, via: [1] }];
  }
  for (const [k, v] of Object.entries(opts.extra ?? {})) caps[k] = [...(caps[k] ?? []), ...v];
  snapshots.set(u.misToken, {
    v: 1, app: 'tupo', core: '1.0.0',
    user: { id: Number(u.misId), persona: opts.persona ?? 'TEACHER', school_id: 1 },
    year: 5, caps, grants: {}, home: null, systems: ['tupo'], generated_at: new Date().toISOString(),
  });
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const nonce = () => randomBytes(8).toString('hex');

async function seedMessage(senderId: string, name = 'G') {
  const pool = getPool();
  const spaceId = snowflake();
  await pool.query(`INSERT INTO spaces (id, slug, name) VALUES ($1, $1, 'S') ON CONFLICT DO NOTHING`, [spaceId]);
  const convId = snowflake();
  await pool.query(
    `INSERT INTO conversations (id, space_id, type, name, member_count, last_seq)
     VALUES ($1, $2, 'group', $3, 1, 1)`, [convId, spaceId, name]);
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member')`,
    [convId, senderId]);
  const messageId = snowflake();
  await pool.query(
    `INSERT INTO messages (id, conversation_id, seq, sender_id, type, body, nonce, created_at)
     VALUES ($1, $2, 1, $3, 'text', 'hello', $4, now())`,
    [messageId, convId, senderId, nonce()]);
  return { convId, messageId };
}

async function diffs(where = 'true', params: unknown[] = []) {
  return (await getPool().query<{
    user_id: string; capability: string; route: string; legacy_allowed: boolean; v2_allowed: boolean;
    hits: number; sample_target: Record<string, unknown> | null;
  }>(`SELECT * FROM access_shadow_diffs WHERE ${where} ORDER BY id`, params)).rows;
}

/** Shadow comparisons run after the response; give them a moment. */
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 2000): Promise<T> {
  const until = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 25));
    v = await fn();
  }
  return v;
}

async function cleanup() {
  const pool = getPool();
  await pool.query('DELETE FROM notifications');
  await pool.query('DELETE FROM mail_campaigns');
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM messages');
  await pool.query('DELETE FROM conversations');
  await pool.query('DELETE FROM access_shadow_diffs');
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM roles WHERE is_system = false');
}

const savedMode = process.env.ACCESS_V2_MODE;
const setMode = (m: string | undefined) => {
  if (m === undefined) delete process.env.ACCESS_V2_MODE; else process.env.ACCESS_V2_MODE = m;
};

beforeEach(async () => {
  await cleanup();
  await seedRbac(getPool());
  snapshots.clear();
  accessCalls = [];
  audits = [];
  holders = null;
  __resetAccessSnapshots();
  __resetShadowThrottle();
  installMis();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setMode(savedMode);
});

afterAll(async () => {
  await cleanup();
  await closeDb();
});

// ────────────────────────────────────────────────────────────────────────────
describe('off (default under test)', () => {
  it('never consults MIS and keeps the legacy decisions', async () => {
    setMode(undefined);
    const staff = await makeUser('Staff', { level: 'staff' });
    const student = await makeUser('Student', { role: 'student', persona: 'STUDENT', classGroupIds: ['7'] });
    grant(staff, []);                                  // v2 would deny everything

    expect((await request(app).get('/api/dashboard/scope').set(auth(staff.token))).status).toBe(200);
    expect((await request(app).get('/api/dashboard/scope').set(auth(student.token))).status).toBe(403);
    const dm = await request(app).post('/api/chat/conversations/direct').set(auth(staff.token)).send({ userId: student.id });
    expect(dm.status).toBe(200);
    expect((await request(app).get('/api/access/me').set(auth(staff.token))).status).toBe(200); // explicit read only

    // Only the explicit /api/access/me read reached MIS; no diffs recorded.
    expect(accessCalls.every((u) => u.includes('/access/me'))).toBe(true);
    expect(accessCalls).toHaveLength(1);
    expect(await diffs()).toHaveLength(0);
  });
});

describe('/api/sso/me is unchanged', () => {
  for (const mode of ['off', 'enforce']) {
    it(`never exposes the internal access state (${mode})`, async () => {
      setMode(mode);
      const staff = await makeUser('Staff');
      grant(staff, ['DM_START']);
      const res = await request(app).get('/api/sso/me').set(auth(staff.token));
      expect(res.status).toBe(200);
      expect(res.body.data.user).not.toHaveProperty('access');
      expect(res.body.data.user).not.toHaveProperty('misToken');
      // The UI keeps the local RBAC set until it moves to useAccess().
      expect(res.body.data.rolePermissions).toContain('DASHBOARD_VIEW');
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
describe('shadow', () => {
  beforeEach(() => setMode('shadow'));

  it('answers exactly as legacy and records where v2 disagrees', async () => {
    const staff = await makeUser('Staff', { level: 'staff' });
    const student = await makeUser('Student', { role: 'student', level: 'student' });
    grant(staff, ['MESSAGE_READ']);                    // lacks DASHBOARD_VIEW
    grant(student, ['DASHBOARD_VIEW']);                // legacy lacks it

    setMode('off');
    const offBody = (await request(app).get('/api/dashboard/scope').set(auth(staff.token))).body;
    setMode('shadow');
    const res = await request(app).get('/api/dashboard/scope').set(auth(staff.token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(offBody);
    expect((await request(app).get('/api/dashboard/scope').set(auth(student.token))).status).toBe(403);

    const rows = await eventually(() => diffs(`capability = 'DASHBOARD_VIEW' AND route LIKE 'GET %'`), (r) => r.length >= 2);
    const byUser = Object.fromEntries(rows.map((r) => [r.user_id, r]));
    expect(byUser[staff.id]).toMatchObject({ route: 'GET /api/dashboard/scope', legacy_allowed: true, v2_allowed: false });
    expect(byUser[student.id]).toMatchObject({ legacy_allowed: false, v2_allowed: true });
  });

  it('counts repeats on one row instead of a row per request', async () => {
    const staff = await makeUser('Staff', { level: 'staff' });
    grant(staff, []);
    await request(app).get('/api/dashboard/scope').set(auth(staff.token));
    await eventually(() => diffs(), (r) => r.length === 1);
    __resetShadowThrottle();
    await request(app).get('/api/dashboard/scope').set(auth(staff.token));
    const rows = await eventually(() => diffs(), (r) => r[0]?.hits === 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hits).toBe(2);
  });

  it('skips silently when MIS has no snapshot', async () => {
    const staff = await makeUser('Staff', { level: 'staff' });
    snapshots.set(staff.misToken, 503);
    expect((await request(app).get('/api/dashboard/scope').set(auth(staff.token))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    expect(await diffs()).toHaveLength(0);
  });

  it('lets a policy-violating DM through but records the would-deny', async () => {
    // Legacy: a Staff role (holds DM_START). v2 persona: a student in class 7.
    const s = await makeUser('Staff', { persona: 'STUDENT', classGroupIds: ['7'] });
    const outsider = await makeUser('Student', { role: 'student', persona: 'STUDENT', classGroupIds: ['8'] });
    grant(s, ['DM_START'], { persona: 'STUDENT' });
    const dm = await request(app).post('/api/chat/conversations/direct').set(auth(s.token)).send({ userId: outsider.id });
    expect(dm.status).toBe(200);
    const rows = await eventually(() => diffs(`route = 'contact:dm'`), (r) => r.length === 1);
    expect(rows[0]).toMatchObject({ user_id: s.id, capability: 'CONTACT', legacy_allowed: true, v2_allowed: false });
    expect(rows[0]!.sample_target).toMatchObject({ recipientId: outsider.id, reason: 'default_deny' });
  });

  it('records a dashboard scope difference without changing the numbers', async () => {
    const admin = await makeUser('Admin', { role: 'admin', level: 'super_admin' });
    grant(admin, [], { extra: { DASHBOARD_VIEW: [{ depth: 'detail', scope: { class_groups: [7] }, via: [2] }] } });
    const o = await request(app).get('/api/dashboard/overview').set(auth(admin.token));
    expect(o.status).toBe(200);
    expect(o.body.data.scopedUsers).toBeNull();           // legacy: unrestricted
    const rows = await eventually(() => diffs(`route = 'dashboard:scope'`), (r) => r.length === 1);
    expect(rows[0]!.sample_target).toMatchObject({ legacy: { unrestricted: true }, v2: { unrestricted: false } });
  });

  it('compares the bulk-mail approver pool with MIS holders but notifies nobody', async () => {
    const sender = await makeUser('Moderator', { level: 'staff' });
    const legacyApprover = await makeUser('Moderator', { level: 'staff' });
    const v2Approver = await makeUser('Staff', { level: 'staff' });
    holders = [{ user_id: Number(sender.misId), depth: null, via: [1] }, { user_id: Number(v2Approver.misId), depth: null, via: [2] }];
    const id = await createCampaign(sender.token, 201);
    const sub = await request(app).post(`/api/mail/campaigns/${id}/submit`).set(auth(sender.token));
    expect(sub.body.data.campaign.status).toBe('pending_approval');
    const rows = await eventually(() => diffs(`route = 'mail:approver_pool'`), (r) => r.length === 1);
    expect(rows[0]!.sample_target).toMatchObject({ onlyInV2: [v2Approver.id], onlyInLegacy: [legacyApprover.id] });
    const n = await getPool().query(`SELECT 1 FROM notifications WHERE subject_type = 'mail_campaign_approval'`);
    expect(n.rowCount).toBe(0);
  });
});

async function createCampaign(token: string, n: number) {
  const res = await request(app).post('/api/mail/campaigns').set(auth(token)).send({
    name: 'Term notice', subject: 'Term notice', bodyHtml: '<p>Hello {{name}}</p>',
    extraRecipients: Array.from({ length: n }, (_, i) => ({ address: `r${i}@example.org`, name: `R ${i}` })),
  });
  expect(res.status).toBe(201);
  return res.body.data.campaign.id as string;
}

// ────────────────────────────────────────────────────────────────────────────
describe('enforce: permissions', () => {
  beforeEach(() => setMode('enforce'));

  it('the snapshot, not the local role, decides (held anywhere)', async () => {
    const admin = await makeUser('Admin', { role: 'admin', level: 'super_admin' });
    const student = await makeUser('Student', { role: 'student' });
    grant(admin, ['MESSAGE_READ']);                   // no DASHBOARD_VIEW anywhere
    grant(student, [], { extra: { DASHBOARD_VIEW: [{ depth: 'summary', scope: { class_groups: [7] }, via: [3] }] } });
    expect((await request(app).get('/api/dashboard/scope').set(auth(admin.token))).status).toBe(403);
    expect((await request(app).get('/api/dashboard/scope').set(auth(student.token))).status).toBe(200);
  });

  it('fails closed with 503 when no snapshot can be had', async () => {
    const staff = await makeUser('Staff', { level: 'staff' });
    snapshots.set(staff.misToken, 503);
    expect((await request(app).get('/api/dashboard/scope').set(auth(staff.token))).status).toBe(503);
    expect((await request(app).get('/api/access/me').set(auth(staff.token))).status).toBe(503);
  });

  it('GET /api/access/me returns the snapshot', async () => {
    const staff = await makeUser('Staff');
    grant(staff, ['DM_START']);
    const res = await request(app).get('/api/access/me').set(auth(staff.token));
    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('enforce');
    expect(Object.keys(res.body.data.snapshot.caps)).toEqual(['DM_START']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('enforce: dashboard scope', () => {
  beforeEach(() => setMode('enforce'));

  it('a legacy admin with a class-scoped grant sees only that class (no USERS_MANAGE/admin shortcut)', async () => {
    const admin = await makeUser('Admin', { role: 'admin', level: 'super_admin' });
    const inClass = await makeUser('Student', { classGroupIds: ['7'] });
    const outside = await makeUser('Student', { classGroupIds: ['8'] });
    grant(admin, ['USERS_MANAGE'], { scope: { all: true }, extra: {
      DASHBOARD_VIEW: [{ depth: 'detail', scope: { class_groups: [7] }, via: [2] }],
    } });
    await seedMessage(inClass.id);
    await seedMessage(outside.id);

    const scope = await request(app).get('/api/dashboard/scope').set(auth(admin.token));
    expect(scope.body.data.scope).toMatchObject({ unrestricted: false, detail: true });
    expect(scope.body.data.scope).not.toHaveProperty('v2');
    expect(scope.body.data.scope.classGroups.map((c: { id: string }) => c.id)).toEqual(['7']);

    const o = await request(app).get('/api/dashboard/overview').set(auth(admin.token));
    expect(o.body.data.scopedUsers).toBe(2);             // themselves + the class-7 student
    expect(o.body.data.chat.messages).toBe(1);
    expect(o.body.data.topPeople.map((p: { id: string }) => p.id)).toEqual([inClass.id]);
  });

  it('a summary-only viewer gets aggregates but no per-person rows', async () => {
    const head = await makeUser('Staff', { level: 'staff' });
    const a = await makeUser('Student', { classGroupIds: ['7'] });
    await makeUser('Student', { classGroupIds: ['8'] });
    grant(head, [], { extra: { DASHBOARD_VIEW: [{ depth: 'summary', scope: { all: true }, via: [4] }] } });
    await seedMessage(a.id);

    const scope = await request(app).get('/api/dashboard/scope').set(auth(head.token));
    expect(scope.body.data.scope).toMatchObject({ unrestricted: true, detail: false });

    const o = await request(app).get('/api/dashboard/overview?window=24h').set(auth(head.token));
    expect(o.status).toBe(200);
    expect(o.body.data.scopedUsers).toBeNull();
    expect(o.body.data.people.total).toBe(3);
    expect(o.body.data.chat.messages).toBe(1);
    expect(o.body.data.topPeople).toEqual([]);
    expect(o.body.data.recent).toEqual([]);
    expect(o.body.data.quiet).toEqual([]);

    const online = await request(app).get('/api/dashboard/online').set(auth(head.token));
    expect(online.body.data.people).toEqual([]);
  });

  it('summary school-wide + detail in one class: names only from that class', async () => {
    const dos = await makeUser('Staff', { level: 'staff' });
    const mine = await makeUser('Student', { classGroupIds: ['7'] });
    const other = await makeUser('Student', { classGroupIds: ['8'] });
    grant(dos, [], { extra: { DASHBOARD_VIEW: [
      { depth: 'summary', scope: { all: true }, via: [4] },
      { depth: 'detail', scope: { class_groups: [7] }, via: [5] },
    ] } });
    await seedMessage(mine.id);
    await seedMessage(other.id);
    const o = await request(app).get('/api/dashboard/overview').set(auth(dos.token));
    expect(o.body.data.chat.messages).toBe(2);                       // aggregates: everyone
    expect(o.body.data.topPeople.map((p: { id: string }) => p.id)).toEqual([mine.id]);
    expect(o.body.data.recent.every((r: { actorId: string }) => r.actorId === mine.id)).toBe(true);
  });

  it('mentees are covered by MIS id', async () => {
    const mentor = await makeUser('Staff');
    const mentee = await makeUser('Student');
    await makeUser('Student');
    grant(mentor, [], { extra: { DASHBOARD_VIEW: [{ depth: 'detail', scope: { students: [Number(mentee.misId)] }, via: [6] }] } });
    const o = await request(app).get('/api/dashboard/overview').set(auth(mentor.token));
    expect(o.body.data.scopedUsers).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('enforce: contact policy', () => {
  beforeEach(() => setMode('enforce'));
  const STUDENT_CAPS = ['DM_START', 'DIRECTORY_VIEW', 'CHANNEL_CREATE', 'MESSAGE_SEND', 'MESSAGE_READ'];

  async function school() {
    const student = await makeUser('Student', { role: 'student', persona: 'STUDENT', classGroupIds: ['7'] });
    const teacher = await makeUser('Staff', { persona: 'TEACHER', teach: ['7'] });
    const otherTeacher = await makeUser('Staff', { persona: 'TEACHER', teach: ['9'] });
    const classmate = await makeUser('Student', { role: 'student', persona: 'STUDENT', classGroupIds: ['7'] });
    const outsider = await makeUser('Student', { role: 'student', persona: 'STUDENT', classGroupIds: ['8'] });
    grant(student, STUDENT_CAPS, { persona: 'STUDENT' });
    return { student, teacher, otherTeacher, classmate, outsider };
  }

  it('a student may DM their teacher and classmates, and nobody else', async () => {
    const s = await school();
    const dm = (to: string) => request(app).post('/api/chat/conversations/direct').set(auth(s.student.token)).send({ userId: to });
    expect((await dm(s.teacher.id)).status).toBe(200);
    expect((await dm(s.classmate.id)).status).toBe(200);
    expect((await dm(s.otherTeacher.id)).status).toBe(403);
    expect((await dm(s.outsider.id)).status).toBe(403);
  });

  it('the directory shows a student only the people they may contact', async () => {
    const s = await school();
    const res = await request(app).get('/api/chat/directory?limit=50').set(auth(s.student.token));
    expect(res.status).toBe(200);
    const ids = res.body.data.people.map((p: { id: string }) => p.id).sort();
    expect(ids).toEqual([s.teacher.id, s.classmate.id].sort());

    const search = await request(app).get('/api/search?q=amashuri&types=person&limit=25').set(auth(s.student.token));
    expect(search.status).toBe(200);
    const people = (search.body.data.results.person ?? []).map((r: { id: string }) => r.id.replace('person:', '')).sort();
    expect(people).toEqual([s.teacher.id, s.classmate.id].sort());
  });

  it('a student cannot put a non-contact into a new group; a classmate is fine', async () => {
    const s = await school();
    const bad = await request(app).post('/api/chat/conversations').set(auth(s.student.token))
      .send({ type: 'group', memberIds: [s.classmate.id, s.outsider.id] });
    expect(bad.status).toBe(403);
    const good = await request(app).post('/api/chat/conversations').set(auth(s.student.token))
      .send({ type: 'group', memberIds: [s.classmate.id] });
    expect(good.status).toBe(201);
  });

  it('adding channel members follows the adder’s contact policy', async () => {
    const s = await school();
    grant(s.student, [...STUDENT_CAPS, 'CHANNEL_MEMBERS_MANAGE'], { persona: 'STUDENT' });
    const made = await request(app).post('/api/chat/conversations').set(auth(s.student.token))
      .send({ type: 'group', memberIds: [s.classmate.id] });
    const convId = made.body.data.conversation.id;
    const bad = await request(app).post(`/api/chat/conversations/${convId}/members`).set(auth(s.student.token))
      .send({ userIds: [s.outsider.id] });
    expect(bad.status).toBe(403);
    const ok = await request(app).post(`/api/chat/conversations/${convId}/members`).set(auth(s.student.token))
      .send({ userIds: [s.teacher.id] });
    expect(ok.status).toBe(200);
  });

  it('a parent may DM their child’s teacher, not other staff', async () => {
    const s = await school();
    const parent = await makeUser('Parent', { role: 'parent', persona: 'PARENT', students: [s.student.misId] });
    grant(parent, ['DM_START'], { persona: 'PARENT' });
    const dm = (to: string) => request(app).post('/api/chat/conversations/direct').set(auth(parent.token)).send({ userId: to });
    expect((await dm(s.teacher.id)).status).toBe(200);
    expect((await dm(s.otherTeacher.id)).status).toBe(403);
  });

  it('staff are unrestricted', async () => {
    const s = await school();
    grant(s.otherTeacher, ['DM_START'], { persona: 'TEACHER' });
    const dm = await request(app).post('/api/chat/conversations/direct').set(auth(s.otherTeacher.token)).send({ userId: s.outsider.id });
    expect(dm.status).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('enforce: oversight', () => {
  beforeEach(() => setMode('enforce'));

  it('requires the restricted v2 capability at sensitive depth, whatever the local role', async () => {
    const legacyAdmin = await makeUser('Admin', { role: 'admin' });
    const shallow = await makeUser('Staff');
    const author = await makeUser('Staff');
    grant(legacyAdmin, ['MESSAGE_READ']);
    grant(shallow, [], { extra: { OVERSIGHT_VIEW_ALL: [{ depth: 'detail', scope: { all: true }, via: [7] }] } });
    const { convId } = await seedMessage(author.id);
    expect((await request(app).get(`/api/oversight/conversations/${convId}/messages`).set(auth(legacyAdmin.token))).status).toBe(403);
    expect((await request(app).get(`/api/oversight/conversations/${convId}/messages`).set(auth(shallow.token))).status).toBe(403);
    expect(audits).toHaveLength(0);
  });

  it('forwards every read and redaction to the MIS audit log and keeps the local one', async () => {
    const reviewer = await makeUser('Staff');
    const author = await makeUser('Staff');
    grant(reviewer, ['OVERSIGHT_MESSAGE_DELETE'], { scope: { all: true }, extra: {
      OVERSIGHT_VIEW_ALL: [{ depth: 'sensitive', scope: { all: true }, via: [8] }],
    } });
    const { convId, messageId } = await seedMessage(author.id);

    const read = await request(app).get(`/api/oversight/conversations/${convId}/messages`).set(auth(reviewer.token));
    expect(read.status).toBe(200);
    expect(audits).toContainEqual(expect.objectContaining({
      action: 'tupo.oversight.conversation.read', actor_id: Number(reviewer.misId),
      target: expect.objectContaining({ app: 'tupo', conversationId: convId }),
    }));

    const rm = await request(app).post(`/api/oversight/conversations/${convId}/messages/${messageId}/remove`)
      .set(auth(reviewer.token)).send({ reason: 'bullying' });
    expect(rm.status).toBe(200);
    const redaction = audits.find((a) => a.action === 'tupo.oversight.message.remove');
    expect(redaction).toMatchObject({
      actor_id: Number(reviewer.misId), subject_user_id: Number(author.misId), reason: 'bullying',
      target: expect.objectContaining({ conversationId: convId, messageId }),
    });
    expect(JSON.stringify(redaction)).not.toContain('hello');      // no message text leaves Tupo

    const local = await getPool().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE actor_id = $1 ORDER BY created_at`, [reviewer.id]);
    expect(local.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['chat.oversight.conversation.read', 'chat.oversight.message.remove']));
  });

  it('in off mode nothing is forwarded', async () => {
    setMode('off');
    const admin = await makeUser('Admin', { role: 'admin' });
    const author = await makeUser('Staff');
    const { convId } = await seedMessage(author.id);
    expect((await request(app).get(`/api/oversight/conversations/${convId}/messages`).set(auth(admin.token))).status).toBe(200);
    expect(audits).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('enforce: bulk mail approver pool', () => {
  beforeEach(() => setMode('enforce'));

  it('notifies the MIS holders of MAIL_APPROVE, never the sender', async () => {
    const sender = await makeUser('Staff');
    const approver = await makeUser('Staff');
    const bystander = await makeUser('Moderator');           // local MAIL_APPROVE, not a v2 holder
    grant(sender, ['MAIL_BULK_SEND', 'MAIL_SEND', 'MAIL_READ', 'MAIL_APPROVE']);
    holders = [
      { user_id: Number(sender.misId), depth: null, via: [1] },
      { user_id: Number(approver.misId), depth: null, via: [2] },
    ];
    const id = await createCampaign(sender.token, 201);
    const sub = await request(app).post(`/api/mail/campaigns/${id}/submit`).set(auth(sender.token));
    expect(sub.status).toBe(200);
    expect(sub.body.data.campaign.status).toBe('pending_approval');
    const n = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM notifications WHERE subject_type = 'mail_campaign_approval' AND subject_id = $1`, [id]);
    expect(n.rows.map((r) => r.user_id)).toEqual([approver.id]);
    void bystander;

    // Self-approval stays blocked (Phase 0), even for a v2 holder.
    const self = await request(app).post(`/api/mail/campaigns/${id}/approve`).set(auth(sender.token));
    expect(self.status).toBe(403);
  });

  it('notifies nobody when MIS cannot say who the approvers are', async () => {
    const sender = await makeUser('Staff');
    grant(sender, ['MAIL_BULK_SEND', 'MAIL_SEND', 'MAIL_READ']);
    holders = null;
    const id = await createCampaign(sender.token, 201);
    const sub = await request(app).post(`/api/mail/campaigns/${id}/submit`).set(auth(sender.token));
    expect(sub.body.data.campaign.status).toBe('pending_approval');
    expect((await getPool().query(`SELECT 1 FROM notifications WHERE subject_id = $1`, [id])).rowCount).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('verify-mis carries the access version into the snapshot cache', () => {
  it('re-fetches the snapshot after MIS reports a new access_version', async () => {
    setMode('enforce');
    const staff = await makeUser('Staff');
    grant(staff, ['DASHBOARD_VIEW']);
    expect((await request(app).get('/api/dashboard/scope').set(auth(staff.token))).status).toBe(200);

    // Grants change in MIS: DASHBOARD_VIEW removed, access_version bumped to 2.
    grant(staff, ['MESSAGE_READ']);
    (snapshots.get(staff.misToken) as AccessSnapshot).v = 2;
    // Still cached (v1) until verify-mis says otherwise.
    expect((await request(app).get('/api/dashboard/scope').set(auth(staff.token))).status).toBe(200);

    const realFetch = (globalThis.fetch as unknown as (u: string | URL, i?: RequestInit) => Promise<Response>);
    vi.stubGlobal('fetch', vi.fn(async (u: string | URL, i?: RequestInit) => String(u).endsWith('/auth/verify')
      ? new Response(JSON.stringify({ success: true, data: { access_version: 2 } }), { status: 200 })
      : realFetch(u, i)));
    const v = await request(app).get('/api/sso/verify-mis').set(auth(staff.token));
    expect(v.status).toBe(200);
    expect((await request(app).get('/api/dashboard/scope').set(auth(staff.token))).status).toBe(403);
  });
});
