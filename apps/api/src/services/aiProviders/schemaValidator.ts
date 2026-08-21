import type { JSONSchema } from './types.js';

/**
 * Runtime shape check for providers that guarantee valid JSON but not
 * schema-matching JSON. Required keys and basic types only — not a full
 * JSON-Schema validator, and deliberately so: the point is to catch a provider
 * returning the wrong shape so the chain falls through to the next one.
 */
export function matchesSchema(value: unknown, schema: JSONSchema): boolean {
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (!(key in obj)) return false;
      for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
        if (key in obj && !matchesSchema(obj[key], propSchema)) return false;
      }
      return true;
    }
    case 'array':
      if (!Array.isArray(value)) return false;
      return schema.items ? value.every((v) => matchesSchema(v, schema.items!)) : true;
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'boolean': return typeof value === 'boolean';
    default: return true;
  }
}
