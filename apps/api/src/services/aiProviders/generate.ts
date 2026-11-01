import type { GenerateJSONParams } from './types.js';
import { orderedProviders, isCoolingDown, markCoolingDown } from './registry.js';
import { isQuotaError, friendlyAIErrorMessage } from './errors.js';
import { assertTupoAiEnabled } from '../aiPolicy.js';
import { postJson, postText, withPersonalAi, type PersonalAiCall } from '../myAiGateway.js';
import type { AiAnswer } from '@tupo/shared';
import {
  HandoffPrompt, assertHandoffAllowed, assertHandoffPupilData, jsonHandoffPrompt, parseHandoff,
  readPastedJson, readPastedText, scrub, type AiHandoff,
} from '../externalAi.js';
import type { AiPolicy } from '../../vendor/nga-access/index.js';

export interface GenerateStructuredContentResult<T> {
  data: T;
  providerUsed: string;
  /** Which AI answered: the school chain, or the person's own key (My AI). */
  ai?: AiAnswer;
}

export interface GenerateStructuredContentOptions {
  /** Try these providers, in this order, instead of AI_PROVIDER_ORDER. */
  providerOrder?: string[];
  /**
   * A call made by a person: their own key (My AI) may answer it through the
   * MIS gateway. Left out for background work, which always uses the school AI.
   */
  personal?: PersonalAiCall;
}

/** What answered a pasted hand-off answer: shown as "via your own AI (pasted)". */
const HANDOFF_AI: AiAnswer = { route: 'handoff', reason: 'HANDOFF' };

/**
 * External AI hand-off (services/externalAi.ts): the call asked for its prompt
 * ("Open in my AI") or brought a pasted answer. Gated here, at the chokepoint,
 * after the school's master switch: policy.external.handoff and the person's
 * AI_EXTERNAL_CONNECT. Never for background work. undefined = a normal call.
 */
async function handoffFor(
  call: PersonalAiCall | null | undefined,
): Promise<{ handoff: AiHandoff; policy: AiPolicy } | undefined> {
  if (!call || call.system || call.handoffRaw == null) return undefined;
  const handoff = parseHandoff(call.handoffRaw);
  if (!handoff) return undefined;
  return { handoff, policy: await assertHandoffAllowed(call) };
}

/**
 * Tries each configured provider in order, skipping any cooling down from a
 * recent quota error, and returns the first success.
 */
export async function generateStructuredContent<T = unknown>(
  params: GenerateJSONParams,
  options?: GenerateStructuredContentOptions,
): Promise<GenerateStructuredContentResult<T>> {
  // The school's master switch (MIS ai_policy) comes before any provider, and
  // before My AI: a personal key only ever picks WHICH AI answers an allowed call.
  // Throws AiDisabledError, which the routes answer as 403 AI_DISABLED.
  await assertTupoAiEnabled();
  const handoff = await handoffFor(options?.personal);
  if (handoff) {
    if (handoff.handoff.mode === 'prompt') {
      assertHandoffPupilData(handoff.policy, options?.personal?.pupilData, handoff.handoff.pupilConsent);
      throw new HandoffPrompt({
        prompt: scrub(jsonHandoffPrompt(params.prompt, params.schema)), expects: 'json', schemaName: params.schemaName,
      });
    }
    return { data: readPastedJson<T>(handoff.handoff.text, params.schema), providerUsed: 'handoff', ai: HANDOFF_AI };
  }
  return withPersonalAi<T>(options?.personal, {
    // Exactly the prompt and schema the school chain gets.
    personal: (misUserId, base) => postJson<T>(misUserId, {
      ...base, prompt: params.prompt, schema: params.schema,
      schemaName: params.schemaName, maxOutputTokens: params.maxOutputTokens,
    }),
    school: () => schoolStructuredContent<T>(params, options),
  });
}

async function schoolStructuredContent<T>(
  params: GenerateJSONParams,
  options?: GenerateStructuredContentOptions,
): Promise<GenerateStructuredContentResult<T>> {
  const providers = orderedProviders(options?.providerOrder);
  let lastErr: unknown = null;
  let attempted = 0;

  for (const provider of providers) {
    if (!provider.isConfigured()) continue;
    if (isCoolingDown(provider.name)) {
      console.log(`[AI] ${provider.name} is cooling down, skipping`);
      continue;
    }
    attempted++;
    try {
      const data = await provider.generateJSON<T>(params);
      return { data, providerUsed: provider.name };
    } catch (err) {
      lastErr = err;
      console.error(`[AI] provider ${provider.name} failed:`, err instanceof Error ? err.message : err);
      if (isQuotaError(err)) markCoolingDown(provider.name);
    }
  }

  if (attempted === 0) {
    throw new Error(
      'AI is not configured. Add an API key for at least one provider to the API environment.',
    );
  }
  throw new Error(friendlyAIErrorMessage(lastErr));
}

const stripAndParseJson = (text: string): unknown => {
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const arr = cleaned.match(/\[[\s\S]*\]/);
    if (arr) return JSON.parse(arr[0]);
    const obj = cleaned.match(/\{[\s\S]*\}/);
    if (obj) return JSON.parse(obj[0]);
    throw new Error('AI response was not valid JSON');
  }
};

/** Same fallback behaviour, for output whose shape is too polymorphic for a schema. */
export async function generateFreeformJSON<T = unknown>(
  prompt: string,
  maxOutputTokens?: number,
  options?: GenerateStructuredContentOptions,
): Promise<GenerateStructuredContentResult<T>> {
  // The school's master switch (MIS ai_policy) comes before any provider.
  // Throws AiDisabledError, which the routes answer as 403 AI_DISABLED.
  await assertTupoAiEnabled();
  const providers = orderedProviders(options?.providerOrder);
  let lastErr: unknown = null;
  let attempted = 0;

  for (const provider of providers) {
    if (!provider.isConfigured()) continue;
    if (isCoolingDown(provider.name)) continue;
    attempted++;
    try {
      const text = await provider.generateText(prompt, maxOutputTokens);
      return { data: stripAndParseJson(text) as T, providerUsed: provider.name };
    } catch (err) {
      lastErr = err;
      console.error(`[AI] provider ${provider.name} failed:`, err instanceof Error ? err.message : err);
      if (isQuotaError(err)) markCoolingDown(provider.name);
    }
  }

  if (attempted === 0) throw new Error('AI is not configured.');
  throw new Error(friendlyAIErrorMessage(lastErr));
}

/** Plain prose, no JSON — used for translation and one-line titles. */
export async function generatePlainText(
  prompt: string,
  maxOutputTokens?: number,
  options?: GenerateStructuredContentOptions,
): Promise<GenerateStructuredContentResult<string>> {
  // The school's master switch (MIS ai_policy) comes before any provider and My AI.
  // Throws AiDisabledError, which the routes answer as 403 AI_DISABLED.
  await assertTupoAiEnabled();
  const handoff = await handoffFor(options?.personal);
  if (handoff) {
    if (handoff.handoff.mode === 'prompt') {
      assertHandoffPupilData(handoff.policy, options?.personal?.pupilData, handoff.handoff.pupilConsent);
      throw new HandoffPrompt({ prompt: scrub(prompt), expects: 'text' });
    }
    return { data: readPastedText(handoff.handoff.text), providerUsed: 'handoff', ai: HANDOFF_AI };
  }
  const out = await withPersonalAi<string>(options?.personal, {
    // Exactly the prompt the school chain gets (no system prompt there either).
    personal: (misUserId, base) => postText(misUserId, { ...base, prompt }),
    school: () => schoolPlainText(prompt, maxOutputTokens, options),
  });
  return out.ai.route === 'personal' ? { ...out, data: String(out.data ?? '').trim() } : out;
}

async function schoolPlainText(
  prompt: string,
  maxOutputTokens?: number,
  options?: GenerateStructuredContentOptions,
): Promise<GenerateStructuredContentResult<string>> {
  const providers = orderedProviders(options?.providerOrder);
  let lastErr: unknown = null;
  let attempted = 0;

  for (const provider of providers) {
    if (!provider.isConfigured()) continue;
    if (isCoolingDown(provider.name)) continue;
    attempted++;
    try {
      const text = await provider.generateText(prompt, maxOutputTokens);
      if (text.trim()) return { data: text.trim(), providerUsed: provider.name };
      throw new Error('empty completion');
    } catch (err) {
      lastErr = err;
      if (isQuotaError(err)) markCoolingDown(provider.name);
    }
  }

  if (attempted === 0) throw new Error('AI is not configured.');
  throw new Error(friendlyAIErrorMessage(lastErr));
}
