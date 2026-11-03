import { useEffect, useState } from 'react';
import { apiGet, SESSION_KEY } from '../lib/api';

/**
 * The school-wide AI switch (MIS ai_policy, read through `GET /api/ai/policy`).
 *
 * Only the super admin's master switch and Tupo's own app switch — who may use
 * Mail AI or Meet AI is still MAIL_AI_USE / MEET_AI_USE. UX only: every AI
 * route refuses with 403 AI_DISABLED on its own when this is off.
 *
 * `null` while loading or when it cannot be read; screens then behave as
 * before and let the server answer. Shared across components and re-read at
 * most once a minute, so three mail panes cost one request.
 */
export interface AiPolicyState {
  enabled: boolean;
  reason: string;
  message: string;
}

export const AI_OFF_MESSAGE = 'AI is turned off for the school.';

const TTL_MS = 60_000;
let cached: { at: number; value: AiPolicyState } | null = null;
let inflight: Promise<AiPolicyState | null> | null = null;

function load(): Promise<AiPolicyState | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.value);
  // A meeting guest has no session, and this route is for signed-in users only.
  if (!localStorage.getItem(SESSION_KEY)) return Promise.resolve(null);
  inflight ??= apiGet<AiPolicyState>('/api/ai/policy')
    .then((r) => {
      const value = r.data ?? null;
      if (value) cached = { at: Date.now(), value };
      return value;
    })
    .catch(() => null)
    .finally(() => { inflight = null; });
  return inflight;
}

export function useAiPolicy(): AiPolicyState | null {
  const [policy, setPolicy] = useState<AiPolicyState | null>(cached?.value ?? null);
  useEffect(() => {
    let live = true;
    void load().then((p) => { if (live) setPolicy(p); });
    return () => { live = false; };
  }, []);
  return policy;
}

/** The "turned off" note to show in place of the AI actions, or null when AI is on. */
export const aiOffMessage = (p: AiPolicyState | null): string | null =>
  p && !p.enabled ? (p.message || AI_OFF_MESSAGE) : null;
