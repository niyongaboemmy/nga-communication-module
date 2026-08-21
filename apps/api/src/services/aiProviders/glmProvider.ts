import OpenAI from 'openai';
import type { AIProvider, GenerateJSONParams } from './types.js';
import { matchesSchema } from './schemaValidator.js';

const isConfigured = () => !!process.env.GLM_API_KEY;

let client: OpenAI | null = null;
const getClient = (): OpenAI =>
  (client ??= new OpenAI({
    apiKey: process.env.GLM_API_KEY,
    baseURL: 'https://api.z.ai/api/paas/v4',
    timeout: 150_000,
  }));

const model = () => process.env.GLM_MODEL || 'glm-4.5-flash';

export const glmProvider: AIProvider = {
  name: 'glm',
  isConfigured,
  // GLM's json_object mode guarantees valid JSON, not schema-matching JSON —
  // the schema only reaches it through the prompt, so the response is checked
  // afterwards and a mismatch falls the chain through to the next provider.
  supportsStrictSchema: false,

  async generateJSON<T = unknown>(params: GenerateJSONParams): Promise<T> {
    const completion = await getClient().chat.completions.create({
      model: model(),
      thinking: { type: 'disabled' },
      ...(params.maxOutputTokens ? { max_tokens: params.maxOutputTokens } : {}),
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
    } as never);

    const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}') as T;
    if (!matchesSchema(parsed, params.schema)) {
      throw new Error('GLM response did not match the expected schema');
    }
    return parsed;
  },

  async generateText(prompt: string, maxOutputTokens?: number): Promise<string> {
    const completion = await getClient().chat.completions.create({
      model: model(),
      thinking: { type: 'disabled' },
      ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
      messages: [{ role: 'user', content: prompt }],
    } as never);
    return completion.choices[0]?.message?.content || '';
  },
};
