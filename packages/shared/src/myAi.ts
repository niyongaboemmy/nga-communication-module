/**
 * "My AI": people's own AI provider keys, held in the NGA MIS
 * (PERSONAL_AI_PROVIDERS_PLAN.md §10, MY_AI_GATEWAY.md). Tupo never sees a key;
 * it only learns which AI answered, so the panels can say "via My Claude".
 */

/** Which AI answered one call. Sent next to `providerUsed` on every AI answer. */
export interface AiAnswer {
  route: 'personal' | 'school';
  /** Why: PERSONAL, NO_ROUTE, PERSONAL_OFF, SYSTEM_CALL, KEY_NOT_ACTIVE, GATEWAY_UNAVAILABLE, … */
  reason: string;
  credentialId?: number;
  /** The person's own name for the key ("My Claude"). */
  label?: string;
  provider?: string;
  model?: string;
  /** The personal key failed with this code, and the school's AI answered instead. */
  fallbackFrom?: string;
  /** What the MIS skipped when it sent the call back to the school AI. */
  skipped?: unknown;
}

/** One key the person may pick for a single request. */
export interface MyAiChoice {
  credentialId: number;
  provider: string;
  model: string;
  label?: string;
}

/** GET /api/ai/my-routes: what answers this person in Tupo. No secrets. */
export interface MyAiRoutes {
  enabled: boolean;
  v?: number;
  policyV?: number;
  byTask?: Record<string, {
    route: 'personal' | 'school'; reason: string;
    credentialId?: number; provider?: string; model?: string; label?: string; fallbackToSchool?: boolean;
  }>;
  choices: MyAiChoice[];
}

/**
 * The value an AI request carries in `aiRoute` for a one-off choice: "school",
 * "<credentialId>" or "<credentialId>:<model>". Passed through to the MIS unchanged.
 */
export const isAiRouteValue = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 200 && (v === 'school' || /^\d{1,12}(:[\w.\-/:@+]{1,180})?$/.test(v));
