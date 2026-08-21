/**
 * Every provider SDK throws its own shape. Classification lives here so the
 * adapters and the orchestrator agree on what counts as "out of quota".
 */
export const isQuotaError = (err: unknown): boolean => {
  const e = err as { status?: number; message?: string; error?: { message?: string } };
  if (e?.status === 429 || e?.status === 413) return true;
  const raw = String(e?.message ?? e?.error?.message ?? '');
  return (
    raw.includes('RESOURCE_EXHAUSTED') ||
    raw.includes('429') ||
    raw.includes('413') ||
    /quota/i.test(raw) ||
    /rate.?limit/i.test(raw) ||
    /tokens per minute|tokens per day|TPM|TPD/i.test(raw)
  );
};

const isSafetyBlock = (err: unknown): boolean => {
  const e = err as { message?: string; error?: { message?: string } };
  const raw = String(e?.message ?? e?.error?.message ?? '');
  return raw.includes('SAFETY') || raw.includes('blockReason') || /content.?filter/i.test(raw);
};

export const friendlyAIErrorMessage = (err: unknown): string => {
  if (isQuotaError(err)) return 'The AI is temporarily rate-limited. Please try again in a few minutes.';
  if (isSafetyBlock(err)) return 'The AI declined to generate content for this request.';
  return 'AI generation failed. Please try again.';
};
