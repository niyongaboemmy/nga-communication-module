import OpenAI from 'openai';
import type { AIProvider, GenerateJSONParams } from './types.js';
import { toStrictJsonSchema } from './strictJsonSchema.js';

const isConfigured = () => !!process.env.GROQ_API_KEY;

let client: OpenAI | null = null;
const getClient = (): OpenAI =>
  (client ??= new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
    timeout: 60_000,
  }));

const model = () => process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

export const groqProvider: AIProvider = {
  name: 'groq',
  isConfigured,
  supportsStrictSchema: true,

  async generateJSON<T = unknown>(params: GenerateJSONParams): Promise<T> {
    const completion = await getClient().chat.completions.create({
      model: model(),
      messages: [{ role: 'user', content: params.prompt }],
      // gpt-oss models spend part of the completion budget on reasoning tokens
      // before emitting the JSON; 'low' leaves more of it for the content. The
      // cap is also deliberate — free-tier Groq has a low tokens-per-minute
      // ceiling, and a meeting summary asks for this several times an hour.
      max_completion_tokens: Math.min(params.maxOutputTokens ?? 3000, 6000),
      reasoning_effort: 'low',
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
      max_completion_tokens: Math.min(maxOutputTokens ?? 3000, 6000),
      reasoning_effort: 'low',
    } as never);
    return completion.choices[0]?.message?.content || '';
  },
};
