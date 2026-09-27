/**
 * How Tupo uses access control v2 (plan §13, packages/access/README.md §7):
 *
 *   off      only the existing (local RBAC) checks run; v2 is never consulted
 *   shadow   the existing checks decide; v2 decides too and every
 *            disagreement is counted in `access_shadow_diffs`   <- default
 *   enforce  v2 decides
 *
 * Tests run with "off" unless a test sets ACCESS_V2_MODE, so every existing
 * suite behaves exactly as before. Read on every call (not cached) so a test
 * can flip it per case.
 */
export type AccessMode = 'off' | 'shadow' | 'enforce';

export function accessMode(): AccessMode {
  const raw = (process.env.ACCESS_V2_MODE ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'shadow' || raw === 'enforce') return raw;
  const underTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  return underTest ? 'off' : 'shadow';
}
