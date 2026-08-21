import OpenAI from 'openai';
import type { AIProvider, GenerateJSONParams } from './types.js';
import { toStrictJsonSchema } from './strictJsonSchema.js';

const isConfigured = () =>
  !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_openai_api_key_here';

let client: OpenAI | null = null;
const getClient = (): OpenAI =>
  (client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000 }));

const model = () => process.env.OPENAI_MODEL || 'gpt-4o';

export const openaiProvider: AIProvider = {
  name: 'openai',
  isConfigured,
  supportsStrictSchema: true,

  async generateJSON<T = unknown>(params: GenerateJSONParams): Promise<T> {
    const completion = await getClient().chat.completions.create({
      model: model(),
      messages: [{ role: 'user', content: params.prompt }],
      ...(params.maxOutputTokens ? { max_completion_tokens: params.maxOutputTokens } : {}),
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: params.schemaName || 'response',
          strict: true,
          schema: toStrictJsonSchema(params.schema),
        },
      },
    } as never);
    return JSON.parse(completion.choices[0]?.message?.content || '{}') as T;
  },

  async generateText(prompt: string, maxOutputTokens?: number): Promise<string> {
    const completion = await getClient().chat.completions.create({
      model: model(),
      messages: [{ role: 'user', content: prompt }],
      ...(maxOutputTokens ? { max_completion_tokens: maxOutputTokens } : {}),
    } as never);
    return completion.choices[0]?.message?.content || '';
  },
};
