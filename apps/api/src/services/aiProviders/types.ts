/**
 * The provider-agnostic JSON-Schema subset shared by every AI adapter.
 *
 * Ported from nga-task-mentor/server/src/services/aiProviders (itself ported
 * from nga_central_mis) — deliberately unchanged in shape so a prompt written
 * against one NGA app's chain works against another's. The only edits are ESM
 * import specifiers and `import type`.
 */
export type JSONSchemaType = 'object' | 'string' | 'array' | 'number' | 'boolean';

export interface JSONSchema {
  type: JSONSchemaType;
  description?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
}

export interface GenerateJSONParams {
  prompt: string;
  schema: JSONSchema;
  /** Short machine name — Groq and OpenAI require a `json_schema` name. */
  schemaName?: string;
  /** Output token budget hint; providers default this low. */
  maxOutputTokens?: number;
}

export interface AIProvider {
  name: string;
  /** Whether this provider has the env vars it needs. */
  isConfigured(): boolean;
  /**
   * true only where the response is guaranteed to match `schema` by constrained
   * decoding. false where the provider only guarantees valid JSON (GLM's
   * json_object mode) — those need the runtime check in schemaValidator.ts.
   */
  supportsStrictSchema: boolean;
  generateJSON<T = unknown>(params: GenerateJSONParams): Promise<T>;
  /** Plain-text completion, for output too polymorphic for a fixed schema. */
  generateText(prompt: string, maxOutputTokens?: number): Promise<string>;
}
