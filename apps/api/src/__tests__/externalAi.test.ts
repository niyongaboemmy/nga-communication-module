import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import * as mail from '@tupo/mail';
import { app } from '../app.js';
import { config } from '../config.js';
import { setAiPolicyForTests, __resetAiPolicyCache } from '../services/aiPolicy.js';
import { __resetMyAiCache } from '../services/myAiGateway.js';
import { __resetExternalAiCache } from '../services/externalAi.js';

/**
 * External AI (EXTERNAL_AI_CONTRACT.md): "Open in Claude / ChatGPT" (prompt) and
 * "Paste the answer" (import) on the AI routes, and the connector tools the MIS
 * relays to /api/integration/mcp/*. The MIS is mocked at fetch; the only AI
 * provider is a local stand-in that must never be called by a hand-off.
 */

const realFetch = globalThis.fetch;
const MIS = config.misBaseUrl;
const CAP = 'AI_EXTERNAL_CONNECT';

const ON = { v: 1, enabled: true, external: { handoff: true, connector: true, pupilNames: 'with_consent' } };

/** A MIS SSO token: what the MIS signs carries the person's permission list. */
const misJwt = (misUserId: string, permissions: string[]) =>
  jwt.sign({ userId: Number(misUserId), permissions, nonce: snowflake() }, 'mis-signing-key');

/** MIS token -> MIS user id, for the stubbed /auth/verify. */
const verified = new Map<string, string>();

function stubMis() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(MIS)) return realFetch(input as any, init);
    const bearer = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '').replace(/^Bearer /, '');
    if (url.endsWith('/auth/verify')) {
      const id = verified.get(bearer);
      return id
        ? new Response(JSON.stringify({ success: true, data: { userId: Number(id), access_version: 1 } }), { status: 200 })
        : new Response(JSON.stringify({ success: false }), { status: 401 });
    }
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  }));
}

const created: string[] = [];
let nextMis = 97_000 + Math.floor(Math.random() * 1000) * 10;

async function person(roleName: 'Staff' | 'Student', permissions: string[]) {
  const pool = getPool();
  const id = snowflake();
  const misId = String(nextMis++);
  const roleId = (await pool.query<{ id: number }>('SELECT id FROM roles WHERE name = $1', [roleName])).rows[0]!.id;
  await pool.query(
    `INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, misId, `${roleName} ${misId}`, `${id}@amashuri.com`, roleName === 'Student' ? 'student' : 'staff', roleId],
  );
  created.push(id);
  const misToken = misJwt(misId, permissions);
  verified.set(misToken, misId);
  // The Tupo session, as the SSO exchange mints it: the MIS token rides inside.
  const token = jwt.sign(
    { id, misUserId: misId, name: `${roleName} ${misId}`, email: `${id}@amashuri.com`, role: roleName.toLowerCase(), misToken },
    config.jwtSecret, { expiresIn: '10m' },
  );
  return { id, misId, misToken, token };
}

const savedEnv = { ...process.env };
let server: http.Server;
let providerCalls = 0;

beforeAll(async () => {
  await seedRbac(getPool());
  // A local stand-in for the school's AI: hand-off must never reach it.
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      providerCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', model: 'openrouter/free', usage: { cost: 0 },
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"suggestions":["From the school AI"]}' } }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  process.env.AI_PROVIDER_ORDER = 'openrouter';
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  delete process.env.OPENROUTER_MODELS;
});

afterAll(async () => {
  process.env = savedEnv;
  await new Promise((resolve) => server.close(resolve));
  if (created.length) {
    await getPool().query('DELETE FROM mail_messages WHERE from_user_id = ANY($1)', [created]).catch(() => {});
    await getPool().query('DELETE FROM users WHERE id = ANY($1)', [created]).catch(() => {});
  }
  await closeDb();
});

beforeEach(() => {
  providerCalls = 0;
  __resetAiPolicyCache(); __resetMyAiCache(); __resetExternalAiCache();
  setAiPolicyForTests(ON);
  stubMis();
});
afterEach(() => { vi.unstubAllGlobals(); __resetAiPolicyCache(); });

const SUBJECTS = { suggestions: ['Fees due Friday', 'Reminder: fees', 'School fees'] };

describe('hand-off on POST /api/mail/ai/subject (the person\'s own text: no pupil data)', () => {
  const subject = (token: string, body: Record<string, unknown>) =>
    request(app).post('/api/mail/ai/subject').set('Authorization', `Bearer ${token}`)
      .send({ bodyText: 'Fees are due on Friday. Questions to bursar@school.rw or 0788 123 456.', ...body });

  it('prompt mode: 200 with the exact prompt (JSON schema, scrubbed), and no AI is called', async () => {
    const { token } = await person('Staff', [CAP]);
    const res = await subject(token, { aiHandoff: { mode: 'prompt' } }).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.handoff).toMatchObject({ expects: 'json', schemaName: 'mail_subjects' });
    const prompt: string = res.body.handoff.prompt;
    expect(prompt).toContain('Propose 3 subject lines');
    expect(prompt).toContain('Answer with ONLY one JSON object that matches this JSON Schema, inside a ```json code block');
    expect(prompt).toContain('"suggestions"');
    expect(prompt).not.toContain('bursar@school.rw');
    expect(prompt).not.toMatch(/0788 123 456/);
    expect(prompt).toContain('[email]');
    expect(prompt).toContain('[phone]');
    expect(providerCalls).toBe(0);
  });

  it('import mode: the pasted answer is the result, via "handoff", with no AI call', async () => {
    const { token } = await person('Staff', [CAP]);
    const pasted = `Here are three:\n\n\`\`\`json\n${JSON.stringify(SUBJECTS)}\n\`\`\``;
    const res = await subject(token, { aiHandoff: { mode: 'import', text: pasted } }).expect(200);
    expect(res.body.data).toEqual({ ...SUBJECTS, providerUsed: 'handoff', ai: { route: 'handoff', reason: 'HANDOFF' } });
    expect(providerCalls).toBe(0);
  });

  it('import mode: an answer in the wrong format is a 400', async () => {
    const { token } = await person('Staff', [CAP]);
    const res = await subject(token, { aiHandoff: { mode: 'import', text: 'Fees due Friday!' } }).expect(400);
    expect(res.body).toMatchObject({ success: false, code: 'AI_HANDOFF_FORMAT' });
    expect(res.body.message).toMatch(/isn't in the expected format/);
    await subject(token, { aiHandoff: { mode: 'import', text: '  ' } }).expect(400);
  });

  it('403 AI_HANDOFF_OFF while the school has hand-off off', async () => {
    const { token } = await person('Staff', [CAP]);
    setAiPolicyForTests({ v: 2, enabled: true });
    const res = await subject(token, { aiHandoff: { mode: 'prompt' } }).expect(403);
    expect(res.body).toMatchObject({ success: false, code: 'AI_HANDOFF_OFF' });
    expect(providerCalls).toBe(0);
  });

  it('403 AI_HANDOFF_NOT_ALLOWED without AI_EXTERNAL_CONNECT', async () => {
    const { token } = await person('Staff', ['AI_USE']);
    const res = await subject(token, { aiHandoff: { mode: 'prompt' } }).expect(403);
    expect(res.body.code).toBe('AI_HANDOFF_NOT_ALLOWED');
  });

  it('the worker (system) never hands off: its call is a normal school call', async () => {
    const { id, misId, misToken } = await person('Staff', [CAP]);
    const system = jwt.sign(
      { id, misUserId: misId, name: 'x', email: `${id}@amashuri.com`, role: 'staff', misToken, system: true },
      config.jwtSecret, { expiresIn: '10m' },
    );
    const res = await subject(system, { aiHandoff: { mode: 'prompt' } }).expect(200);
    expect(res.body.handoff).toBeUndefined();
    expect(res.body.data.providerUsed).toBe('openrouter');
    expect(providerCalls).toBe(1);
  });

  it('GET /api/ai/external tells the panels whether to offer it', async () => {
    const yes = await person('Staff', [CAP]);
    const no = await person('Staff', []);
    expect((await request(app).get('/api/ai/external').set('Authorization', `Bearer ${yes.token}`).expect(200)).body.data)
      .toEqual({ handoff: true });
    expect((await request(app).get('/api/ai/external').set('Authorization', `Bearer ${no.token}`).expect(200)).body.data)
      .toEqual({ handoff: false });
  });
});

describe('hand-off on POST /api/mail/ai/summarize (a thread: pupil data)', () => {
  async function thread() {
    const me = await person('Staff', [CAP]);
    const other = await person('Staff', []);
    const sent = await mail.compose(other.id, {
      to: [`userId:${me.id}`], subject: 'Aline in S2', bodyHtml: '<p>Aline Uwase missed the test; can she resit on Monday?</p>',
    });
    return { me, threadId: sent.threadId };
  }
  const summarize = (token: string, threadId: string, aiHandoff: unknown) =>
    request(app).post('/api/mail/ai/summarize').set('Authorization', `Bearer ${token}`).send({ threadId, aiHandoff });

  it('needs "Include pupil details" (consent) under a with_consent policy', async () => {
    const { me, threadId } = await thread();
    const refused = await summarize(me.token, threadId, { mode: 'prompt' }).expect(403);
    expect(refused.body).toMatchObject({ success: false, code: 'AI_HANDOFF_PUPIL_CONSENT' });

    const ok = await summarize(me.token, threadId, { mode: 'prompt', pupilConsent: true }).expect(200);
    expect(ok.body.handoff).toMatchObject({ expects: 'json', schemaName: 'mail_thread_summary' });
    expect(ok.body.handoff.prompt).toContain('Aline Uwase');
    expect(providerCalls).toBe(0);
  });

  it('is refused even with consent when the school says pupil names never leave', async () => {
    const { me, threadId } = await thread();
    setAiPolicyForTests({ ...ON, external: { ...ON.external, pupilNames: 'never' } });
    const res = await summarize(me.token, threadId, { mode: 'prompt', pupilConsent: true }).expect(403);
    expect(res.body.code).toBe('AI_HANDOFF_PUPIL_CONSENT');
  });

  it('import needs no consent (nothing leaves): the pasted summary is used', async () => {
    const { me, threadId } = await thread();
    const answer = { summary: 'Aline asks to resit.', keyPoints: ['Resit Monday'], actionItems: [], needsReply: true };
    const res = await summarize(me.token, threadId, { mode: 'import', text: JSON.stringify(answer) }).expect(200);
    expect(res.body.data).toMatchObject({ summary: 'Aline asks to resit.', needsReply: true, providerUsed: 'handoff', ai: { route: 'handoff' } });
  });
});

describe('connector tools: /api/integration/mcp/*', () => {
  const tools = (misToken: string) =>
    request(app).get('/api/integration/mcp/tools').set('Authorization', `Bearer ${misToken}`);
  const call = (misToken: string, name: string, args: Record<string, unknown>) =>
    request(app).post('/api/integration/mcp/call').set('Authorization', `Bearer ${misToken}`).send({ name, arguments: args });

  it('needs a MIS token the MIS accepts', async () => {
    await tools('not-a-token').expect(401);
  });

  it('lists nothing, and refuses calls with EXTERNAL_OFF, while the connector is off', async () => {
    const staff = await person('Staff', [CAP]);
    setAiPolicyForTests({ v: 2, enabled: true });
    expect((await tools(staff.misToken).expect(200)).body).toEqual({ tools: [] });
    const res = await call(staff.misToken, 'tupo_draft_mail', { subject: 'x', body: 'y' }).expect(403);
    expect(res.body).toEqual({ code: 'EXTERNAL_OFF', message: expect.any(String) });

    setAiPolicyForTests({ ...ON, apps: { tupo: false } });
    expect((await tools(staff.misToken).expect(200)).body).toEqual({ tools: [] });
  });

  it('offers tupo_draft_mail to staff holding AI_EXTERNAL_CONNECT, nothing to others', async () => {
    const staff = await person('Staff', [CAP]);
    const res = await tools(staff.misToken).expect(200);
    expect(res.body.tools).toEqual([expect.objectContaining({
      name: 'tupo_draft_mail', kind: 'draft', pupilData: false, inputSchema: expect.objectContaining({ type: 'object' }),
    })]);
    expect(res.body.tools[0].needs).toBeUndefined();

    const noCap = await person('Staff', []);
    expect((await tools(noCap.misToken).expect(200)).body).toEqual({ tools: [] });
    const refused = await call(noCap.misToken, 'tupo_draft_mail', { subject: 'x', body: 'y' }).expect(403);
    expect(refused.body.code).toBe('TOOL_FORBIDDEN');
  });

  it('refuses a student, even one somehow holding the capability', async () => {
    const student = await person('Student', [CAP]);
    expect((await tools(student.misToken).expect(200)).body).toEqual({ tools: [] });
    const res = await call(student.misToken, 'tupo_draft_mail', { subject: 'Hi', body: 'Hello' }).expect(403);
    expect(res.body.code).toBe('TOOL_FORBIDDEN');
  });

  it('tupo_draft_mail saves a draft in the person\'s Drafts and never sends it', async () => {
    const staff = await person('Staff', [CAP]);
    const colleague = await person('Staff', []);
    const res = await call(staff.misToken, 'tupo_draft_mail', {
      subject: 'Staff meeting moved', body: 'Hello,\n\nThe meeting moves to Thursday.\n\nThanks', to: [colleague.misId, 'parent@example.com'],
    }).expect(200);
    expect(res.body.result).toMatchObject({ status: 'draft', recipients: 2 });
    expect(res.body.openUrl).toBe(`${config.appPublicUrl}/app/mail?folder=drafts`);
    expect(res.body.summary).toMatch(/not been sent/);

    const pool = getPool();
    const { rows: [msg] } = await pool.query(
      'SELECT is_draft, sent_at, from_user_id, subject, body_html FROM mail_messages WHERE id = $1', [res.body.result.draftId]);
    expect(msg).toMatchObject({ is_draft: true, sent_at: null, from_user_id: staff.id, subject: 'Staff meeting moved' });
    expect(msg.body_html).toBe('<p>Hello,</p><p>The meeting moves to Thursday.</p><p>Thanks</p>');
    // Nothing queued for delivery, and nothing reached the colleague's mailbox.
    const { rows: events } = await pool.query(
      'SELECT 1 FROM mail_delivery_events WHERE message_id = $1', [res.body.result.draftId]);
    expect(events).toHaveLength(0);
    const drafts = await mail.listThreads(staff.id, { folder: 'drafts' });
    expect(drafts.threads.map((t) => t.subject)).toContain('Staff meeting moved');
    const inbox = await mail.listThreads(colleague.id, { folder: 'inbox' });
    expect(inbox.threads.map((t) => t.subject)).not.toContain('Staff meeting moved');
  });

  it('refuses bad arguments and unknown tools with the contract codes', async () => {
    const staff = await person('Staff', [CAP]);
    expect((await call(staff.misToken, 'tupo_draft_mail', { subject: '', body: 'x' }).expect(400)).body.code).toBe('BAD_ARGUMENTS');
    expect((await call(staff.misToken, 'tupo_draft_mail', { subject: 'x', body: 'y', to: ['999999999'] }).expect(400)).body.code)
      .toBe('BAD_ARGUMENTS');
    expect((await call(staff.misToken, 'tupo_draft_mail', { subject: 'x', body: 'y', to: ['not an address'] }).expect(400)).body.code)
      .toBe('BAD_ARGUMENTS');
    expect((await call(staff.misToken, 'tupo_send_mail', {}).expect(404)).body.code).toBe('TOOL_UNKNOWN');
  });
});
