import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { aiAppEnabled, externalPupilDataAllowed } from '../vendor/nga-access/index.js';
import type { AiPolicy } from '../vendor/nga-access/index.js';
import { config } from '../config.js';
import { getAiPolicy } from './aiPolicy.js';
import { matchesSchema } from './aiProviders/schemaValidator.js';
import type { JSONSchema } from './aiProviders/types.js';

/**
 * External AI: people's own Claude / ChatGPT subscriptions
 * (REUSING_AI_SUBSCRIPTIONS_ANALYSIS.md; EXTERNAL_AI_CONTRACT.md in the MIS).
 *
 * A subscription can never be called by Tupo (vendor terms). Two legitimate routes:
 *   hand-off   "Open in Claude / ChatGPT" with Tupo's exact prompt, then "Paste
 *              the answer" back. Any AI call made by a person can do it: the
 *              request carries `aiHandoff`, and the provider chokepoint
 *              (aiProviders/generate.ts) returns the prompt or uses the pasted
 *              answer instead of calling a model.
 *   connector  NGA as an MCP server in the person's own Claude / ChatGPT; the MIS
 *              relays "tupo_" tools to routes/integration.ts (draft-only).
 *
 * Both are staff-only (MIS capability AI_EXTERNAL_CONNECT, read from the
 * person's MIS permission list) and behind the school's policy: the master and
 * "tupo" switches, then policy.external, all off by default. Never the worker.
 *
 * Wording and parsing match the MIS reference (backend/src/services/ai/handoff.ts).
 */

export const CAP_EXTERNAL = 'AI_EXTERNAL_CONNECT';

export type AiHandoff =
  | { mode: 'prompt'; /** The person ticked "Include pupil details" for this request. */ pupilConsent?: boolean }
  | { mode: 'import'; text: string };

export interface HandoffPayload {
  prompt: string;
  /** "json": the answer must be one JSON object (fenced); "text": any text. */
  expects: 'json' | 'text';
  schemaName?: string;
}

/** Not a failure: how a prompt-mode request stops before any provider is called. */
export class HandoffPrompt extends Error {
  readonly code = 'AI_HANDOFF_PROMPT';
  constructor(readonly payload: HandoffPayload) {
    super('AI hand-off prompt');
    this.name = 'HandoffPrompt';
  }
}

export const isHandoffPrompt = (e: unknown): e is HandoffPrompt => e instanceof HandoffPrompt;

/** A refusal: `{ success:false, code, message }` with this status. */
export class ExternalAiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ExternalAiError';
  }
}

export const isExternalAiError = (e: unknown): e is ExternalAiError => e instanceof ExternalAiError;

/**
 * The answer for either: a prompt is a 200 `{ success, handoff }`, a refusal its
 * status with `{ success:false, code, message }`. null for anything else.
 */
export function handoffResponse(err: unknown): { status: number; body: Record<string, unknown> } | null {
  if (isHandoffPrompt(err)) return { status: 200, body: { success: true, handoff: err.payload } };
  if (isExternalAiError(err)) return { status: err.status, body: { success: false, code: err.code, message: err.message } };
  return null;
}

const MAX_PASTE = 200_000;

/** `aiHandoff` from a request body. Anything that isn't a hand-off is ignored (a normal AI call). */
export function parseHandoff(raw: unknown): AiHandoff | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.mode === 'prompt') return { mode: 'prompt', pupilConsent: r.pupilConsent === true };
  if (r.mode === 'import') {
    const text = typeof r.text === 'string' ? r.text : '';
    if (!text.trim()) throw new ExternalAiError(400, 'AI_HANDOFF_EMPTY', 'Paste the answer from your AI first.');
    if (text.length > MAX_PASTE) throw new ExternalAiError(400, 'AI_HANDOFF_TOO_LONG', 'That answer is too long to import.');
    return { mode: 'import', text };
  }
  return undefined;
}

/** Emails and phone numbers never leave in a hand-off prompt (same patterns as the MIS). */
export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/(?:\+?250|0)\s?7\d(?:[\s-]?\d){7}/g, '[phone]')
    .replace(/\+\d{1,3}(?:[\s-]?\d){7,12}/g, '[phone]');
}

/** The provider prompt plus an instruction any chat model follows: one fenced JSON object. */
export function jsonHandoffPrompt(prompt: string, schema: JSONSchema): string {
  return [
    prompt.trim(),
    '',
    'Answer with ONLY one JSON object that matches this JSON Schema, inside a ```json code block, with no other text:',
    JSON.stringify(schema),
  ].join('\n');
}

const NOT_IN_FORMAT =
  "The pasted answer isn't in the expected format. Paste the whole reply, including the ```json block, or ask your AI to answer again in that format.";

/** The JSON object in a pasted answer: the last ```json block, else the outermost {...}. */
export function readPastedJson<T>(text: string, schema: JSONSchema): T {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => (m[1] ?? '').trim()).filter((s) => s.startsWith('{'));
  const candidates = fenced.length ? fenced.reverse() : [];
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (matchesSchema(parsed, schema)) return parsed as T;
    } catch {
      /* try the next candidate */
    }
  }
  throw new ExternalAiError(400, 'AI_HANDOFF_FORMAT', NOT_IN_FORMAT);
}

/** A plain-text answer: the reply as pasted, without a wrapping code fence. */
export function readPastedText(text: string): string {
  const fenced = /^\s*```[\w-]*\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  const out = (fenced?.[1] ?? text).trim();
  if (!out) throw new ExternalAiError(400, 'AI_HANDOFF_FORMAT', 'The pasted answer is empty.');
  return out;
}

/* ─────────────────────────────── the person's MIS permission list ─────── */

const PERMS_TTL_MS = 60_000;
const permsCache = new Map<string, { perms: Set<string>; at: number }>();
const tokenKey = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * The person's MIS permission list. The SSO token the MIS mints carries it as
 * a `permissions` claim (decoded, not verified: it came from the MIS through
 * our own signed session, or was just checked by /auth/verify). A token
 * without the claim falls back to MIS GET /users/me. Empty on any failure.
 */
export async function misPermissionsOf(misToken: string | null | undefined): Promise<Set<string>> {
  if (!misToken) return new Set();
  try {
    const claims = jwt.decode(misToken) as { permissions?: unknown } | null;
    if (claims && Array.isArray(claims.permissions)) {
      return new Set(claims.permissions.filter((p): p is string => typeof p === 'string'));
    }
  } catch {
    /* not a JWT: ask the MIS */
  }
  const key = tokenKey(misToken);
  const hit = permsCache.get(key);
  if (hit && Date.now() - hit.at < PERMS_TTL_MS) return hit.perms;
  try {
    const resp = await fetch(`${config.misBaseUrl}/users/me`, {
      headers: { Authorization: `Bearer ${misToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return new Set();
    const body = (await resp.json()) as { data?: { permissions?: unknown }; permissions?: unknown };
    const list = (body?.data ?? body)?.permissions;
    const perms = new Set<string>(Array.isArray(list) ? list.filter((p: unknown): p is string => typeof p === 'string') : []);
    if (permsCache.size > 2_000) permsCache.clear();
    permsCache.set(key, { perms, at: Date.now() });
    return perms;
  } catch {
    return new Set();
  }
}

export interface ExternalSubject {
  misToken?: string | null;
  roleLevel?: string | null;
  role?: string | null;
  system?: boolean;
}

/** Does this person hold AI_EXTERNAL_CONNECT in the MIS? Students and the worker never do. */
export async function holdsExternalCap(who: ExternalSubject | null | undefined): Promise<boolean> {
  if (!who || who.system) return false;
  if (who.roleLevel === 'STUDENT' || who.role === 'student') return false;
  return (await misPermissionsOf(who.misToken)).has(CAP_EXTERNAL);
}

/* ──────────────────────────────────────────────────────────── hand-off ─── */

/** May this person use hand-off right now? Throws the contract's 403s. */
export async function assertHandoffAllowed(who: ExternalSubject): Promise<AiPolicy> {
  const policy = await getAiPolicy();
  if (!policy || !aiAppEnabled(policy, 'tupo')) {
    // assertTupoAiEnabled normally answers first (AI_DISABLED); this is the backstop.
    throw new ExternalAiError(403, 'AI_DISABLED', 'AI is turned off for the school.');
  }
  if (!policy.external.handoff) {
    throw new ExternalAiError(403, 'AI_HANDOFF_OFF', 'Open in Claude / ChatGPT is turned off for the school.');
  }
  if (!(await holdsExternalCap(who))) {
    throw new ExternalAiError(403, 'AI_HANDOFF_NOT_ALLOWED', 'Your role cannot use your own Claude or ChatGPT with NGA.');
  }
  return policy;
}

/** Pupil data may leave only with the school's policy and this person's consent for this request. */
export function assertHandoffPupilData(policy: AiPolicy, pupilData: boolean | undefined, consent: boolean | undefined): void {
  if (!pupilData) return;
  if (!externalPupilDataAllowed(policy, consent === true)) {
    throw new ExternalAiError(
      403,
      'AI_HANDOFF_PUPIL_CONSENT',
      'This prompt may include a pupil\'s details. Tick "Include pupil details" to take it to your own AI, or use the school\'s AI.',
    );
  }
}

/** Is the school offering hand-off to this person? (For the UI; never throws.) */
export async function handoffOffered(who: ExternalSubject): Promise<boolean> {
  try {
    await assertHandoffAllowed(who);
    return true;
  } catch {
    return false;
  }
}

/** Test hook. */
export function __resetExternalAiCache(): void {
  permsCache.clear();
}
