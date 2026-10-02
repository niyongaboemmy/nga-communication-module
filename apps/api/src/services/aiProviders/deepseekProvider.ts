import OpenAI from 'openai';
import type { AIProvider, GenerateJSONParams } from './types.js';
import { matchesSchema } from './schemaValidator.js';

const isConfigured = () => !!process.env.DEEPSEEK_API_KEY;

let client: OpenAI | null = null;
const getClient = (): OpenAI =>
  (client ??= new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    timeout: 150_000,
  }));

const model = () => process.env.DEEPSEEK_MODEL || 'deepseek-chat';

// deepseek-chat caps output at 8K tokens and rejects larger max_tokens outright.
const MAX_OUTPUT_TOKENS = 8192;
const maxTokens = (n?: number) => (n ? { max_tokens: Math.min(n, MAX_OUTPUT_TOKENS) } : {});

export const deepseekProvider: AIProvider = {
  name: 'deepseek',
  isConfigured,
  // Like GLM, json_object mode guarantees valid JSON but not a schema match, so
  // the response is checked afterwards and a mismatch falls through the chain.
  supportsStrictSchema: false,

  async generateJSON<T = unknown>(params: GenerateJSONParams): Promise<T> {
    const completion = await getClient().chat.completions.create({
      model: model(),
      ...maxTokens(params.maxOutputTokens),
      messages: [
        {
          role: 'system',
          content:
            'Respond with ONLY a single JSON object matching this JSON Schema — no markdown ' +
            `fences, no commentary, no explanation:\n${JSON.stringify(params.schema)}`,
        },
        { role: 'user', content: params.prompt },
      ],
      response_format: { type: 'json_object' },
    });

    const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}') as T;
    if (!matchesSchema(parsed, params.schema)) {
      throw new Error('DeepSeek response did not match the expected schema');
    }
    return parsed;
  },

  async generateText(prompt: string, maxOutputTokens?: number): Promise<string> {
    const completion = await getClient().chat.completions.create({
      model: model(),
      ...maxTokens(maxOutputTokens),
      messages: [{ role: 'user', content: prompt }],
    });
    return completion.choices[0]?.message?.content || '';
  },
};
