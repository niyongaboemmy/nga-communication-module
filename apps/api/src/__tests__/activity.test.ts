import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { app } from '../app.js';
import { config } from '../config.js';
import {
  activity, buildActivity, misUserIdFromSession, toMisUserId, _setActivityForTests, type TupoActivity,
} from '../activity/relay.js';
import { resetIceCache } from '../services/turnService.js';

/**
 * Platform usage analytics relay (USAGE_ANALYTICS_IMPLEMENTATION_PLAN.md §5.2):
 * `POST /api/activity` stamps browser batches with the MIS user behind the Tupo
 * session -- never one the browser claims -- and the real client IP, refuses
 * anonymous traffic from foreign origins, and is a silent no-op when the MIS is
 * not configured. Also: the server-side key events, and `trust proxy` (the
 * per-IP guest throttle used to be one global bucket).
 *
 * The MIS is a mocked fetch; the database is the real test PostgreSQL.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SPA = 'https://tupo.amashuri.com';
const DID = 'AbCdEfGhIjKlMnOpQrStUv';

type Sent = { url: string; body: any };
let sent: Sent[] = [];
const fetchImpl = vi.fn(async (url: string, init: any) => {
  const raw = init?.body ? (init.headers?.['Content-Encoding'] === 'gzip' ? zlib.gunzipSync(init.body).toString() : String(init.body)) : null;
  sent.push({ url, body: raw ? JSON.parse(raw) : null });
  return new Response(JSON.stringify({ accepted: 1, commands: [] }), { status: 202 });
}) as unknown as typeof fetch;

const enabledRelay = () => buildActivity(
  { misBaseUrl: 'https://mis.test', clientId: 'tupo', clientSecret: 's3cret', origins: SPA },
  { fetchImpl, flushMs: 600_000, logger: { warn: () => undefined, error: () => undefined } },
);

const envelope = (extra: Record<string, unknown> = {}) => ({
  v: 1, app: 'tupo', did: DID, tab: 't1', sent_at: Date.now(),
  events: [{ id: '01J00000000000000000000000', n: 'page_view', t: Date.now(), r: '/app/chat', f: 'tupo.chat' }],
  ...extra,
});

/** A MIS id is a small positive integer -- unlike the snowflakes other suites use. */
let nextMisId = 700_000 + Math.floor(Math.random() * 100_000);
const created: string[] = [];

async function user(roleName: string | null = 'Staff', opts: { status?: string } = {}) {
  const pool = getPool();
  const id = snowflake();
  const misUserId = String(nextMisId++);
  const roleId = roleName
    ? (await pool.query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [roleName])).rows[0]?.id ?? null
    : null;
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id, status)
     VALUES ($1, $2, 'Activity Test', $3, 'staff', $4, $5)`,
    [id, misUserId, `${id}@amashuri.com`, roleId, opts.status ?? 'active'],
  );
  created.push(id);
  const token = jwt.sign(
    { id, misUserId, name: 'Activity Test', email: `${id}@amashuri.com`, role: 'staff' },
    config.jwtSecret, { expiresIn: '10m' },
  );
  return { id, misUserId: Number(misUserId), token };
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as never;

let previous: TupoActivity;
let relay: TupoActivity;
const turnBefore = { id: config.cloudflareTurnTokenId, token: config.cloudflareTurnApiToken };

beforeAll(async () => {
  await seedRbac(getPool());
  // Guest/join tickets carry ICE servers; never reach a real TURN service from a test.
  Object.assign(config, { cloudflareTurnTokenId: '', cloudflareTurnApiToken: '' });
  resetIceCache();
});

beforeEach(() => {
  sent = [];
  (fetchImpl as unknown as { mockClear: () => void }).mockClear();
  relay = enabledRelay();
  previous = _setActivityForTests(relay);
});

afterEach(async () => {
  _setActivityForTests(previous);
  await relay.stop().catch(() => undefined);
});

afterAll(async () => {
  Object.assign(config, { cloudflareTurnTokenId: turnBefore.id, cloudflareTurnApiToken: turnBefore.token });
  const pool = getPool();
  if (created.length) {
    await pool.query('DELETE FROM meetings WHERE host_id = ANY($1)', [created]).catch(() => {});
    // conversations.created_by does not cascade; a leftover row would break
    // the next suite's `DELETE FROM users`.
    await pool.query('DELETE FROM conversations WHERE created_by = ANY($1)', [created]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [created]).catch(() => {});
  }
  await closeDb();
});

describe('POST /api/activity', () => {
  it('stamps a signed-in batch with the MIS user id and the forwarded client IP, ignoring a claimed user_id', async () => {
    const u = await user();
    await request(app).post('/api/activity')
      .set('Authorization', `Bearer ${u.token}`)
      .set('X-Forwarded-For', '102.22.1.9')
      .set('User-Agent', 'UA/1')
      .send(envelope({ user_id: 999 }))
      .expect(204);

    await relay.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://mis.test/activity/ingest');
    const batch = sent[0]!.body.batches[0];
    expect(batch).toMatchObject({ user_id: u.misUserId, ip: '102.22.1.9', ua: 'UA/1' });
    expect(batch.envelope.user_id).toBeUndefined();
  });

  it('accepts a sendBeacon body (text/plain) from a public page as a visitor', async () => {
    await request(app).post('/api/activity')
      .set('Origin', SPA)
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(envelope()))
      .expect(204);
    expect(relay.relay!._queue().batches).toBe(1);
    await relay.flush();
    expect(sent[0]!.body.batches[0].user_id).toBeNull();
  });

  it('drops an anonymous batch from a foreign origin, or with no origin at all', async () => {
    await request(app).post('/api/activity').set('Origin', 'https://evil.example').send(envelope()).expect(204);
    await request(app).post('/api/activity').send(envelope()).expect(204);
    // A dead token is no identity: still anonymous, still refused from abroad.
    await request(app).post('/api/activity')
      .set('Authorization', 'Bearer not-a-jwt').set('Origin', 'https://evil.example').send(envelope()).expect(204);
    expect(relay.relay!._queue().batches).toBe(0);
  });

  it('answers 204 to a body it cannot parse or that is too large, without a 4xx', async () => {
    await request(app).post('/api/activity').set('Content-Type', 'application/json').send('{not json').expect(204);
    await request(app).post('/api/activity').set('Origin', SPA)
      .send(envelope({ pad: 'x'.repeat(300 * 1024) })).expect(204);
    expect(relay.relay!._queue().batches).toBe(0);
  });

  it('proxies GET /api/activity/config to the MIS', async () => {
    const res = await request(app).get(`/api/activity/config?did=${DID}`).expect(200);
    expect(sent[0]!.url).toBe(`https://mis.test/activity/config?did=${DID}`);
    expect(res.body).toEqual({ accepted: 1, commands: [] });
  });
});

describe('without the MIS configured', () => {
  it('is off in the test run whatever the environment says', () => {
    expect(previous.enabled).toBe(false);
  });

  it('answers 204 and {enabled:false}, and forwards nothing', async () => {
    _setActivityForTests(buildActivity({ misBaseUrl: 'https://mis.test', clientId: 'tupo' })); // no secret
    const u = await user();
    await request(app).post('/api/activity').set('Authorization', `Bearer ${u.token}`).send(envelope()).expect(204);
    const cfg = await request(app).get('/api/activity/config').expect(200);
    expect(cfg.body).toEqual({ enabled: false, v: 1 });
    activity().track(1, null, 'tupo.chat.send');
    await activity().flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the session → MIS user id rule', () => {
  it('validates like authMiddleware but never rejects', async () => {
    const ok = await user();
    expect(await misUserIdFromSession(bearer(ok.token))).toBe(ok.misUserId);

    expect(await misUserIdFromSession({ headers: {} } as never)).toBeNull();
    expect(await misUserIdFromSession(bearer('garbage'))).toBeNull();
    expect(await misUserIdFromSession(bearer(jwt.sign({ id: ok.id, misUserId: '1' }, 'wrong-secret')))).toBeNull();
    expect(await misUserIdFromSession(bearer(jwt.sign({ id: ok.id }, config.jwtSecret, { expiresIn: -10 })))).toBeNull();

    const suspended = await user('Staff', { status: 'suspended' });
    expect(await misUserIdFromSession(bearer(suspended.token))).toBeNull();

    // A guest meeting ticket is not an account.
    const guest = jwt.sign({ guest: true, participantId: 'p1', meetingId: 'm1', name: 'Visitor' }, config.jwtSecret);
    expect(await misUserIdFromSession(bearer(guest))).toBeNull();
  });

  it('treats a session ended by NGA single sign-out as a visitor', async () => {
    const u = await user();
    await getPool().query(
      `INSERT INTO session_revocations (user_id, revoked_at) VALUES ($1, now() + interval '1 second')`, [u.id]);
    expect(await misUserIdFromSession(bearer(u.token))).toBeNull();
  });

  it('accepts only a positive integer as a MIS id', () => {
    expect(toMisUserId('412')).toBe(412);
    expect(toMisUserId(412)).toBe(412);
    for (const bad of ['guest:p1', '0', '-3', '1.5', '', null, undefined, '7255443339186442240']) {
      expect(toMisUserId(bad)).toBeNull();
    }
  });
});

describe('server-side key events', () => {
  it('records a meeting join for the MIS user, and a guest knock with the name they typed', async () => {
    const host = await user('Staff');
    const meeting = (await request(app).post('/api/meet/instant')
      .set('Authorization', `Bearer ${host.token}`)
      .send({ title: 'Open day', settings: { admissionPolicy: 'public' } }).expect(201)).body.data as { id: string; join_code: string };

    await request(app).post(`/api/meet/${meeting.id}/join`)
      .set('Authorization', `Bearer ${host.token}`).set('X-NGA-Device', DID).send({}).expect(200);

    await request(app).post(`/api/meet/${meeting.join_code}/guest`)
      .set('X-Forwarded-For', '41.186.7.7')
      .send({ displayName: 'Visiting Parent' }).expect(201);

    await relay.flush();
    const events = sent.flatMap((s) => s.body.server_events ?? []);
    const join = events.find((e: any) => e.n === 'tupo.meet.join');
    expect(join).toMatchObject({ user_id: host.misUserId, did: DID, p: { meeting_id: meeting.id, role: 'host', state: 'active' } });
    const guest = events.find((e: any) => e.n === 'tupo.meet.guest_join');
    expect(guest).toMatchObject({ user_id: null, ip: '41.186.7.7', p: { meeting_id: meeting.id, display_name: 'Visiting Parent' } });
  });
});

describe('chat key event', () => {
  it('counts a message sent over REST without any of its content', async () => {
    const u = await user('Staff');
    const conv = (await request(app).post('/api/chat/conversations')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ type: 'group', name: 'Activity test' }).expect(201)).body.data.conversation as { id: string };
    const send = () => request(app).post(`/api/chat/conversations/${conv.id}/messages`)
      .set('Authorization', `Bearer ${u.token}`)
      .send({ body: 'a very private sentence', nonce: 'n-activity-1' });
    expect((await send()).status).toBe(201);
    // The same nonce again is the same message: not a second send.
    expect((await send()).status).toBe(200);

    await relay.flush();
    const events = sent.flatMap((s) => s.body.server_events ?? []).filter((e: any) => e.n === 'tupo.chat.send');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ user_id: u.misUserId, p: { conversation_type: 'group', thread: false, via: 'rest' } });
    expect(JSON.stringify(sent)).not.toContain('private sentence');
  });
});

describe('trust proxy (regression)', () => {
  it('gives each forwarded client IP its own guest-join throttle bucket', async () => {
    // Ten attempts are allowed per IP per window; the code need not exist,
    // the throttle runs first.
    const attempt = (ip: string) => request(app).post('/api/meet/zzz-zzzz-zzz/guest')
      .set('X-Forwarded-For', ip).send({ displayName: 'Someone' });
    for (let i = 0; i < 10; i++) expect((await attempt('198.51.100.10')).status).not.toBe(429);
    expect((await attempt('198.51.100.10')).status).toBe(429);
    // Before `trust proxy`, every request came from 127.0.0.1 (nginx), so this
    // second person would have been throttled too.
    expect((await attempt('198.51.100.11')).status).not.toBe(429);
  });
});

describe('vendored relay', () => {
  it('matches its provenance hash in both processes (re-sync, never edit)', () => {
    for (const file of ['../vendor/nga-activity-relay/relay.ts', '../../../realtime/src/vendor/nga-activity-relay/relay.ts']) {
      const text = fs.readFileSync(path.resolve(here, file), 'utf8');
      const [, , shaLine, ...rest] = text.split('\n');
      expect(shaLine).toBe(`// sha256:${crypto.createHash('sha256').update(rest.join('\n')).digest('hex')}`);
    }
  });
});
