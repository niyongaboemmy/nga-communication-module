import type { GenerateJSONParams } from './types.js';
import { orderedProviders, isCoolingDown, markCoolingDown } from './registry.js';
import { isQuotaError, friendlyAIErrorMessage } from './errors.js';

export interface GenerateStructuredContentResult<T> {
  data: T;
  providerUsed: string;
}

export interface GenerateStructuredContentOptions {
  /** Try these providers, in this order, instead of AI_PROVIDER_ORDER. */
  providerOrder?: string[];
}

/**
 * Tries each configured provider in order, skipping any cooling down from a
 * recent quota error, and returns the first success.
 */
export async function generateStructuredContent<T = unknown>(
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
