import type { JSONSchema } from './types.js';

/**
 * OpenAI-compatible `strict: true` mode requires every object to set
 * `additionalProperties: false` and list every property under `required`. The
 * shared JSONSchema type carries neither, so they are injected here rather than
 * leaking an OpenAI-ism into the schemas every caller writes.
 */
export function toStrictJsonSchema(schema: JSONSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: schema.type };
  if (schema.description) out.description = schema.description;
  if (schema.type === 'object') {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      properties[key] = toStrictJsonSchema(value);
    }
    out.properties = properties;
    out.required = Object.keys(schema.properties ?? {});
    out.additionalProperties = false;
  }
  if (schema.type === 'array' && schema.items) out.items = toStrictJsonSchema(schema.items);
  return out;
}
