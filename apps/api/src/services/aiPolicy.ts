import { config } from '../config.js';
import {
  AI_REASON_MESSAGES, aiAppEnabled, decideAi, normalizeAiPolicy,
  type AiPolicy, type AiReason,
} from '../vendor/nga-access/index.js';

/**
 * The school-wide AI policy, owned by the MIS (AI_USAGE_CONTROL_PLAN §7).
 *
 * Tupo adds no AI rules of its own: MAIL_AI_USE, MEET_AI_USE and a meeting's
 * aiAssistantEnabled still decide who may use what. This is only the super
 * admin's master switch (plus the per-app "tupo" switch) sitting in front of
 * every model call.
 *
 *  - Fetched from MIS `GET /integrations/ai-policy` with the SSO client
 *    credentials (HTTP Basic), the same credentials the manifest publisher uses.
 *  - Fresh for 60 s. The /verify-mis poll reports `ai_policy_v`; a new value
 *    drops the cache so a flip reaches Tupo within one poll.
 *  - A failed fetch keeps the last good copy for 15 minutes, then fails closed
 *    (null, which decideAi reads as GLOBAL_OFF). No copy at all is null too.
 *  - A slow MIS never holds a request for more than 3 s.
 */

const FRESH_MS = 60_000;
const STALE_GRACE_MS = 15 * 60_000;
const TIMEOUT_MS = () => Number(process.env.AI_POLICY_TIMEOUT_MS) || 3_000;
/** After a failed fetch, wait this long before asking the MIS again. */
const RETRY_AFTER_MS = 30_000;

interface Entry { policy: AiPolicy; fetchedAt: number }

let cached: Entry | null = null;
let inflight: Promise<AiPolicy | null> | null = null;
let failedAt = 0;
/** Set by tests; `undefined` means "use the MIS". */
let injected: AiPolicy | null | undefined;

async function fetchFromMis(): Promise<AiPolicy | null> {
  try {
    const auth = Buffer.from(`${config.ssoClientId}:${config.ssoClientSecret}`).toString('base64');
    const response = await fetch(`${config.misBaseUrl}/integrations/ai-policy`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS()),
    });
    if (!response.ok) {
      console.warn('[ai-policy] MIS refused the policy read:', response.status);
      failedAt = Date.now();
      return null;
    }
    const body = (await response.json()) as { success?: boolean; data?: { policy?: unknown } };
    if (!body?.success || !body.data?.policy) { failedAt = Date.now(); return null; }
    const policy = normalizeAiPolicy(body.data.policy);
    cached = { policy, fetchedAt: Date.now() };
    failedAt = 0;
    return policy;
  } catch (err) {
    console.warn('[ai-policy] MIS unreachable:', err instanceof Error ? err.message : err);
    failedAt = Date.now();
    return null;
  }
}

/** The current policy, or null when it cannot be known (fail closed). */
export async function getAiPolicy(): Promise<AiPolicy | null> {
  if (injected !== undefined) return injected;
  const now = Date.now();
  if (cached && now - cached.fetchedAt < FRESH_MS) return cached.policy;

  // Just failed: do not make every request wait on a MIS that is down.
  if (!failedAt || now - failedAt >= RETRY_AFTER_MS) {
    inflight ??= fetchFromMis().finally(() => { inflight = null; });
    const fresh = await inflight;
    if (fresh) return fresh;
  }
  // MIS is down or refused: a recent copy is still the school's decision.
  if (cached && now - cached.fetchedAt < STALE_GRACE_MS) return cached.policy;
  return null;
}

/**
 * The verify poll saw this `ai_policy_v`. A different version from the cached
 * copy means the super admin changed something: refetch on the next call.
 */
export function noteAiPolicyVersion(version: unknown): boolean {
  if (version === null || version === undefined) return false;
  const v = Number(version);
  if (!Number.isFinite(v) || !cached || cached.policy.v === v) return false;
  cached = { ...cached, fetchedAt: 0 };
  failedAt = 0;
  return true;
}

export interface TupoAiState {
  enabled: boolean;
  reason: AiReason;
  message: string;
}

/**
 * Is AI on for Tupo at all? Only the school-wide part of the rule — the
 * per-feature permissions are checked by the routes as before.
 */
export async function tupoAiState(): Promise<TupoAiState> {
  const policy = await getAiPolicy();
  if (aiAppEnabled(policy, 'tupo')) {
    return { enabled: true, reason: 'ALLOWED_BY_POLICY', message: AI_REASON_MESSAGES.ALLOWED_BY_POLICY };
  }
  // decideAi gives the reason (GLOBAL_OFF vs APP_OFF) the same way every app does.
  const { reason } = decideAi(policy, { app: 'tupo', feature: 'author', hasAiUse: true });
  return { enabled: false, reason, message: AI_REASON_MESSAGES[reason] };
}

/** Thrown by the provider chokepoint when the school has turned AI off. */
export class AiDisabledError extends Error {
  readonly code = 'AI_DISABLED';
  readonly status = 403;
  constructor(readonly reason: AiReason) {
    super(AI_REASON_MESSAGES[reason]);
    this.name = 'AiDisabledError';
  }
}

export const isAiDisabledError = (err: unknown): err is AiDisabledError =>
  err instanceof AiDisabledError;

/**
 * The response body for a refusal: Tupo's `{success:false, message}` envelope
 * with `code` and `reason` beside it, the shape every NGA app uses.
 */
export const aiDisabledBody = (err: AiDisabledError) => ({
  success: false as const,
  code: err.code,
  reason: err.reason,
  message: err.message,
});

/** The chokepoint: every model call in Tupo goes through this first. */
export async function assertTupoAiEnabled(): Promise<void> {
  const state = await tupoAiState();
  if (!state.enabled) throw new AiDisabledError(state.reason);
}

/* ---- tests ---- */

/** Pin the policy (or null, i.e. unknown) for tests; `undefined` restores the MIS. */
export function setAiPolicyForTests(policy: AiPolicy | Record<string, unknown> | null | undefined): void {
  injected = policy === undefined || policy === null ? policy : normalizeAiPolicy(policy);
}

export function __resetAiPolicyCache(): void {
  cached = null;
  inflight = null;
  failedAt = 0;
  injected = undefined;
}

export function __ageAiPolicy(ageMs: number): void {
  if (cached) cached = { ...cached, fetchedAt: Date.now() - ageMs };
}
