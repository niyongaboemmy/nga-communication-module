import OpenAI from 'openai';
import type { AIProvider, GenerateJSONParams } from './types.js';
import { matchesSchema } from './schemaValidator.js';

/**
 * OpenRouter, restricted to FREE models only.
 *
 * - Only ids ending in ":free" (plus the "openrouter/free" router, which picks
 *   among free models) are ever sent. Anything else in OPENROUTER_MODELS is
 *   dropped with a warning, so a typo or a paid id can never cost money.
 * - The list goes out as OpenRouter's `models` fallback array: if the first
 *   free model is rate-limited upstream or down, OpenRouter tries the next one.
 * - The reply is rejected if OpenRouter served a non-free model or charged.
 *
 * Free-model limits are per OpenRouter ACCOUNT (shared by every NGA app using
 * the key): 20 requests/minute, 50/day (1000/day once $10 of credits has ever
 * been bought). An exhausted limit is a 429, which the chain treats as quota.
 */
const DEFAULT_MODELS = ['nvidia/nemotron-3-super-120b-a12b:free', 'openrouter/free'] as const;
// OpenRouter caps how many fallbacks it will try; three keeps us well inside it.
const MAX_MODELS = 3;

export const isFreeModel = (id: string): boolean =>
  id.endsWith(':free') || id === 'openrouter/free';

let warned = false;
export function freeModels(): string[] {
  const configured = (process.env.OPENROUTER_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const free = configured.filter(isFreeModel);
  const rejected = configured.filter((id) => !isFreeModel(id));
  if (rejected.length && !warned) {
    warned = true;
    console.warn(`[AI] OpenRouter: ignoring non-free model(s) in OPENROUTER_MODELS: ${rejected.join(', ')}`);
  }
  return (free.length ? free : [...DEFAULT_MODELS]).slice(0, MAX_MODELS);
}

const isConfigured = () => !!process.env.OPENROUTER_API_KEY;

// OpenRouter is OpenAI-compatible. The attribution headers are optional; they
// only label this app on the OpenRouter usage dashboard.
let client: OpenAI | null = null;
const getClient = (): OpenAI =>
  (client ??= new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    timeout: 150_000,
    // OpenRouter already falls back across the models list; one SDK retry is enough.
    maxRetries: 1,
    defaultHeaders: {
      'X-Title': 'Tupo',
      ...(process.env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL } : {}),
    },
  }));

interface OpenRouterCompletion {
  model?: string;
  usage?: { cost?: number };
  error?: { code?: number; message?: string };
  choices?: { message?: { content?: string | null } }[];
}

async function complete(
  messages: OpenAI.ChatCompletionMessageParam[],
  maxOutputTokens?: number,
  json?: boolean,
): Promise<string> {
  const models = freeModels();
  const completion = (await getClient().chat.completions.create({
    model: models[0] ?? DEFAULT_MODELS[0],
    // OpenRouter-only field, passed through in the request body by the SDK.
    ...({ models } as object),
    ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
    messages,
    ...(json ? { response_format: { type: 'json_object' as const } } : {}),
  })) as unknown as OpenRouterCompletion;

  // Upstream failures can come back as HTTP 200 with an error body; give them
  // a status so isQuotaError sees a 429 as quota.
  if (completion.error) {
    const err = new Error(`OpenRouter: ${completion.error.message || 'provider error'}`) as Error & {
      status?: number;
    };
    err.status = completion.error.code;
    throw err;
  }
  const served = String(completion.model || '');
  const cost = Number(completion.usage?.cost || 0);
  if (!isFreeModel(served) || cost > 0) {
    console.error(`[AI] OpenRouter served a non-free model (${served}, cost ${cost}); reply discarded`);
    throw new Error('OpenRouter served a non-free model');
  }
  return String(completion.choices?.[0]?.message?.content || '');
}

export const openrouterProvider: AIProvider = {
  name: 'openrouter',
  isConfigured,
  // json_object works on most free models, but strict json_schema support
  // varies by model, so the reply is checked afterwards like GLM and DeepSeek.
  supportsStrictSchema: false,

  async generateJSON<T = unknown>(params: GenerateJSONParams): Promise<T> {
    const text = await complete(
      [
        {
          role: 'system',
          content:
            'Respond with ONLY a single JSON object matching this JSON Schema — no markdown ' +
            `fences, no commentary, no explanation:\n${JSON.stringify(params.schema)}`,
        },
        { role: 'user', content: params.prompt },
      ],
      params.maxOutputTokens,
      true,
    );
    const parsed = JSON.parse(text || '{}') as T;
    if (!matchesSchema(parsed, params.schema)) {
      throw new Error('OpenRouter response did not match the expected schema');
    }
    return parsed;
  },

  async generateText(prompt: string, maxOutputTokens?: number): Promise<string> {
    return complete([{ role: 'user', content: prompt }], maxOutputTokens);
  },
};
