import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS } from '@tupo/shared';
import {
  decide, scopeFor, validateManifest, type AccessSnapshot,
} from '../vendor/nga-access/index.js';
import { TUPO_MANIFEST } from '../access/manifest.js';
import { accessMode } from '../access/mode.js';
import {
  getAccessSnapshot, noteAccessVersion, peekAccessSnapshot,
  __resetAccessSnapshots, __ageAccessSnapshot,
} from '../access/snapshot.js';
import { contactDecision, personaOf, type ContactProfile } from '../access/contactPolicy.js';
import { academicFromSnapshot, contactColumnsFromSnapshot } from '../access/profileSync.js';
import { runPublish } from '../access/publish.js';
import { readAcademic } from '../routes/sso.js';
import { config } from '../config.js';

/**
 * Access control v2 — the pieces that need no database: the vendored decision
 * core, the manifest, the snapshot cache, the contact policy, the placement
 * derivation and the manifest publisher. MIS is always mocked.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const table = JSON.parse(fs.readFileSync(path.join(here, '../vendor/nga-access/decision-table.json'), 'utf8'));

describe('@nga/access decision table (vendored core)', () => {
  const snapshot = table.snapshot as AccessSnapshot;
  for (const c of table.cases) {
    it(c.name, () => {
      const d = decide(snapshot, c.cap, c.target, c.minDepth ?? null);
      expect(d.allowed).toBe(c.allowed);
      if ('depth' in c) expect(d.depth).toEqual(c.depth);
      if ('via' in c) expect(d.via).toEqual(c.via);
    });
  }
  for (const c of table.scopeFor) {
    it(`scopeFor: ${c.name}`, () => {
      expect(scopeFor(snapshot, c.cap, c.minDepth ?? null)).toEqual(c.expect);
    });
  }
  it('fails closed without a snapshot', () => {
    expect(decide(null, 'DM_START', {}).allowed).toBe(false);
    expect(scopeFor(undefined, 'DASHBOARD_VIEW')).toBeNull();
  });
  it('the vendored copy carries its provenance header', () => {
    const src = fs.readFileSync(path.join(here, '../vendor/nga-access/index.ts'), 'utf8');
    expect(src).toMatch(/^\/\/ VENDORED from nga_central_mis\/packages\/access\/src\/index\.ts/);
    expect(src).toMatch(/sha256:[0-9a-f]{64}/);
  });
});

describe('Tupo manifest', () => {
  it('is valid', () => {
    expect(validateManifest(TUPO_MANIFEST)).toEqual([]);
  });
  it('is app "tupo"', () => {
    expect(TUPO_MANIFEST.app).toBe('tupo');
  });
  it('declares exactly the keys of the permission catalog (drift both ways fails)', () => {
    const manifestKeys = Object.keys(TUPO_MANIFEST.capabilities).sort();
    const catalogKeys = PERMISSIONS.map((p) => p.key).sort();
    expect(manifestKeys.filter((k) => !catalogKeys.includes(k))).toEqual([]);   // in manifest only
    expect(catalogKeys.filter((k) => !manifestKeys.includes(k))).toEqual([]);   // in catalog only
    expect(manifestKeys).toEqual(catalogKeys);
  });
  it('marks oversight restricted and gives the dashboard summary/detail depths', () => {
    expect(TUPO_MANIFEST.capabilities.OVERSIGHT_VIEW_ALL.restricted).toBeTruthy();
    expect(TUPO_MANIFEST.capabilities.OVERSIGHT_MESSAGE_DELETE.restricted).toBeTruthy();
    expect(TUPO_MANIFEST.capabilities.DASHBOARD_VIEW.depths).toEqual(['summary', 'detail']);
  });
});

describe('ACCESS_V2_MODE', () => {
  const saved = process.env.ACCESS_V2_MODE;
  afterEach(() => { if (saved === undefined) delete process.env.ACCESS_V2_MODE; else process.env.ACCESS_V2_MODE = saved; });
  it('defaults to off under test', () => {
    delete process.env.ACCESS_V2_MODE;
    expect(accessMode()).toBe('off');
  });
  it('accepts shadow / enforce and ignores junk', () => {
    process.env.ACCESS_V2_MODE = 'ENFORCE';
    expect(accessMode()).toBe('enforce');
    process.env.ACCESS_V2_MODE = 'shadow';
    expect(accessMode()).toBe('shadow');
    process.env.ACCESS_V2_MODE = 'yes please';
    expect(accessMode()).toBe('off');
  });
});

const snap = (id: number, v: number, caps: AccessSnapshot['caps'] = {}): AccessSnapshot => ({
  v, app: 'tupo', core: '1.0.0', user: { id, persona: 'TEACHER', school_id: 1 }, year: 5,
  caps, grants: {}, home: null, systems: ['tupo'], generated_at: new Date().toISOString(),
});

describe('snapshot cache', () => {
  let calls: string[];
  let reply: () => Response | Promise<Response>;
  beforeEach(() => {
    __resetAccessSnapshots();
    calls = [];
    reply = () => new Response(JSON.stringify({ success: true, data: snap(42, 1) }), { status: 200 });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push(`${String(url)} ${(init?.headers as Record<string, string>)?.Authorization ?? ''}`);
      return reply();
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('fetches /access/me?app=tupo with the user bearer token, then serves from cache', async () => {
    const a = await getAccessSnapshot({ misUserId: '42', misToken: 'mis-tok' });
    expect(a.status).toBe('fresh');
    expect(a.snapshot?.v).toBe(1);
    expect(calls).toEqual([`${config.misBaseUrl}/access/me?app=tupo Bearer mis-tok`]);
    const b = await getAccessSnapshot({ misUserId: '42', misToken: 'mis-tok' });
    expect(b.status).toBe('cached');
    expect(calls).toHaveLength(1);
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    await Promise.all([1, 2, 3].map(() => getAccessSnapshot({ misUserId: '42', misToken: 't' })));
    expect(calls).toHaveLength(1);
  });

  it('re-fetches when verify-mis reports a different access_version', async () => {
    await getAccessSnapshot({ misUserId: '42', misToken: 't' });
    expect(noteAccessVersion('42', 1)).toBe(false);          // same v: nothing to do
    reply = () => new Response(JSON.stringify({ success: true, data: snap(42, 2) }), { status: 200 });
    expect(noteAccessVersion('42', 2)).toBe(true);
    const r = await getAccessSnapshot({ misUserId: '42', misToken: 't' });
    expect(r.status).toBe('fresh');
    expect(r.snapshot?.v).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('keeps the last good snapshot during an MIS outage, for up to 24 h, then fails closed', async () => {
    await getAccessSnapshot({ misUserId: '42', misToken: 't' });
    noteAccessVersion('42', 9);                               // force a re-fetch
    reply = () => new Response('down', { status: 503 });
    const during = await getAccessSnapshot({ misUserId: '42', misToken: 't' });
    expect(during.status).toBe('stale');
    expect(during.snapshot?.v).toBe(1);

    __ageAccessSnapshot('42', 25 * 60 * 60_000);
    const after = await getAccessSnapshot({ misUserId: '42', misToken: 't' });
    expect(after.status).toBe('unavailable');
    expect(after.snapshot).toBeNull();
    expect(peekAccessSnapshot('42')).toBeNull();
  });

  it('treats a network error or a timeout like an outage', async () => {
    reply = () => { throw new Error('ECONNREFUSED'); };
    const r = await getAccessSnapshot({ misUserId: '7', misToken: 't' });
    expect(r).toEqual({ snapshot: null, status: 'unavailable' });
  });

  it('does not hammer an unreachable MIS: one attempt per user per retry window', async () => {
    reply = () => new Response('down', { status: 503 });
    await getAccessSnapshot({ misUserId: '8', misToken: 't' });
    await getAccessSnapshot({ misUserId: '8', misToken: 't' });
    await getAccessSnapshot({ misUserId: '8', misToken: 't' });
    expect(calls).toHaveLength(1);
  });

  it('drops the snapshot at once when MIS rejects the token', async () => {
    await getAccessSnapshot({ misUserId: '42', misToken: 't' });
    noteAccessVersion('42', 9);
    reply = () => new Response('{}', { status: 401 });
    const r = await getAccessSnapshot({ misUserId: '42', misToken: 't' });
    expect(r.snapshot).toBeNull();
    expect(peekAccessSnapshot('42')).toBeNull();
  });

  it('rejects a malformed MIS body', async () => {
    reply = () => new Response(JSON.stringify({ success: true, data: { nope: 1 } }), { status: 200 });
    expect((await getAccessSnapshot({ misUserId: '5', misToken: 't' })).snapshot).toBeNull();
  });
});

describe('contact policy (pure)', () => {
  const p = (userId: string, persona: ContactProfile['persona'], o: Partial<ContactProfile> = {}): ContactProfile => ({
    userId, misUserId: `m${userId}`, persona, classGroupIds: [], teachClassGroupIds: [], studentIds: [], ...o,
  });
  const student = p('s', 'student', { classGroupIds: ['7'] });
  const classmate = p('c', 'student', { classGroupIds: ['7'] });
  const otherStudent = p('o', 'student', { classGroupIds: ['8'] });
  const teacher = p('t', 'staff', { teachClassGroupIds: ['7'] });
  const otherTeacher = p('u', 'staff', { teachClassGroupIds: ['9'] });
  const mentor = p('m', 'staff', { studentIds: ['ms'] });
  const parent = p('p', 'parent', { studentIds: ['ms'], classGroupIds: ['7'] });
  const otherParent = p('q', 'parent', { studentIds: ['mz'] });

  it('staff may contact anyone', () => {
    for (const to of [student, otherStudent, parent, otherTeacher]) {
      expect(contactDecision(teacher, to).allowed).toBe(true);
    }
  });
  it('a student may contact their teacher, mentor and classmates', () => {
    expect(contactDecision(student, teacher)).toEqual({ allowed: true, reason: 'teacher' });
    expect(contactDecision(student, mentor)).toEqual({ allowed: true, reason: 'mentor' });
    expect(contactDecision(student, classmate)).toEqual({ allowed: true, reason: 'classmate' });
  });
  it('a student may not contact other teachers, other students or parents', () => {
    expect(contactDecision(student, otherTeacher).allowed).toBe(false);
    expect(contactDecision(student, otherStudent).allowed).toBe(false);
    expect(contactDecision(student, parent).allowed).toBe(false);
  });
  it('a parent may contact their children’s teachers and mentors only', () => {
    expect(contactDecision(parent, teacher)).toEqual({ allowed: true, reason: 'childs_teacher' });
    expect(contactDecision(parent, mentor)).toEqual({ allowed: true, reason: 'childs_mentor' });
    expect(contactDecision(parent, otherTeacher).allowed).toBe(false);
    expect(contactDecision(parent, student).allowed).toBe(false);
    expect(contactDecision(otherParent, teacher).allowed).toBe(false);
  });
  it('anyone unknown is denied by default', () => {
    expect(contactDecision(p('x', 'unknown'), teacher)).toEqual({ allowed: false, reason: 'default_deny' });
  });
  it('maps personas from MIS user_type first, then the Tupo role', () => {
    expect(personaOf('STUDENT', 'staff', null)).toBe('student');
    expect(personaOf('TEACHER', 'student', null)).toBe('staff');
    expect(personaOf(null, 'parent', null)).toBe('parent');
    expect(personaOf(null, 'unassigned', null)).toBe('unknown');
  });
});

describe('placement derived from the snapshot', () => {
  const s: AccessSnapshot = {
    ...snap(20, 3, {
      DASHBOARD_VIEW: [{ depth: 'detail', scope: { class_groups: [7] }, via: [1] }],
      MESSAGE_SEND: [
        { depth: null, scope: { class_groups: [7] }, via: [1] },
        { depth: null, scope: { pairs: [[31, 12]] }, via: [2] },
        { depth: null, scope: { students: [900, 901] }, via: [3] },
      ],
    }),
    grants: {
      1: { role: 'Class Teacher', role_id: 1, title: null, scope_type: 'CLASS_GROUP', scope_id: 7, scope_id2: null, valid_until: null },
      2: { role: 'Subject Teacher', role_id: 2, title: null, scope_type: 'SUBJECT_CLASS', scope_id: 31, scope_id2: 12, valid_until: null },
      3: { role: 'Mentor', role_id: 3, title: null, scope_type: 'MENTEES', scope_id: null, scope_id2: null, valid_until: null },
    },
  };
  const fallback = {
    level: 'class_teacher' as const, programIds: ['2'], gradeIds: ['4'], classGroupIds: ['7'],
    programNames: ['Primary'], gradeNames: ['P4'], classGroupNames: ['P4 Blue'],
  };

  it('places people only at their grant nodes, with names reused from /users/me', () => {
    const a = academicFromSnapshot(s, fallback, false);
    expect(a.level).toBe('class_teacher');
    expect(a.programIds).toEqual([]);
    expect(a.leadProgramIds).toEqual([]);
    expect(a.classGroupIds.sort()).toEqual(['12', '7']);
    expect(a.classGroupNames).toContain('P4 Blue');
  });
  it('a student belongs to the class groups MIS reports (core 1.2) and stays a student', () => {
    const base = snap(21, 3, {});
    const student: AccessSnapshot = {
      ...base,
      user: { ...base.user, persona: 'STUDENT', class_groups: [7] },
      grants: {},
    };
    const none = { level: 'none' as const, programIds: [], gradeIds: [], classGroupIds: [], programNames: [], gradeNames: [], classGroupNames: [] };
    const a = academicFromSnapshot(student, none, false);
    expect(a.placementLevel).toBe('student');
    expect(a.level).toBe('student');
    expect(a.classGroupIds).toEqual(['7']);

    // ...which is what lets the contact policy match their teacher and classmates.
    const me = { userId: 's', misUserId: '21', persona: 'student' as const, classGroupIds: a.classGroupIds, teachClassGroupIds: [], studentIds: [] };
    const teacher = { userId: 't', misUserId: '20', persona: 'staff' as const, classGroupIds: [], teachClassGroupIds: ['7'], studentIds: [] };
    const classmate = { ...me, userId: 'c', misUserId: '22' };
    const stranger = { ...me, userId: 'x', misUserId: '23', classGroupIds: ['8'] };
    expect(contactDecision(me, teacher)).toEqual({ allowed: true, reason: 'teacher' });
    expect(contactDecision(me, classmate)).toEqual({ allowed: true, reason: 'classmate' });
    expect(contactDecision(me, stranger).allowed).toBe(false);
  });
  it('school-wide dashboard detail makes a super admin; forceAdmin too', () => {
    const wide = { ...s, caps: { DASHBOARD_VIEW: [{ depth: 'detail' as const, scope: { all: true }, via: [9] }] } };
    expect(academicFromSnapshot(wide, fallback, false).level).toBe('super_admin');
    expect(academicFromSnapshot(s, fallback, true).level).toBe('super_admin');
  });
  it('extracts contact-policy inputs', () => {
    const c = contactColumnsFromSnapshot(s);
    expect(c.persona).toBe('TEACHER');
    expect(c.teachClassGroupIds.sort()).toEqual(['12', '7']);
    expect(c.studentIds.sort()).toEqual(['900', '901']);
  });
});

describe('readAcademic (MIS /users/me)', () => {
  it('keeps a class teacher’s programme as membership but not as a led programme', () => {
    const a = readAcademic({
      assignedPrograms: [],
      assignedGrades: [{ grade_id: 4, name: 'P4', program_id: 2, program_name: 'Primary', class_group_id: 7, class_group_name: 'P4 Blue' }],
      profile: { user_type: 'TEACHER' }, roles: [],
    }, false);
    expect(a.level).toBe('class_teacher');
    expect(a.programIds).toEqual(['2']);
    expect(a.leadProgramIds).toEqual([]);
    expect(a.classGroupIds).toEqual(['7']);
  });
  it('a programme lead leads their assigned programmes', () => {
    const a = readAcademic({ assignedPrograms: [{ program_id: 3, name: 'Coding' }], assignedGrades: [], roles: [] }, false);
    expect(a.leadProgramIds).toEqual(['3']);
  });
});

describe('npm run access:publish', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('PUTs the manifest to /access/manifests/tupo with the SSO client credentials', async () => {
    const seen: { url: string; method?: string; auth?: string; body?: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({
        url: String(url), method: init?.method,
        auth: (init?.headers as Record<string, string>)?.Authorization,
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ success: true, data: { unchanged: false } }), { status: 200 });
    }));
    const log: string[] = [];
    expect(await runPublish((m) => log.push(m))).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${config.misBaseUrl}/access/manifests/tupo`);
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.auth).toBe(`Basic ${Buffer.from(`${config.ssoClientId}:${config.ssoClientSecret}`).toString('base64')}`);
    expect(seen[0]!.body).toEqual(JSON.parse(JSON.stringify(TUPO_MANIFEST)));
    expect(log.join('\n')).toMatch(/published/);
  });

  it('reports unchanged, refusal and an unreachable MIS with distinct exit codes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: { unchanged: true } }), { status: 200 })));
    const log: string[] = [];
    expect(await runPublish((m) => log.push(m))).toBe(0);
    expect(log.join('\n')).toMatch(/unchanged/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'nope' }), { status: 403 })));
    expect(await runPublish(() => {})).toBe(1);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await runPublish(() => {})).toBe(2);
  });
});
