/**
 * "Open in my AI" destinations (EXTERNAL_AI_CONTRACT.md §1 UI). Pure, so it is
 * unit-tested (tests/handoff.test.ts) and used by components/Handoff.tsx.
 */

export type HandoffTarget = 'claude' | 'chatgpt' | 'gemini' | 'copy';

/** Prompts up to this many characters are prefilled into the chat's URL. */
export const PREFILL_MAX = 6000;

/** Where to send the prompt, and whether it must be copied (no prefill possible). */
export function handoffDestination(target: HandoffTarget, prompt: string): { url: string | null; copy: boolean } {
  const fits = prompt.length <= PREFILL_MAX;
  const q = encodeURIComponent(prompt);
  switch (target) {
    case 'claude':
      return fits ? { url: `https://claude.ai/new?q=${q}`, copy: false } : { url: 'https://claude.ai/new', copy: true };
    case 'chatgpt':
      return fits ? { url: `https://chatgpt.com/?q=${q}`, copy: false } : { url: 'https://chatgpt.com/', copy: true };
    case 'gemini':
      // Gemini has no prefill link.
      return { url: 'https://gemini.google.com/app', copy: true };
    default:
      return { url: null, copy: true };
  }
}


/** What an AI request carries in `aiHandoff` (EXTERNAL_AI_CONTRACT.md §1). */
export type AiHandoffRequest =
  | { mode: 'prompt'; pupilConsent?: boolean }
  | { mode: 'import'; text: string };
