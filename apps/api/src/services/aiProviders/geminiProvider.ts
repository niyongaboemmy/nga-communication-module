import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import type { AIProvider, GenerateJSONParams, JSONSchema } from './types.js';

const isConfigured = () =>
  !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here';

const GEMINI_TYPE_MAP: Record<JSONSchema['type'], SchemaType> = {
  object: SchemaType.OBJECT,
  string: SchemaType.STRING,
  array: SchemaType.ARRAY,
  number: SchemaType.NUMBER,
  boolean: SchemaType.BOOLEAN,
};

function toGeminiSchema(schema: JSONSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: GEMINI_TYPE_MAP[schema.type] };
  if (schema.description) out.description = schema.description;
  if (schema.properties) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      properties[key] = toGeminiSchema(value);
    }
    out.properties = properties;
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.required) out.required = schema.required;
  return out;
}

const getClient = () => new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const modelName = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';

export const geminiProvider: AIProvider = {
  name: 'gemini',
  isConfigured,
  supportsStrictSchema: true,

  async generateJSON<T = unknown>(params: GenerateJSONParams): Promise<T> {
    const model = getClient().getGenerativeModel({
      model: modelName(),
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(params.schema) as never,
        ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
      },
    });
    const result = await model.generateContent(params.prompt);
    return JSON.parse(result.response.text() || '{}') as T;
  },

  async generateText(prompt: string, maxOutputTokens?: number): Promise<string> {
    const model = getClient().getGenerativeModel({
      model: modelName(),
      ...(maxOutputTokens ? { generationConfig: { maxOutputTokens } } : {}),
    });
    const result = await model.generateContent(prompt);
    return result.response.text() || '';
  },
};
