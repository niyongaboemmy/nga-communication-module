import type { AIProvider } from './types.js';
import { geminiProvider } from './geminiProvider.js';
import { groqProvider } from './groqProvider.js';
import { glmProvider } from './glmProvider.js';
import { openaiProvider } from './openaiProvider.js';
import { deepseekProvider } from './deepseekProvider.js';
import { openrouterProvider } from './openrouterProvider.js';

const ALL_PROVIDERS: Record<string, AIProvider> = {
  gemini: geminiProvider,
  groq: groqProvider,
  glm: glmProvider,
  openai: openaiProvider,
  deepseek: deepseekProvider,
  openrouter: openrouterProvider,
};

const DEFAULT_ORDER = 'openai,gemini,groq,deepseek,openrouter,glm';

/**
 * Providers to try, in order. `overrideOrder` is for a feature with a genuine
 * reason to prefer a different provider first — it still falls through to the
 * rest rather than being limited to the override.
 */
export function orderedProviders(overrideOrder?: string[]): AIProvider[] {
  const names = (overrideOrder ?? (process.env.AI_PROVIDER_ORDER || DEFAULT_ORDER).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  return names.map((name) => ALL_PROVIDERS[name]).filter((p): p is AIProvider => !!p);
}

export const isAnyProviderConfigured = (): boolean =>
  orderedProviders().some((p) => p.isConfigured());

export const getProviderStatus = (): Record<string, boolean> =>
  Object.fromEntries(Object.entries(ALL_PROVIDERS).map(([name, p]) => [name, p.isConfigured()]));

/* --- Cooldown / circuit breaker --------------------------------------- *
 * A provider that just returned a quota error is skipped for COOLDOWN_MS
 * rather than retried on every request. Daily and per-minute quotas do reset,
 * so this is a temporary skip, not a disable. In-memory only. */
const COOLDOWN_MS = 5 * 60 * 1000;
const cooldownUntil = new Map<string, number>();

export function isCoolingDown(providerName: string): boolean {
  const until = cooldownUntil.get(providerName);
  return !!until && until > Date.now();
}

export function markCoolingDown(providerName: string, ms: number = COOLDOWN_MS): void {
  cooldownUntil.set(providerName, Date.now() + ms);
}
