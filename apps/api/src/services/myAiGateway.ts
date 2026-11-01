import type { Request } from 'express';
import { isAiRouteValue, type AiAnswer, type MyAiRoutes } from '@tupo/shared';
import { config } from '../config.js';
import { AiDisabledError, getAiPolicy } from './aiPolicy.js';
import type { AiReason, AiTask } from '../vendor/nga-access/index.js';

/**
 * "My AI": a person's own AI key answers their call, through the MIS gateway
 * (MY_AI_GATEWAY.md, PERSONAL_AI_PROVIDERS_PLAN.md §10).
 *
 * Tupo keeps its own school AI exactly as it is. For a call made BY A PERSON,
 * Tupo asks the MIS whether that person's own key should answer; if so the MIS
 * makes the call with the key (which never leaves the MIS) and hands back the
 * answer. Everything else — the worker's wrap-up, live captions, batch
 * narration — never comes here.
 *
 *  - Auth: the SSO client credentials (HTTP Basic, same as the ai-policy read)
 *    plus `X-Nga-On-Behalf-Of: <MIS user id>`. Always the MIS id, never Tupo's.
 *  - GET /integrations/ai/routes is cached per person for 60 s, and dropped
 *    early when /auth/verify reports a new `ai_routes_v` or `ai_policy_v`.
 *  - The gateway must never make AI less available than it is today: any
 *    network error, timeout or unexpected status means the school AI answers,
 *    labelled `reason: "GATEWAY_UNAVAILABLE"`.
 */

const ROUTES_FRESH_MS = 60_000;
/** After a failed routes read, ask the MIS again no sooner than this. */
const ROUTES_RETRY_MS = 30_000;
const ROUTES_TIMEOUT_MS = () => Number(process.env.MY_AI_ROUTES_TIMEOUT_MS) || 3_000;
/** A personal model call is a real generation; give it as long as a provider gets. */
const GATEWAY_TIMEOUT_MS = () => Number(process.env.MY_AI_GATEWAY_TIMEOUT_MS) || 120_000;
const MAX_CACHED = 5_000;

/* ────────────────────────────────────────────────────────────────────────── *
 * Who is asking
 * ────────────────────────────────────────────────────────────────────────── */

/** The person behind an AI call, as a route hands it to a service. */
export interface AiWho {
  /** The person's MIS user id (users.mis_user_id) — never Tupo's own id. */
  misUserId?: string | null;
  /** One-off choice from the AI panel: "school", "<credentialId>" or "<credentialId>:<model>". */
  aiRoute?: string | null;
  /** Background work (the worker's host token): always the school AI. */
  system?: boolean;
}

/** One AI call: who, and what for. */
export interface PersonalAiCall extends AiWho {
  task: AiTask;
  /** Short machine name for the MIS usage log, e.g. "tupo.mail.compose". */
  feature: string;
  inAssessment?: boolean;
}

/** Header the worker sends with its host token. Spoofing it only makes your own call use the school AI. */
export const SYSTEM_CALLER_HEADER = 'x-tupo-caller';

/**
 * The AiWho for a request. `system` when the token is the worker's host token
 * (minted with `system: true` in services/queue.ts) or the worker says so.
 */
export function aiWhoOf(req: Request): AiWho {
  const user = (req as Request & { user?: { misUserId?: string; system?: boolean } }).user;
  const raw = (req.body as { aiRoute?: unknown } | undefined)?.aiRoute;
  return {
    misUserId: user?.misUserId ? String(user.misUserId) : null,
    aiRoute: isAiRouteValue(raw) ? raw : null,
    system: user?.system === true || req.get(SYSTEM_CALLER_HEADER) === 'worker',
  };
}

export const personalCall = (
  who: AiWho | null | undefined, task: AiTask, feature: string,
): PersonalAiCall | undefined => (who ? { ...who, task, feature } : undefined);

/* ────────────────────────────────────────────────────────────────────────── *
 * The MIS calls
 * ────────────────────────────────────────────────────────────────────────── */

function headers(misUserId: string): Record<string, string> {
  const auth = Buffer.from(`${config.ssoClientId}:${config.ssoClientSecret}`).toString('base64');
  return {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Nga-On-Behalf-Of': misUserId,
  };
}

interface RoutesEntry { data: MyAiRoutes; fetchedAt: number }
const routesCache = new Map<string, RoutesEntry>();
const routesFailedAt = new Map<string, number>();
const routesInflight = new Map<string, Promise<MyAiRoutes | null>>();

async function fetchRoutes(misUserId: string): Promise<MyAiRoutes | null> {
  try {
    const res = await fetch(`${config.misBaseUrl}/integrations/ai/routes`, {
      headers: headers(misUserId),
      signal: AbortSignal.timeout(ROUTES_TIMEOUT_MS()),
    });
    if (!res.ok) {
      routesFailedAt.set(misUserId, Date.now());
      return null;
    }
    const body = (await res.json()) as { success?: boolean; data?: Partial<MyAiRoutes> };
    if (!body?.success || !body.data) { routesFailedAt.set(misUserId, Date.now()); return null; }
    const d = body.data;
    const data: MyAiRoutes = {
      enabled: d.enabled === true,
      v: Number.isFinite(Number(d.v)) ? Number(d.v) : undefined,
      policyV: Number.isFinite(Number(d.policyV)) ? Number(d.policyV) : undefined,
      byTask: d.byTask && typeof d.byTask === 'object' ? d.byTask : {},
      choices: Array.isArray(d.choices) ? d.choices : [],
    };
    if (routesCache.size >= MAX_CACHED) routesCache.delete(routesCache.keys().next().value!);
    routesCache.set(misUserId, { data, fetchedAt: Date.now() });
    routesFailedAt.delete(misUserId);
    return data;
  } catch (err) {
    console.warn('[my-ai] MIS routes unreachable:', err instanceof Error ? err.message : err);
    routesFailedAt.set(misUserId, Date.now());
    return null;
  }
}

/** What answers this person in Tupo (cached 60 s), or null when the MIS cannot say. */
export async function getRoutes(misUserId: string): Promise<MyAiRoutes | null> {
  const now = Date.now();
  const hit = routesCache.get(misUserId);
  if (hit && now - hit.fetchedAt < ROUTES_FRESH_MS) return hit.data;
  const failed = routesFailedAt.get(misUserId);
  if (failed && now - failed < ROUTES_RETRY_MS) return null;
  let p = routesInflight.get(misUserId);
  if (!p) {
    p = fetchRoutes(misUserId).finally(() => routesInflight.delete(misUserId));
    routesInflight.set(misUserId, p);
  }
  return p;
}

/**
 * /auth/verify reported this person's `ai_routes_v` (and the school's
 * `ai_policy_v`). Either differing from the cached copy means their keys, their
 * "what answers what" or the policy changed: drop the copy.
 */
export function noteAiRoutesVersion(misUserId: unknown, routesV: unknown, policyV?: unknown): boolean {
  if (misUserId === null || misUserId === undefined) return false;
  const id = String(misUserId);
  const hit = routesCache.get(id);
  if (!hit) return false;
  const differs = (raw: unknown, have: number | undefined) =>
    raw !== null && raw !== undefined && Number.isFinite(Number(raw)) && Number(raw) !== have;
  if (differs(routesV, hit.data.v) || differs(policyV, hit.data.policyV)) {
    routesCache.delete(id);
    routesFailedAt.delete(id);
    return true;
  }
  return false;
}

/** What the gateway said. Everything except `ok` means the school AI (or an error). */
export type GatewayOutcome<T> =
  | { kind: 'ok'; data: T; ai: AiAnswer }
  | { kind: 'school'; reason: string; skipped?: unknown }
  | { kind: 'key-failed'; code: string; message: string; fallbackAllowed: boolean; label?: string }
  | { kind: 'disabled'; reason: string; message?: string }
  | { kind: 'unavailable' };

async function post<T>(path: 'json' | 'text', misUserId: string, body: Record<string, unknown>): Promise<GatewayOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(`${config.misBaseUrl}/integrations/ai/gateway/${path}`, {
      method: 'POST',
      headers: headers(misUserId),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS()),
    });
  } catch (err) {
    console.warn('[my-ai] gateway unreachable:', err instanceof Error ? err.message : err);
    return { kind: 'unavailable' };
  }
  let json: Record<string, any> = {};
  try { json = (await res.json()) as Record<string, any>; } catch { /* not JSON: a proxy page */ }

  if (res.status === 200 && json.success !== false && json.ai) {
    return { kind: 'ok', data: json.data as T, ai: { ...json.ai, route: 'personal' } as AiAnswer };
  }
  if (res.status === 409 && json.code === 'AI_USE_SCHOOL') {
    return { kind: 'school', reason: String(json.reason ?? 'NO_ROUTE'), skipped: json.skipped ?? undefined };
  }
  if (res.status === 503 && typeof json.code === 'string' && json.code.startsWith('AI_')) {
    return {
      kind: 'key-failed', code: json.code, fallbackAllowed: json.fallbackAllowed === true,
      message: typeof json.message === 'string' ? json.message : 'Your own AI key could not answer.',
      label: typeof json.label === 'string' ? json.label : undefined,
    };
  }
  if (res.status === 403 && json.code === 'AI_DISABLED') {
    return { kind: 'disabled', reason: String(json.reason ?? 'GLOBAL_OFF'), message: json.message };
  }
  // 403 AI_GATEWAY_UNKNOWN_APP / USER_INACTIVE, 400, 5xx, 200 without `ai`: school AI.
  console.warn('[my-ai] gateway answered', res.status, json.code ?? '');
  return { kind: 'unavailable' };
}

export interface GatewayBase {
  task: AiTask;
  feature: string;
  aiRoute: string | null;
  inAssessment: boolean;
}

/** POST /integrations/ai/gateway/json — structured output with the school's own schema. */
export const postJson = <T>(misUserId: string, body: GatewayBase & {
  prompt: string; schema: unknown; schemaName?: string; maxOutputTokens?: number;
}) => post<T>('json', misUserId, body as unknown as Record<string, unknown>);

/** POST /integrations/ai/gateway/text — plain text. */
export const postText = (misUserId: string, body: GatewayBase & { prompt: string; system?: string }) =>
  post<string>('text', misUserId, body as unknown as Record<string, unknown>);

/* ────────────────────────────────────────────────────────────────────────── *
 * The decision
 * ────────────────────────────────────────────────────────────────────────── */

/** The person's own key failed and the school may not answer instead: a 503 with the MIS message. */
export class PersonalAiError extends Error {
  readonly status = 503;
  constructor(readonly code: string, message: string, readonly label?: string) {
    super(message);
    this.name = 'PersonalAiError';
  }
}

export const isPersonalAiError = (err: unknown): err is PersonalAiError => err instanceof PersonalAiError;

export const personalAiBody = (err: PersonalAiError) => ({
  success: false as const, code: err.code, message: err.message,
});

const school = (reason: string, extra: Partial<AiAnswer> = {}): AiAnswer => ({ route: 'school', reason, ...extra });

/**
 * Can this call be settled without asking the gateway? Returns the school
 * answer's label when it can, or null when the gateway must be asked. Never
 * touches the network while My AI is off (policy cached by aiPolicy.ts).
 */
export async function schoolWithoutGateway(call: PersonalAiCall | null | undefined): Promise<AiAnswer | null> {
  if (!call || call.system || !call.misUserId) return school('SYSTEM_CALL');
  const policy = await getAiPolicy();
  if (!policy?.personal.enabled) return school('PERSONAL_OFF');
  if (policy.personal.apps.tupo === false) return school('APP_OFF');
  if (call.aiRoute === 'school') return school('NO_ROUTE');
  // An explicit key: the MIS checks it belongs to the person and allows Tupo.
  if (call.aiRoute) return null;
  const routes = await getRoutes(call.misUserId);
  if (!routes) return school('GATEWAY_UNAVAILABLE');
  const forTask = routes.byTask?.[call.task];
  if (!routes.enabled) return school(forTask?.reason ?? 'PERSONAL_OFF');
  if (!forTask || forTask.route !== 'personal') return school(forTask?.reason ?? 'NO_ROUTE');
  return null;
}

export interface PersonalAiResult<T> { data: T; providerUsed: string; ai: AiAnswer }

/**
 * Run one AI call on the person's own key when they chose one, else on the
 * school AI. Implements MY_AI_GATEWAY.md "Answers that mean do something else":
 *
 *   policy.personal off / tupo off / system call  → school, no network
 *   409 AI_USE_SCHOOL                              → school, { reason, skipped }
 *   503 + fallbackAllowed                          → school, { reason: KEY_NOT_ACTIVE, fallbackFrom, label }
 *   503 without                                    → PersonalAiError (503 + message)
 *   403 AI_DISABLED                                → AiDisabledError, as today
 *   anything else / network                        → school, { reason: GATEWAY_UNAVAILABLE }
 *
 * `personal` must send exactly the prompt (and schema) `school` uses.
 */
export async function withPersonalAi<T>(
  call: PersonalAiCall | null | undefined,
  run: {
    personal: (misUserId: string, base: GatewayBase) => Promise<GatewayOutcome<T>>;
    school: () => Promise<{ data: T; providerUsed: string }>;
  },
): Promise<PersonalAiResult<T>> {
  const viaSchool = async (ai: AiAnswer): Promise<PersonalAiResult<T>> => ({ ...(await run.school()), ai });

  const settled = await schoolWithoutGateway(call);
  if (settled) return viaSchool(settled);

  const c = call!;
  const out = await run.personal(c.misUserId!, {
    task: c.task, feature: c.feature, aiRoute: c.aiRoute ?? null, inAssessment: c.inAssessment === true,
  });
  switch (out.kind) {
    case 'ok':
      return { data: out.data, providerUsed: out.ai.provider ?? 'my-ai', ai: out.ai };
    case 'school':
      return viaSchool(school(out.reason, out.skipped != null ? { skipped: out.skipped } : {}));
    case 'key-failed':
      if (out.fallbackAllowed) {
        return viaSchool(school('KEY_NOT_ACTIVE', { fallbackFrom: out.code, ...(out.label ? { label: out.label } : {}) }));
      }
      throw new PersonalAiError(out.code, out.message, out.label);
    case 'disabled':
      throw new AiDisabledError(out.reason as AiReason);
    default:
      return viaSchool(school('GATEWAY_UNAVAILABLE'));
  }
}

/* ---- tests ---- */

export function __resetMyAiCache(): void {
  routesCache.clear();
  routesFailedAt.clear();
  routesInflight.clear();
}

export function __ageMyAiRoutes(misUserId: string, ageMs: number): void {
  const hit = routesCache.get(misUserId);
  if (hit) routesCache.set(misUserId, { ...hit, fetchedAt: Date.now() - ageMs });
}
