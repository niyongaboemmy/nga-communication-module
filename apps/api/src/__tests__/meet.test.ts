import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import {
  MESH_MAX_PARTICIPANTS, DEFAULT_MEET_SETTINGS, generateJoinCode, JOIN_CODE_PATTERN,
  normalizeJoinCode, parseMeetSettings, meetRoleAtLeast, severityFor,
} from '@tupo/shared';
import type { MeetAdmissionPolicy } from '@tupo/shared';
import {
  defaultMeetingName, isDefaultMeetingName, CATEGORY_TO_POLICY, POLICY_TO_CATEGORY,
  MEET_CATEGORIES, meetingFolder, MEETING_FOLDER_PATTERN,
  sfuTrackName, parseSfuTrackName, capacityFor, isSfuTransport, CAPACITY,
} from '@tupo/shared';
import { isCloudflareSfuConfigured } from '../services/cloudflareSfuService.js';
import { app } from '../app.js';
import { config } from '../config.js';
import { decideAdmission, decideTransport, assertCapacity } from '../services/meetService.js';
import { resetIceCache, isTurnConfigured } from '../services/turnService.js';
import { computeEngagement, renderTranscript } from '../services/meetAiService.js';

/**
 * Meet's server-side behaviour.
 *
 * The suite runs against the real PostgreSQL (see globalSetup) so the
 * migration, the foreign keys and the partitioned `meeting_events` table are
 * all exercised — a mocked pool would let a broken migration pass.
 */

async function userWithRole(roleName: string | null, name = 'Test') {
  const pool = getPool();
  const id = snowflake();
  const roleId = roleName
    ? (await pool.query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [roleName])).rows[0]?.id ?? null
    : null;
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id)
     VALUES ($1, $1, $2, $3, 'staff', $4)`,
    [id, name, `${id}@amashuri.com`, roleId],
  );
  const token = jwt.sign(
    { id, misUserId: id, name, email: `${id}@amashuri.com`, role: 'staff' },
    config.jwtSecret, { expiresIn: '10m' },
  );
  return { id, token, name };
}

/**
 * Media-server configuration is a *deployment* fact, and these tests are about
 * behaviour. Reading it from the developer's own `.env` means the suite passes
 * or fails depending on whose laptop it runs on — which it did, the moment real
 * Cloudflare credentials were added. Every test that cares about a media server
 * now switches one on explicitly.
 */
function withMediaServer<T>(which: 'cloudflare' | 'none', fn: () => T): T {
  const before = { ...config };
  Object.assign(config, {
    cloudflareRealtimeAppId: which === 'cloudflare' ? 'test-app' : '',
    cloudflareRealtimeAppSecret: which === 'cloudflare' ? 'test-secret' : '',
  });
  try { return fn(); } finally { Object.assign(config, before); }
}

/** Async variant, for the HTTP tests. */
async function withMediaServerAsync<T>(
  which: 'cloudflare' | 'none', fn: () => Promise<T>,
): Promise<T> {
  const before = { ...config };
  Object.assign(config, {
    cloudflareRealtimeAppId: which === 'cloudflare' ? 'test-app' : '',
    cloudflareRealtimeAppSecret: which === 'cloudflare' ? 'test-secret' : '',
  });
  try { return await fn(); } finally { Object.assign(config, before); }
}

/** The default for the suite: no media server, so mesh behaviour is testable. */
let restoreConfig: Partial<typeof config> = {};
beforeEach(() => {
  restoreConfig = {
    cloudflareRealtimeAppId: config.cloudflareRealtimeAppId,
    cloudflareRealtimeAppSecret: config.cloudflareRealtimeAppSecret,
  };
  Object.assign(config, {
    cloudflareRealtimeAppId: '', cloudflareRealtimeAppSecret: '',
  });
});
afterEach(() => { Object.assign(config, restoreConfig); });

beforeEach(async () => {
  const pool = getPool();
  // meetings cascades to every child table, so this is the whole Meet reset —
  // except meeting_events, which is partitioned and therefore has no foreign
  // key, and files, which outlive their meeting by design.
  await pool.query('DELETE FROM meetings');
  await pool.query('DELETE FROM meeting_events');
  await pool.query('DELETE FROM files');
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM roles WHERE is_system = false');
  await seedRbac(pool);
  resetIceCache();
});

afterAll(async () => {
  // Leave the shared test database as this suite found it. `files` references
  // `users` without a cascade, so a leftover row here fails the next suite's
  // reset with a foreign-key error a long way from its cause.
  await getPool().query('DELETE FROM files').catch(() => {});
  await getPool().query('DELETE FROM meetings').catch(() => {});
  await closeDb();
});

/* ================================================================== *
 * Pure logic — no database, no network
 * ================================================================== */

describe('join codes', () => {
  it('generates codes matching the documented shape', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateJoinCode()).toMatch(JOIN_CODE_PATTERN);
    }
  });

  it('excludes vowels so a code cannot spell a word', () => {
    const codes = Array.from({ length: 300 }, () => generateJoinCode()).join('');
    expect(codes).not.toMatch(/[aeiou]/);
  });

  it('normalises what a user actually types', () => {
    expect(normalizeJoinCode('  BCD-FGHJ-KMN  ')).toBe('bcd-fghj-kmn');
    expect(normalizeJoinCode('bcdfghjkmn')).toBe('bcd-fghj-kmn');
    expect(normalizeJoinCode('bcd fghj kmn')).toBe('bcd-fghj-kmn');
  });

  it('is collision-resistant enough to bother retrying rather than trusting', () => {
    const seen = new Set(Array.from({ length: 5000 }, () => generateJoinCode()));
    // 20^10 space — duplicates in 5,000 draws would mean the generator is broken.
    expect(seen.size).toBe(5000);
  });
});

describe('settings', () => {
  it('fills every missing key from the defaults, so an old row still parses', () => {
    const parsed = parseMeetSettings({ lobbyEnabled: false });
    expect(parsed.lobbyEnabled).toBe(false);
    expect(parsed.joinMuted).toBe(DEFAULT_MEET_SETTINGS.joinMuted);
    expect(parsed.aiAssistantEnabled).toBe(false);
  });

  it('falls back to the defaults rather than throwing on a malformed blob', () => {
    expect(parseMeetSettings('not an object')).toEqual(DEFAULT_MEET_SETTINGS);
    expect(parseMeetSettings(null)).toEqual(DEFAULT_MEET_SETTINGS);
  });

  it('defaults to joining muted and to a waiting room', () => {
    expect(DEFAULT_MEET_SETTINGS.joinMuted).toBe(true);
    expect(DEFAULT_MEET_SETTINGS.lobbyEnabled).toBe(true);
    // Safeguarding defaults: nothing is recorded or transcribed unless asked.
    expect(DEFAULT_MEET_SETTINGS.recordingEnabled).toBe(false);
    expect(DEFAULT_MEET_SETTINGS.transcriptionEnabled).toBe(false);
    expect(DEFAULT_MEET_SETTINGS.aiAssistantEnabled).toBe(false);
    expect(DEFAULT_MEET_SETTINGS.guestsAllowed).toBe(false);
  });
});

describe('roles', () => {
  it('orders least to most privileged', () => {
    expect(meetRoleAtLeast('host', 'cohost')).toBe(true);
    expect(meetRoleAtLeast('cohost', 'cohost')).toBe(true);
    expect(meetRoleAtLeast('attendee', 'cohost')).toBe(false);
    expect(meetRoleAtLeast('presenter', 'host')).toBe(false);
  });
});

describe('event severity', () => {
  it('derives severity from the type, so one event is never logged two ways', () => {
    expect(severityFor('participant.joined')).toBe('info');
    expect(severityFor('participant.removed')).toBe('warn');
    expect(severityFor('recording.started')).toBe('warn');
    expect(severityFor('network.dropped')).toBe('critical');
    expect(severityFor('something.unknown')).toBe('info');
  });
});

describe('transport selection', () => {
  it('refuses a mesh meeting larger than the cap, and says why', () => {
    expect(() => decideTransport('mesh', MESH_MAX_PARTICIPANTS + 1))
      .toThrow(/limited to 4 participants/i);
  });

  it('allows mesh up to the cap', () => {
    expect(decideTransport('mesh', MESH_MAX_PARTICIPANTS).transport).toBe('mesh');
  });

  it('falls back to mesh for a small auto meeting when no SFU is configured', () => {
    expect(isCloudflareSfuConfigured()).toBe(false);
    const decision = decideTransport('auto', 2);
    expect(decision.transport).toBe('mesh');
    expect(decision.reason).toMatch(/no media server/i);
  });

  it('refuses a large auto meeting with no SFU rather than silently degrading', () => {
    expect(() => decideTransport('auto', 30)).toThrow(/needs a media server/i);
  });

  it('refuses an explicit sfu request with no SFU, naming the env vars', () => {
    expect(() => decideTransport('sfu', 2)).toThrow(/CLOUDFLARE_REALTIME_APP_ID/);
  });

  it('refuses an explicit Cloudflare request when it is not configured', () => {
    expect(isCloudflareSfuConfigured()).toBe(false);
    expect(() => decideTransport('cloudflare', 2)).toThrow(/CLOUDFLARE_REALTIME_APP_ID/);
  });

  it('names Cloudflare in the message when a meeting is too big for mesh', () => {
    // The error is the only place someone learns what to do about it, so it
    // has to name the thing they must set — not the thing we removed.
    expect(() => decideTransport('auto', 30)).toThrow(/CLOUDFLARE_REALTIME_APP_ID/);
  });
});

describe('transport selection with Cloudflare configured', () => {
  const withCloudflare = <T>(fn: () => T): T => withMediaServer('cloudflare', fn);

  it('prefers Cloudflare for an automatic meeting', () => {
    withCloudflare(() => {
      expect(decideTransport('auto', 2).transport).toBe('cloudflare');
      expect(decideTransport('auto', 400).transport).toBe('cloudflare');
    });
  });

  it('answers the legacy "sfu" request with the SFU this deployment has', () => {
    // 'sfu' used to name the self-hosted server. A meeting stored with it must
    // still open rather than erroring on a value that no longer exists.
    withCloudflare(() => {
      expect(decideTransport('sfu', 2).transport).toBe('cloudflare');
    });
  });

  it('still honours an explicit mesh request for a small call', () => {
    withCloudflare(() => {
      expect(decideTransport('mesh', 2).transport).toBe('mesh');
    });
  });
});

describe('admission policy', () => {
  const meeting = { host_id: 'host-1', status: 'live' } as never;
  const base = {
    meeting, settings: DEFAULT_MEET_SETTINGS, userId: 'user-2',
    isInvited: false, isConversationMember: false, hasHostControls: false,
  };

  it('lets the host in even when the meeting is locked', () => {
    const decision = decideAdmission({
      ...base,
      userId: 'host-1',
      settings: { ...DEFAULT_MEET_SETTINGS, locked: true },
    });
    // The host must never be able to lock themselves out of their own meeting.
    expect(decision.state).toBe('active');
    expect(decision.role).toBe('host');
  });

  it('refuses everyone else when locked', () => {
    const decision = decideAdmission({
      ...base, settings: { ...DEFAULT_MEET_SETTINGS, locked: true },
    });
    expect(decision.state).toBe('denied');
  });

  it('refuses an anonymous joiner unless the meeting is public', () => {
    expect(decideAdmission({ ...base, userId: null }).state).toBe('denied');
  });

  it('makes a guest knock even in a public meeting', () => {
    const decision = decideAdmission({
      ...base, userId: null,
      settings: { ...DEFAULT_MEET_SETTINGS, admissionPolicy: 'public' },
    });
    // Opening a meeting to the public without seeing who walks in is not
    // something a school should be able to do by accident.
    expect(decision.state).toBe('knocking');
  });

  it('makes a guest knock even when the lobby is switched off', () => {
    const decision = decideAdmission({
      ...base, userId: null,
      settings: { ...DEFAULT_MEET_SETTINGS, admissionPolicy: 'public', lobbyEnabled: false },
    });
    expect(decision.state).toBe('knocking');
  });

  it('admits an invited user without a knock', () => {
    expect(decideAdmission({ ...base, isInvited: true }).state).toBe('active');
  });

  it('admits a member of the originating conversation when trusted', () => {
    expect(decideAdmission({ ...base, isConversationMember: true }).state).toBe('active');
  });

  it('makes an uninvited stranger knock', () => {
    expect(decideAdmission(base).state).toBe('knocking');
  });

  it('skips the lobby entirely when it is disabled', () => {
    const decision = decideAdmission({
      ...base, settings: { ...DEFAULT_MEET_SETTINGS, lobbyEnabled: false },
    });
    expect(decision.state).toBe('active');
  });

  it('holds everyone in the lobby until the host arrives', () => {
    const decision = decideAdmission({
      ...base,
      meeting: { host_id: 'host-1', status: 'scheduled' } as never,
      isInvited: true,
    });
    expect(decision.state).toBe('lobby');
  });

  it('makes an invited meeting-runner a co-host, not an attendee', () => {
    const decision = decideAdmission({ ...base, isInvited: true, hasHostControls: true });
    expect(decision.role).toBe('cohost');
  });
});

describe('admission policy', () => {
  const meeting = { host_id: 'host-1', status: 'live' } as never;
  const base = {
    meeting, userId: 'user-2', isInvited: false,
    isConversationMember: false, hasHostControls: false, hasJoinPermission: true,
  };
  const withPolicy = (policy: MeetAdmissionPolicy) =>
    ({ ...DEFAULT_MEET_SETTINGS, admissionPolicy: policy });

  it('defaults to the permission-based policy', () => {
    expect(DEFAULT_MEET_SETTINGS.admissionPolicy).toBe('permission');
  });

  describe('permission', () => {
    it('refuses an account whose role cannot join meetings', () => {
      const decision = decideAdmission({
        ...base, settings: withPolicy('permission'), hasJoinPermission: false,
      });
      expect(decision.state).toBe('denied');
      expect(decision.reason).toMatch(/permission to join/i);
    });

    it('admits one that can', () => {
      expect(decideAdmission({ ...base, settings: withPolicy('permission') }).state)
        .toBe('knocking');
    });
  });

  describe('invited', () => {
    it('refuses anyone not on the list, so a forwarded link is useless', () => {
      const decision = decideAdmission({ ...base, settings: withPolicy('invited') });
      expect(decision.state).toBe('denied');
      expect(decision.reason).toMatch(/invited people only/i);
    });

    it('admits an invitee straight in', () => {
      expect(decideAdmission({
        ...base, settings: withPolicy('invited'), isInvited: true,
      }).state).toBe('active');
    });

    it('admits a member of the originating conversation', () => {
      expect(decideAdmission({
        ...base, settings: withPolicy('invited'), isConversationMember: true,
      }).state).toBe('active');
    });
  });

  describe('authenticated', () => {
    it('admits a signed-in user who lacks MEET_JOIN — that is the point', () => {
      const decision = decideAdmission({
        ...base, settings: withPolicy('authenticated'), hasJoinPermission: false,
      });
      expect(decision.state).toBe('knocking');
    });

    it('still refuses someone with no account at all', () => {
      expect(decideAdmission({
        ...base, settings: withPolicy('authenticated'), userId: null,
      }).state).toBe('denied');
    });
  });

  describe('public', () => {
    it('admits a stranger, into the lobby', () => {
      expect(decideAdmission({
        ...base, settings: withPolicy('public'), userId: null, hasJoinPermission: false,
      }).state).toBe('knocking');
    });

    it('still refuses everyone once the meeting is locked', () => {
      expect(decideAdmission({
        ...base, userId: null,
        settings: { ...withPolicy('public'), locked: true },
      }).state).toBe('denied');
    });
  });

  it('lets the host in under every policy', () => {
    for (const policy of ['permission', 'invited', 'authenticated', 'public'] as const) {
      expect(decideAdmission({
        ...base, userId: 'host-1', settings: withPolicy(policy), hasJoinPermission: false,
      }).state).toBe('active');
    }
  });
});

describe('meeting names', () => {
  it('proposes a name built from the timestamp', () => {
    const name = defaultMeetingName(new Date('2026-08-21T09:30:00'), 'scheduled');
    expect(name).toMatch(/^Meeting · /);
    // A list of meetings all called "Meeting" is unusable; the timestamp is the
    // one thing always true and always distinguishing.
    expect(name.length).toBeGreaterThan('Meeting · '.length);
  });

  it('recognises its own proposal, so the AI may replace it but not a real name', () => {
    expect(isDefaultMeetingName(defaultMeetingName())).toBe(true);
    expect(isDefaultMeetingName('Meeting')).toBe(true);
    expect(isDefaultMeetingName('S4 Biology — photosynthesis')).toBe(false);
  });
});

describe('audience categories', () => {
  it('maps each category onto a policy the server enforces', () => {
    expect(CATEGORY_TO_POLICY.private).toBe('invited');
    expect(CATEGORY_TO_POLICY.loggedIn).toBe('authenticated');
    expect(CATEGORY_TO_POLICY.public).toBe('public');
  });

  it('round-trips every category', () => {
    for (const category of MEET_CATEGORIES) {
      expect(POLICY_TO_CATEGORY[CATEGORY_TO_POLICY[category]]).toBe(category);
    }
  });

  it('gives a meeting created before categories existed a sensible one', () => {
    expect(POLICY_TO_CATEGORY.permission).toBe('loggedIn');
  });
});

describe('meeting folders', () => {
  it('puts every recording for a meeting under one prefix', () => {
    expect(meetingFolder('123456789')).toBe('meetings/123456789');
    expect(MEETING_FOLDER_PATTERN.test(meetingFolder('123456789'))).toBe(true);
  });

  it('refuses anything that is not a meeting folder', () => {
    // The file service uses this to decide whether a caller may influence the
    // storage path at all, so traversal and sibling prefixes must not pass.
    for (const bad of [
      'meetings/../etc', 'meetings/abc', '../meetings/1', 'uploads/1',
      'meetings/1/2', 'meetings/', 'meetings/1 ', '',
    ]) {
      expect(MEETING_FOLDER_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('Cloudflare SFU track names', () => {
  it('derives a name from the participant, so nothing has to be exchanged', () => {
    expect(sfuTrackName('12345', 'cam')).toBe('cam-12345');
    expect(sfuTrackName('12345', 'mic')).toBe('mic-12345');
    expect(sfuTrackName('12345', 'screen')).toBe('screen-12345');
  });

  it('round-trips', () => {
    for (const kind of ['cam', 'mic', 'screen', 'screenaudio'] as const) {
      expect(parseSfuTrackName(sfuTrackName('98765', kind)))
        .toEqual({ kind, participantId: '98765' });
    }
  });

  it('refuses a name it did not generate', () => {
    // The API uses this to decide whether a subscriber may pull a track, so an
    // arbitrary string must never parse into something that looks legitimate.
    for (const bad of ['', 'cam', 'cam-', 'video-123', 'CAM-123', '-123']) {
      expect(parseSfuTrackName(bad)).toBeNull();
    }
  });
});

describe('capacity by transport', () => {
  it('keeps peer-to-peer small and lets an SFU meeting be large', () => {
    // The constraint is different in kind: mesh is bounded by every
    // publisher's uplink, an SFU by each subscriber's downlink — and the
    // subscriber only ever pulls the tiles on screen.
    expect(capacityFor('mesh', false)).toBe(MESH_MAX_PARTICIPANTS);
    expect(capacityFor('cloudflare', false)).toBeGreaterThanOrEqual(500);
    expect(capacityFor('cloudflare', true)).toBeGreaterThan(capacityFor('cloudflare', false));
    expect(CAPACITY.cloudflare.video).toBeGreaterThan(CAPACITY.mesh.video);
  });

  it('knows which transports route through a media server', () => {
    expect(isSfuTransport('cloudflare')).toBe(true);
    expect(isSfuTransport('mesh')).toBe(false);
  });

  it('enforces the ceiling per transport', () => {
    // Mesh explains *why* it is capped; see 'capacity messages' below.
    expect(() => assertCapacity(DEFAULT_MEET_SETTINGS, 4, 'mesh')).toThrow(/limited to 4/i);
    expect(() => assertCapacity(DEFAULT_MEET_SETTINGS, 4, 'cloudflare')).not.toThrow();
    expect(() => assertCapacity(DEFAULT_MEET_SETTINGS, 499, 'cloudflare')).not.toThrow();
    expect(() => assertCapacity(DEFAULT_MEET_SETTINGS, 500, 'cloudflare')).toThrow(/full/i);
  });
});

describe('capacity messages', () => {
  it('explains the peer-to-peer cap rather than just saying "full"', () => {
    // "Full at 4" is true and useless. The reason is that there is no media
    // server, which is the thing someone can act on.
    expect(() => assertCapacity(DEFAULT_MEET_SETTINGS, 4, 'mesh'))
      .toThrow(/CLOUDFLARE_REALTIME_APP_ID/);
  });

  it('says plainly that a large meeting is full', () => {
    expect(() => assertCapacity(DEFAULT_MEET_SETTINGS, 500, 'cloudflare'))
      .toThrow(/full \(500 participants\)/);
  });
});


describe('engagement', () => {
  it('counts words rather than asking a model to', () => {
    const report = computeEngagement([
      { speaker: 'Alice', text: 'one two three four', offsetSeconds: 0 },
      { speaker: 'Bob', text: 'five six', offsetSeconds: 10 },
      { speaker: 'Alice', text: 'seven eight', offsetSeconds: 20 },
    ], ['Alice', 'Bob', 'Carol']);

    expect(report.totalWords).toBe(8);
    expect(report.totalSpeakers).toBe(2);
    expect(report.talkTime[0]!.speaker).toBe('Alice');
    expect(report.talkTime[0]!.words).toBe(6);
    expect(report.talkTime[0]!.share).toBeCloseTo(0.75, 2);
    expect(report.silentParticipants).toEqual(['Carol']);
  });

  it('scores an even split higher than a monologue', () => {
    const even = computeEngagement([
      { speaker: 'A', text: 'a a a a', offsetSeconds: 0 },
      { speaker: 'B', text: 'b b b b', offsetSeconds: 0 },
    ], ['A', 'B']);
    const lopsided = computeEngagement([
      { speaker: 'A', text: 'a '.repeat(100), offsetSeconds: 0 },
      { speaker: 'B', text: 'b', offsetSeconds: 0 },
    ], ['A', 'B']);
    expect(even.balanceScore).toBeGreaterThan(lopsided.balanceScore);
  });

  it('measures balance against everyone present, not only those who spoke', () => {
    // One pupil answering every question in a class of four is NOT balanced,
    // even though the only two speakers split it evenly.
    const report = computeEngagement([
      { speaker: 'A', text: 'a a a a', offsetSeconds: 0 },
      { speaker: 'B', text: 'b b b b', offsetSeconds: 0 },
    ], ['A', 'B', 'C', 'D']);
    expect(report.balanceScore).toBeLessThan(0.8);
  });

  it('does not divide by zero on an empty transcript', () => {
    const report = computeEngagement([], ['A']);
    expect(report.totalWords).toBe(0);
    expect(report.talkTime).toEqual([]);
    expect(Number.isFinite(report.balanceScore)).toBe(true);
  });
});

describe('transcript rendering', () => {
  const lines = Array.from({ length: 500 }, (_, i) => ({
    speaker: `S${i % 3}`, text: `line number ${i}`, offsetSeconds: i * 5,
  }));

  it('timestamps each line so chapters can be placed', () => {
    expect(renderTranscript(lines.slice(0, 2)))
      .toBe('[00:00] S0: line number 0\n[00:05] S1: line number 1');
  });

  it('keeps the tail when a long meeting exceeds the budget', () => {
    const rendered = renderTranscript(lines, 500);
    expect(rendered).toContain('earlier discussion omitted');
    expect(rendered).toContain('line number 499');
    expect(rendered).not.toContain('line number 0:');
  });
});

/* ================================================================== *
 * HTTP surface
 * ================================================================== */

describe('capabilities', () => {
  it('reports honestly what this deployment can do', async () => {
    const staff = await userWithRole('Staff');
    const res = await request(app).get('/api/meet/capabilities')
      .set('Authorization', `Bearer ${staff.token}`);
    // Asserted with the body in the message rather than `.expect(200)`. This
    // endpoint was seen to 404 twice during development and never since; if it
    // recurs, the body says whether the router declined it ("Meeting not
    // found." — route shadowing) or Express never reached it at all ("Not
    // found" — the app catch-all).
    expect(`${res.status} ${JSON.stringify(res.body)}`).toMatch(/^200 /);

    expect(res.body.data.sfu).toBe(isCloudflareSfuConfigured());
    expect(res.body.data.turn).toBe(isTurnConfigured());
    expect(res.body.data.meshMaxParticipants).toBe(MESH_MAX_PARTICIPANTS);
    // Never leaks a credential — only booleans about the server.
    expect(JSON.stringify(res.body)).not.toMatch(/sk-|gsk_|AIza/);
  });

  it('requires a session', async () => {
    await request(app).get('/api/meet/capabilities').expect(401);
  });
});

describe('creating meetings', () => {
  it('creates one with a unique code and a live status', async () => {
    const staff = await userWithRole('Staff');
    const res = await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ title: 'Staff briefing' }).expect(201);

    expect(res.body.data.join_code).toMatch(JOIN_CODE_PATTERN);
    expect(res.body.data.status).toBe('live');
    expect(res.body.data.title).toBe('Staff briefing');
    // An instant call has no lobby: whoever you just called is already someone
    // you were talking to.
    expect(res.body.data.settings.lobbyEnabled).toBe(false);
  });

  it('logs meeting.created as an event', async () => {
    const staff = await userWithRole('Staff');
    const res = await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${staff.token}`).send({}).expect(201);

    const { rows } = await getPool().query(
      `SELECT type, severity FROM meeting_events WHERE meeting_id = $1`, [res.body.data.id]);
    expect(rows.map((r) => r.type)).toContain('meeting.created');
  });

  it('refuses a student', async () => {
    const student = await userWithRole('Student');
    await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${student.token}`).send({}).expect(403);
  });

  it('refuses to schedule for someone who may only start one now', async () => {
    const staff = await userWithRole('Staff');
    const pool = getPool();
    // Strip MEET_SCHEDULE from Staff to isolate the two permissions.
    await pool.query(
      `DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE name = 'Staff')
         AND permission_id = (SELECT id FROM permissions WHERE key = 'MEET_SCHEDULE')`);

    await request(app).post('/api/meet')
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ title: 'Later', scheduledStart: new Date(Date.now() + 3.6e6).toISOString() })
      .expect(403);
  });

  it('refuses recording, transcription and AI to a role that lacks each permission', async () => {
    const pool = getPool();
    const roleId = (await pool.query<{ id: number }>(
      "SELECT id FROM roles WHERE name = 'Staff'")).rows[0]!.id;
    for (const key of ['MEET_RECORD', 'MEET_TRANSCRIBE', 'MEET_AI_USE']) {
      await pool.query(
        `DELETE FROM role_permissions WHERE role_id = $1
           AND permission_id = (SELECT id FROM permissions WHERE key = $2)`, [roleId, key]);
    }
    const staff = await userWithRole('Staff');

    for (const setting of ['recordingEnabled', 'transcriptionEnabled', 'aiAssistantEnabled']) {
      const res = await request(app).post('/api/meet')
        .set('Authorization', `Bearer ${staff.token}`)
        .send({ title: 'x', settings: { [setting]: true } })
        .expect(403);
      expect(res.body.message).toMatch(/permission/i);
    }
  });

  it('rejects a title longer than the schema allows', async () => {
    const staff = await userWithRole('Staff');
    await request(app).post('/api/meet')
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ title: 'x'.repeat(500) }).expect(400);
  });
});

describe('lookup and joining', () => {
  async function liveMeeting(hostToken: string, settings?: Record<string, unknown>) {
    const res = await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${hostToken}`)
      .send({ title: 'Lesson', settings }).expect(201);
    return res.body.data as { id: string; join_code: string };
  }

  it('finds a meeting by its shareable code as well as its id', async () => {
    const staff = await userWithRole('Staff');
    const meeting = await liveMeeting(staff.token);

    const byCode = await request(app).get(`/api/meet/${meeting.join_code}`)
      .set('Authorization', `Bearer ${staff.token}`).expect(200);
    expect(byCode.body.data.id).toBe(meeting.id);
  });

  it('404s an unknown code rather than leaking whether it exists', async () => {
    const staff = await userWithRole('Staff');
    await request(app).get('/api/meet/bcd-fghj-kmn')
      .set('Authorization', `Bearer ${staff.token}`).expect(404);
  });

  it('issues a join ticket carrying ICE servers and the chosen transport', async () => {
    const staff = await userWithRole('Staff');
    const meeting = await liveMeeting(staff.token);

    const res = await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${staff.token}`).send({}).expect(200);

    expect(res.body.data.role).toBe('host');
    expect(res.body.data.state).toBe('active');
    expect(res.body.data.transport).toBe('mesh');
    expect(Array.isArray(res.body.data.iceServers)).toBe(true);
    expect(res.body.data.iceServers.length).toBeGreaterThan(0);
    // No SFU here, so no room token — and never an empty-string one.
    expect(res.body.data.sfuEndpoint).toBeUndefined();
  });

  it('creates exactly one participant row across repeated joins', async () => {
    const staff = await userWithRole('Staff');
    const meeting = await liveMeeting(staff.token);

    await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${staff.token}`).send({}).expect(200);
    await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${staff.token}`).send({}).expect(200);

    const { rows } = await getPool().query(
      'SELECT id FROM meeting_participants WHERE meeting_id = $1', [meeting.id]);
    // A reconnect must not produce two half-attendances in the export.
    expect(rows).toHaveLength(1);
  });

  it('puts an uninvited joiner in the lobby when there is a waiting room', async () => {
    // Run with the media server on, so the second assertion means something:
    // with no SFU configured there is no endpoint to withhold in the first
    // place, and the test would pass without proving anything.
    await withMediaServerAsync('cloudflare', async () => {
      const host = await userWithRole('Staff', 'Host');
      const guest = await userWithRole('Student', 'Pupil');
      const meeting = await liveMeeting(host.token, { lobbyEnabled: true });

      const res = await request(app).post(`/api/meet/${meeting.id}/join`)
        .set('Authorization', `Bearer ${guest.token}`).send({}).expect(200);

      expect(res.body.data.state).toBe('knocking');
      expect(res.body.data.transport).toBe('cloudflare');
      // Critically: no way to reach the media server while still outside.
      expect(res.body.data.sfuEndpoint).toBeUndefined();
    });
  });

  it('refuses a media token to someone who has not been admitted', async () => {
    const host = await userWithRole('Staff', 'Host');
    const pupil = await userWithRole('Student', 'Pupil');
    const meeting = await liveMeeting(host.token, { lobbyEnabled: true });

    await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${pupil.token}`).send({}).expect(200);
    const res = await request(app).post(`/api/meet/${meeting.id}/token`)
      .set('Authorization', `Bearer ${pupil.token}`).expect(409);
    expect(res.body.message).toMatch(/not been admitted/i);
  });

  it('refuses to join an ended meeting', async () => {
    const staff = await userWithRole('Staff');
    const meeting = await liveMeeting(staff.token);
    await request(app).post(`/api/meet/${meeting.id}/end`)
      .set('Authorization', `Bearer ${staff.token}`).expect(200);

    await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${staff.token}`).send({}).expect(410);
  });

  it('refuses to join a locked meeting', async () => {
    const host = await userWithRole('Staff', 'Host');
    const other = await userWithRole('Staff', 'Other');
    const meeting = await liveMeeting(host.token, { locked: true });

    await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${other.token}`).send({}).expect(403);
  });

  it('lets the host into their own locked meeting', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = await liveMeeting(host.token, { locked: true });
    await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(200);
  });

  it('refuses a fifth participant on the mesh transport, and explains', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = await liveMeeting(host.token, { lobbyEnabled: false });

    for (let i = 0; i < MESH_MAX_PARTICIPANTS - 1; i++) {
      const user = await userWithRole('Staff', `Person ${i}`);
      await request(app).post(`/api/meet/${meeting.id}/join`)
        .set('Authorization', `Bearer ${user.token}`).send({}).expect(200);
    }
    await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(200);

    const overflow = await userWithRole('Staff', 'One too many');
    const res = await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${overflow.token}`).send({}).expect(409);
    // The refusal names what would lift the cap, not merely that it was hit.
    expect(res.body.message).toMatch(/CLOUDFLARE_REALTIME_APP_ID/);
  });
});

describe('host authority', () => {
  it('lets only the host or a co-host end a meeting', async () => {
    const host = await userWithRole('Staff', 'Host');
    const other = await userWithRole('Staff', 'Other');
    const meeting = (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(201)).body.data;

    await request(app).post(`/api/meet/${meeting.id}/end`)
      .set('Authorization', `Bearer ${other.token}`).expect(403);
    await request(app).post(`/api/meet/${meeting.id}/end`)
      .set('Authorization', `Bearer ${host.token}`).expect(200);
  });

  it('closes every open participant leg when the meeting ends', async () => {
    const host = await userWithRole('Staff', 'Host');
    const pupil = await userWithRole('Staff', 'Pupil');
    const meeting = (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${host.token}`)
      .send({ settings: { lobbyEnabled: false } }).expect(201)).body.data;

    await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${pupil.token}`).send({}).expect(200);
    await request(app).post(`/api/meet/${meeting.id}/end`)
      .set('Authorization', `Bearer ${host.token}`).expect(200);

    const { rows } = await getPool().query(
      'SELECT left_at, state FROM meeting_participants WHERE meeting_id = $1', [meeting.id]);
    // An attendance row with a NULL left_at is one nobody can interpret.
    expect(rows.every((r) => r.left_at !== null && r.state === 'left')).toBe(true);
  });

  it('re-checks permissions on the settings back door', async () => {
    const pool = getPool();
    await pool.query(
      `DELETE FROM role_permissions
        WHERE role_id = (SELECT id FROM roles WHERE name = 'Staff')
          AND permission_id = (SELECT id FROM permissions WHERE key = 'MEET_RECORD')`);
    const host = await userWithRole('Staff', 'Host');
    const meeting = (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(201)).body.data;

    await request(app).put(`/api/meet/${meeting.id}/settings`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({ recordingEnabled: true }).expect(403);
  });

  it('cancels rather than deletes, so the record survives', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(201)).body.data;

    await request(app).delete(`/api/meet/${meeting.id}`)
      .set('Authorization', `Bearer ${host.token}`).expect(200);

    const { rows } = await getPool().query('SELECT status FROM meetings WHERE id = $1', [meeting.id]);
    expect(rows[0]!.status).toBe('cancelled');
  });
});

describe('attendance', () => {
  it('exports CSV with the columns a lesson record needs', async () => {
    const host = await userWithRole('Staff', 'Teacher');
    const meeting = (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(201)).body.data;
    await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(200);

    const res = await request(app).get(`/api/meet/${meeting.id}/attendance?format=csv`)
      .set('Authorization', `Bearer ${host.token}`).expect(200);

    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=/);
    expect(res.text.split('\n')[0]).toContain('Name,Email,MIS ID,Role,Joined,Left,Duration (min)');
    expect(res.text).toContain('Teacher');
  });

  it('neutralises a cell that a spreadsheet would run as a formula', async () => {
    const host = await userWithRole('Staff', '=cmd|calc');
    const meeting = (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(201)).body.data;
    await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(200);

    const res = await request(app).get(`/api/meet/${meeting.id}/attendance?format=csv`)
      .set('Authorization', `Bearer ${host.token}`).expect(200);
    expect(res.text).toContain(`"'=cmd|calc"`);
  });

  it('refuses a student', async () => {
    const host = await userWithRole('Staff', 'Host');
    const pupil = await userWithRole('Student', 'Pupil');
    const meeting = (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(201)).body.data;

    await request(app).get(`/api/meet/${meeting.id}/attendance`)
      .set('Authorization', `Bearer ${pupil.token}`).expect(403);
  });
});

describe('transcript access', () => {
  it('refuses someone who was never in the meeting', async () => {
    const host = await userWithRole('Staff', 'Host');
    const stranger = await userWithRole('Staff', 'Stranger');
    const meeting = (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(201)).body.data;

    const res = await request(app).get(`/api/meet/${meeting.id}/transcript`)
      .set('Authorization', `Bearer ${stranger.token}`).expect(403);
    expect(res.body.message).toMatch(/not in this meeting/i);
  });

  it('serves it, speaker-attributed, to someone who was', async () => {
    const host = await userWithRole('Staff', 'Teacher');
    const meeting = (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(201)).body.data;
    const join = await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(200);

    await getPool().query(
      `INSERT INTO meeting_transcript_segments
         (id, meeting_id, participant_id, speaker_name, text, offset_seconds)
       VALUES ($1,$2,$3,'Teacher','Photosynthesis needs light.',12)`,
      [snowflake(), meeting.id, join.body.data.participantId]);

    const res = await request(app).get(`/api/meet/${meeting.id}/transcript`)
      .set('Authorization', `Bearer ${host.token}`).expect(200);
    expect(res.body.data[0]).toEqual({
      speaker: 'Teacher', text: 'Photosynthesis needs light.', offsetSeconds: 12,
    });
  });
});

describe('AI endpoints', () => {
  async function meetingWithTranscript(hostToken: string, aiEnabled: boolean, segments = 10) {
    const meeting = (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${hostToken}`)
      .send({ settings: aiEnabled ? { aiAssistantEnabled: true } : {} }).expect(201)).body.data;
    const join = await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${hostToken}`).send({}).expect(200);

    for (let i = 0; i < segments; i++) {
      await getPool().query(
        `INSERT INTO meeting_transcript_segments
           (id, meeting_id, participant_id, speaker_name, text, offset_seconds)
         VALUES ($1,$2,$3,'Teacher',$4,$5)`,
        [snowflake(), meeting.id, join.body.data.participantId, `Sentence ${i}.`, i * 6]);
    }
    return meeting;
  }

  it('refuses a role without MEET_AI_USE', async () => {
    const host = await userWithRole('Staff', 'Host');
    const pupil = await userWithRole('Student', 'Pupil');
    const meeting = await meetingWithTranscript(host.token, true);

    await request(app).post(`/api/meet/${meeting.id}/ai/summary`)
      .set('Authorization', `Bearer ${pupil.token}`).expect(403);
  });

  it('refuses when the meeting has AI switched off, even for a permitted host', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = await meetingWithTranscript(host.token, false);

    const res = await request(app).post(`/api/meet/${meeting.id}/ai/summary`)
      .set('Authorization', `Bearer ${host.token}`).expect(409);
    expect(res.body.message).toMatch(/not enabled/i);
  });

  it('refuses when there is almost no transcript rather than inventing one', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = await meetingWithTranscript(host.token, true, 1);

    const res = await request(app).post(`/api/meet/${meeting.id}/ai/summary`)
      .set('Authorization', `Bearer ${host.token}`).expect(409);
    expect(res.body.message).toMatch(/not enough transcript/i);
  });

  it('computes engagement from the transcript without calling a model', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = await meetingWithTranscript(host.token, true);

    const res = await request(app).post(`/api/meet/${meeting.id}/ai/engagement`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({ narrate: false }).expect(200);

    expect(res.body.data.content.totalSpeakers).toBe(1);
    expect(res.body.data.content.talkTime[0].speaker).toBe('Teacher');
    // Counted, not generated — so no provider was involved.
    expect(res.body.data.providerUsed).toBeUndefined();
  });

  it('persists a generated artifact with the provider that produced it', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = await meetingWithTranscript(host.token, true);
    await request(app).post(`/api/meet/${meeting.id}/ai/engagement`)
      .set('Authorization', `Bearer ${host.token}`).send({ narrate: false }).expect(200);

    const res = await request(app).get(`/api/meet/${meeting.id}/ai`)
      .set('Authorization', `Bearer ${host.token}`).expect(200);
    expect(res.body.data.map((a: { kind: string }) => a.kind)).toContain('engagement');
  });
});

describe('ICS export', () => {
  it('emits a calendar entry with CRLF line endings and the join link', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = (await request(app).post('/api/meet')
      .set('Authorization', `Bearer ${host.token}`)
      .send({
        title: 'Parents evening',
        scheduledStart: new Date(Date.now() + 86_400_000).toISOString(),
        scheduledEnd: new Date(Date.now() + 90_000_000).toISOString(),
      }).expect(201)).body.data;

    const res = await request(app).get(`/api/meet/${meeting.id}/ics`)
      .set('Authorization', `Bearer ${host.token}`).expect(200);

    expect(res.headers['content-type']).toMatch(/text\/calendar/);
    expect(res.text).toContain('BEGIN:VCALENDAR');
    expect(res.text).toContain('END:VEVENT');
    // RFC 5545 requires CRLF; a bare LF is silently dropped by some clients.
    expect(res.text).toContain('\r\n');
    expect(res.text).toContain(meeting.join_code);
  });
});

describe('the meetings list', () => {
  it('shows a user only meetings they host, were invited to, or attended', async () => {
    const mine = await userWithRole('Staff', 'Mine');
    const theirs = await userWithRole('Staff', 'Theirs');

    await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${mine.token}`).send({ title: 'Mine' }).expect(201);
    await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${theirs.token}`).send({ title: 'Theirs' }).expect(201);

    const res = await request(app).get('/api/meet')
      .set('Authorization', `Bearer ${mine.token}`).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('Mine');
  });

  it('filters by scope', async () => {
    const staff = await userWithRole('Staff');
    await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${staff.token}`).send({ title: 'Live one' }).expect(201);

    const live = await request(app).get('/api/meet?scope=live')
      .set('Authorization', `Bearer ${staff.token}`).expect(200);
    expect(live.body.data).toHaveLength(1);

    const past = await request(app).get('/api/meet?scope=past')
      .set('Authorization', `Bearer ${staff.token}`).expect(200);
    expect(past.body.data).toHaveLength(0);
  });
});


/* ================================================================== *
 * Naming, deletion, the directory and recording
 * ================================================================== */

describe('naming a meeting', () => {
  it('gives an unnamed meeting a name rather than calling it "Meeting"', async () => {
    const staff = await userWithRole('Staff');
    const res = await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${staff.token}`).send({}).expect(201);
    expect(isDefaultMeetingName(res.body.data.title)).toBe(true);
    expect(res.body.data.title).not.toBe('Meeting');
  });

  it('keeps a name the user actually chose', async () => {
    const staff = await userWithRole('Staff');
    const res = await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ title: 'S4 Biology — photosynthesis' }).expect(201);
    expect(res.body.data.title).toBe('S4 Biology — photosynthesis');
  });

  it('lets a host rename it', async () => {
    const staff = await userWithRole('Staff');
    const meeting = (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${staff.token}`).send({}).expect(201)).body.data;

    const res = await request(app).put(`/api/meet/${meeting.id}/name`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ title: 'Parents evening' }).expect(200);
    expect(res.body.data.title).toBe('Parents evening');
  });

  it('refuses an empty name', async () => {
    const staff = await userWithRole('Staff');
    const meeting = (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${staff.token}`).send({}).expect(201)).body.data;
    await request(app).put(`/api/meet/${meeting.id}/name`)
      .set('Authorization', `Bearer ${staff.token}`).send({ title: '   ' }).expect(400);
  });

  it('refuses a rename from someone who is not running the meeting', async () => {
    const host = await userWithRole('Staff', 'Host');
    const other = await userWithRole('Staff', 'Other');
    const meeting = (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(201)).body.data;
    await request(app).put(`/api/meet/${meeting.id}/name`)
      .set('Authorization', `Bearer ${other.token}`).send({ title: 'Mine now' }).expect(403);
  });
});

describe('deleting a meeting', () => {
  async function meetingBy(token: string) {
    return (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${token}`).send({}).expect(201)).body.data;
  }

  it('cancels by default, keeping the record', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = await meetingBy(host.token);

    const res = await request(app).delete(`/api/meet/${meeting.id}`)
      .set('Authorization', `Bearer ${host.token}`).expect(200);
    expect(res.body.data).toEqual({ cancelled: true, deleted: false });

    const { rows } = await getPool().query('SELECT status FROM meetings WHERE id = $1', [meeting.id]);
    expect(rows[0]!.status).toBe('cancelled');
  });

  it('deletes for real when asked, and everything cascades', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = await meetingBy(host.token);
    const join = await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(200);

    await getPool().query(
      `INSERT INTO meeting_transcript_segments (id, meeting_id, participant_id, speaker_name, text)
       VALUES ($1,$2,$3,'Host','Something was said.')`,
      [snowflake(), meeting.id, join.body.data.participantId]);

    await request(app).delete(`/api/meet/${meeting.id}?purge=true`)
      .set('Authorization', `Bearer ${host.token}`).expect(200);

    for (const table of [
      'meetings', 'meeting_participants', 'meeting_transcript_segments', 'meeting_events',
    ]) {
      const { rows } = await getPool().query(
        `SELECT 1 FROM ${table} WHERE ${table === 'meetings' ? 'id' : 'meeting_id'} = $1`,
        [meeting.id]);
      expect(rows).toHaveLength(0);
    }
  });

  it('audit-logs the deletion before the rows describing it disappear', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = await meetingBy(host.token);
    await request(app).delete(`/api/meet/${meeting.id}?purge=true`)
      .set('Authorization', `Bearer ${host.token}`).expect(200);

    const { rows } = await getPool().query(
      `SELECT metadata FROM audit_log WHERE action = 'meet.deleted' AND target_id = $1`,
      [meeting.id]);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.metadata as { title: string }).title).toBeTruthy();
  });

  it('refuses a co-host — deleting is the creator\'s alone', async () => {
    const host = await userWithRole('Staff', 'Host');
    const cohost = await userWithRole('Staff', 'Co-host');
    const meeting = await meetingBy(host.token);
    await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(200);
    const join = await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${cohost.token}`).send({}).expect(200);
    await getPool().query(
      `UPDATE meeting_participants SET role = 'cohost' WHERE id = $1`,
      [join.body.data.participantId]);

    const res = await request(app).delete(`/api/meet/${meeting.id}?purge=true`)
      .set('Authorization', `Bearer ${cohost.token}`).expect(403);
    expect(res.body.message).toMatch(/only the person who created/i);
  });

  it('refuses a platform administrator too', async () => {
    const host = await userWithRole('Staff', 'Host');
    const admin = await userWithRole('Admin', 'Admin');
    const meeting = await meetingBy(host.token);
    // An admin can end a meeting; destroying its evidence is a different thing.
    await request(app).delete(`/api/meet/${meeting.id}?purge=true`)
      .set('Authorization', `Bearer ${admin.token}`).expect(403);
  });
});

describe('the people directory', () => {
  it('finds someone by name', async () => {
    const staff = await userWithRole('Staff', 'Searcher');
    await userWithRole('Student', 'Mukamana Grace');

    const res = await request(app).get('/api/meet/directory?q=Mukamana')
      .set('Authorization', `Bearer ${staff.token}`).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Mukamana Grace');
  });

  it('refuses to list the institution to a bare query', async () => {
    const staff = await userWithRole('Staff', 'Searcher');
    await userWithRole('Student', 'Someone Else');
    const res = await request(app).get('/api/meet/directory?q=a')
      .set('Authorization', `Bearer ${staff.token}`).expect(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('never returns the searcher to themselves', async () => {
    const staff = await userWithRole('Staff', 'Findable Person');
    const res = await request(app).get('/api/meet/directory?q=Findable')
      .set('Authorization', `Bearer ${staff.token}`).expect(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('is closed to a role that cannot create meetings', async () => {
    const student = await userWithRole('Student', 'Pupil');
    await request(app).get('/api/meet/directory?q=Someone')
      .set('Authorization', `Bearer ${student.token}`).expect(403);
  });
});

describe('recording', () => {
  async function recordableMeeting(token: string) {
    const meeting = (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${token}`)
      .send({ settings: { recordingEnabled: true } }).expect(201)).body.data;
    return meeting;
  }

  it('records in the browser when there is no media server', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = await recordableMeeting(host.token);

    const res = await request(app).post(`/api/meet/${meeting.id}/recording/start`)
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(200);
    // The only place a composite can be made is the host's browser — Cloudflare
    // routes tracks and does not composite them.
    expect(res.body.data.mode).toBe('client');
    expect(res.body.data.folder).toBe(`meetings/${meeting.id}`);
  });

  it('refuses server-side recording, and says where recording is made instead', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = await recordableMeeting(host.token);
    const res = await request(app).post(`/api/meet/${meeting.id}/recording/start`)
      .set('Authorization', `Bearer ${host.token}`).send({ mode: 'server' }).expect(503);
    expect(res.body.message).toMatch(/host browser/i);
  });

  it('records in the browser even with the media server configured', async () => {
    // The regression this pins: the room asked for server-side recording
    // whenever an SFU was present, and the API then refused it — so turning the
    // media server on silently turned recording off. Cloudflare is an SFU, not
    // a recording product; there is no server-side path to fall back to.
    await withMediaServerAsync('cloudflare', async () => {
      const host = await userWithRole('Staff', 'Host');
      const meeting = await recordableMeeting(host.token);
      const res = await request(app).post(`/api/meet/${meeting.id}/recording/start`)
        .set('Authorization', `Bearer ${host.token}`).send({}).expect(200);
      expect(res.body.data.mode).toBe('client');
    });
  });

  it('refuses a second recording while one is running', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = await recordableMeeting(host.token);
    await request(app).post(`/api/meet/${meeting.id}/recording/start`)
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(200);
    await request(app).post(`/api/meet/${meeting.id}/recording/start`)
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(409);
  });

  it('refuses to attach a file that belongs to somebody else', async () => {
    const host = await userWithRole('Staff', 'Host');
    const stranger = await userWithRole('Staff', 'Stranger');
    const meeting = await recordableMeeting(host.token);
    const started = (await request(app).post(`/api/meet/${meeting.id}/recording/start`)
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(200)).body.data;

    const fileId = snowflake();
    await getPool().query(
      `INSERT INTO files (id, owner_id, storage_driver, storage_key, original_name,
                          mime_type, size_bytes, status)
       VALUES ($1,$2,'local',$3,'theirs.webm','video/webm',1000,'ready')`,
      [fileId, stranger.id, `meetings/${meeting.id}/${fileId}/theirs.webm`]);

    const res = await request(app)
      .post(`/api/meet/${meeting.id}/recordings/${started.recordingId}/attach`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({ fileId, durationSeconds: 10, sizeBytes: 1000 })
      .expect(403);
    expect(res.body.message).toMatch(/not yours/i);
  });

  it('refuses to attach an upload that never finished', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = await recordableMeeting(host.token);
    const started = (await request(app).post(`/api/meet/${meeting.id}/recording/start`)
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(200)).body.data;

    const fileId = snowflake();
    await getPool().query(
      `INSERT INTO files (id, owner_id, storage_driver, storage_key, original_name,
                          mime_type, size_bytes, status)
       VALUES ($1,$2,'local',$3,'partial.webm','video/webm',1000,'pending')`,
      [fileId, host.id, `meetings/${meeting.id}/${fileId}/partial.webm`]);

    await request(app).post(`/api/meet/${meeting.id}/recordings/${started.recordingId}/attach`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({ fileId, durationSeconds: 10, sizeBytes: 1000 })
      .expect(409);
  });

  it('attaches a finished upload and makes the recording readable', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = await recordableMeeting(host.token);
    const started = (await request(app).post(`/api/meet/${meeting.id}/recording/start`)
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(200)).body.data;
    await request(app).post(`/api/meet/${meeting.id}/recording/stop`)
      .set('Authorization', `Bearer ${host.token}`).expect(200);

    const fileId = snowflake();
    await getPool().query(
      `INSERT INTO files (id, owner_id, storage_driver, storage_key, original_name,
                          mime_type, size_bytes, status)
       VALUES ($1,$2,'local',$3,'meeting.webm','video/webm',2048,'ready')`,
      [fileId, host.id, `meetings/${meeting.id}/${fileId}/meeting.webm`]);

    const res = await request(app)
      .post(`/api/meet/${meeting.id}/recordings/${started.recordingId}/attach`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({ fileId, durationSeconds: 42, sizeBytes: 2048 })
      .expect(200);
    expect(res.body.data.status).toBe('ready');
    expect(res.body.data.file_id).toBe(fileId);

    const list = await request(app).get(`/api/meet/${meeting.id}/recordings`)
      .set('Authorization', `Bearer ${host.token}`).expect(200);
    expect(list.body.data[0].original_name).toBe('meeting.webm');
    expect(list.body.data[0].mode).toBe('client');
  });

  it('refuses a student', async () => {
    const host = await userWithRole('Staff', 'Host');
    const pupil = await userWithRole('Student', 'Pupil');
    const meeting = await recordableMeeting(host.token);
    await request(app).post(`/api/meet/${meeting.id}/recording/start`)
      .set('Authorization', `Bearer ${pupil.token}`).send({}).expect(403);
  });
});


describe('the Cloudflare SFU proxy', () => {
  async function meetingOn(token: string, transport: string) {
    const meeting = (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${token}`).send({}).expect(201)).body.data;
    await getPool().query('UPDATE meetings SET transport = $2 WHERE id = $1',
      [meeting.id, transport]);
    return meeting;
  }

  it('refuses every SFU route when Cloudflare is not configured', async () => {
    const staff = await userWithRole('Staff');
    const meeting = await meetingOn(staff.token, 'cloudflare');
    for (const [method, path] of [
      ['post', 'sfu/session'], ['post', 'sfu/tracks'],
      ['put', 'sfu/renegotiate'], ['put', 'sfu/close'],
    ] as const) {
      const res = await request(app)[method](`/api/meet/${meeting.id}/${path}`)
        .set('Authorization', `Bearer ${staff.token}`).send({});
      expect(res.status).toBe(503);
      expect(res.body.message).toMatch(/not configured/i);
    }
  });

  it('refuses a meeting that is not on the Cloudflare transport', async () => {
    const staff = await userWithRole('Staff');
    const meeting = await meetingOn(staff.token, 'mesh');
    // Pretend it is configured so the 503 above does not mask this check.
    await withMediaServerAsync('cloudflare', async () => {
      const res = await request(app).post(`/api/meet/${meeting.id}/sfu/session`)
        .set('Authorization', `Bearer ${staff.token}`).send({}).expect(409);
      expect(res.body.message).toMatch(/not on the Cloudflare transport/i);
    });
  });

  it('refuses someone who is not an active participant', async () => {
    const host = await userWithRole('Staff', 'Host');
    const stranger = await userWithRole('Staff', 'Stranger');
    const meeting = await meetingOn(host.token, 'cloudflare');

    await withMediaServerAsync('cloudflare', async () => {
      // A session token for one meeting must not be a licence to open media in
      // another — this is the check that makes the proxy safe to expose.
      const res = await request(app).post(`/api/meet/${meeting.id}/sfu/session`)
        .set('Authorization', `Bearer ${stranger.token}`).send({}).expect(403);
      expect(res.body.message).toMatch(/not in this meeting/i);
    });
  });

  it('refuses to pull a track belonging to another meeting', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = await meetingOn(host.token, 'cloudflare');
    const join = await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(200);
    await getPool().query(
      `UPDATE meeting_participants SET sfu_session_id = 'aaaaaaaaaaaaaaaa' WHERE id = $1`,
      [join.body.data.participantId]);

    await withMediaServerAsync('cloudflare', async () => {
      const res = await request(app).post(`/api/meet/${meeting.id}/sfu/tracks`)
        .set('Authorization', `Bearer ${host.token}`)
        .send({
          tracks: [{
            location: 'remote',
            sessionId: 'ffffffffffffffff',
            trackName: 'cam-999999',
          }],
        })
        .expect(403);
      expect(res.body.message).toMatch(/not in this meeting/i);
    });
  });

  it('refuses a track name that does not belong to the session claimed', async () => {
    const host = await userWithRole('Staff', 'Host');
    const other = await userWithRole('Staff', 'Other');
    const meeting = await meetingOn(host.token, 'cloudflare');

    const mine = await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(200);
    const theirs = await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${other.token}`).send({}).expect(200);

    await getPool().query(
      `UPDATE meeting_participants SET sfu_session_id = 'aaaaaaaaaaaaaaaa' WHERE id = $1`,
      [mine.body.data.participantId]);
    await getPool().query(
      `UPDATE meeting_participants SET sfu_session_id = 'bbbbbbbbbbbbbbbb' WHERE id = $1`,
      [theirs.body.data.participantId]);

    await withMediaServerAsync('cloudflare', async () => {
      // The session is legitimately in the room, but the track name names
      // somebody else — which is how a caller would fish for another
      // participant's media if only the session were checked.
      const res = await request(app).post(`/api/meet/${meeting.id}/sfu/tracks`)
        .set('Authorization', `Bearer ${host.token}`)
        .send({
          tracks: [{
            location: 'remote',
            sessionId: 'bbbbbbbbbbbbbbbb',
            trackName: sfuTrackName(mine.body.data.participantId, 'cam'),
          }],
        })
        .expect(403);
      expect(res.body.message).toMatch(/does not belong/i);
    });
  });

  it('caps how many tracks one call may add', async () => {
    const host = await userWithRole('Staff', 'Host');
    const meeting = await meetingOn(host.token, 'cloudflare');
    const join = await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${host.token}`).send({}).expect(200);
    await getPool().query(
      `UPDATE meeting_participants SET sfu_session_id = 'aaaaaaaaaaaaaaaa' WHERE id = $1`,
      [join.body.data.participantId]);

    await withMediaServerAsync('cloudflare', async () => {
      const res = await request(app).post(`/api/meet/${meeting.id}/sfu/tracks`)
        .set('Authorization', `Bearer ${host.token}`)
        .send({ tracks: Array.from({ length: 65 }, () => ({ location: 'local', mid: '0' })) })
        .expect(400);
      expect(res.body.message).toMatch(/at most 64/i);
    });
  });

  it('never leaks the app secret through capabilities', async () => {
    const staff = await userWithRole('Staff');
    await withMediaServerAsync('cloudflare', async () => {
      Object.assign(config, { cloudflareRealtimeAppSecret: 'super-secret-value' });
      const res = await request(app).get('/api/meet/capabilities')
        .set('Authorization', `Bearer ${staff.token}`).expect(200);
      expect(JSON.stringify(res.body)).not.toContain('super-secret-value');
      expect(JSON.stringify(res.body)).not.toContain('test-app');
      expect(res.body.data.mediaServer).toBe('cloudflare');
      expect(res.body.data.sfu).toBe(true);
      expect(res.body.data.capacity.cloudflare).toBeGreaterThanOrEqual(500);
    });
  });
});
