import { getPool } from '@tupo/db';
import type { Decision, Target } from '../vendor/nga-access/index.js';

/**
 * Shadow-mode bookkeeping: count every place where the local RBAC and the v2
 * snapshot disagree, in `access_shadow_diffs` (migration 0028).
 *
 * Never throws, never slows a response (callers do not await it on the request
 * path), and is throttled per key so a hot route writes at most once a minute
 * per disagreement. If the table is missing (migration not yet applied) it
 * goes quiet for five minutes instead of logging on every request.
 */

export interface ShadowDiff {
  userId: string;
  misUserId?: string | null;
  capability: string;
  route: string;
  legacyAllowed: boolean;
  v2: Pick<Decision, 'allowed' | 'depth'>;
  target?: Target | Record<string, unknown> | null;
}

const THROTTLE_MS = 60_000;
const recent = new Map<string, number>();
let tableMissingUntil = 0;

export async function recordShadowDiff(d: ShadowDiff): Promise<void> {
  if (Date.now() < tableMissingUntil) return;
  const key = `${d.userId}|${d.capability}|${d.route}|${d.legacyAllowed}|${d.v2.allowed}`;
  const last = recent.get(key) ?? 0;
  if (Date.now() - last < THROTTLE_MS) return;
  recent.set(key, Date.now());
  if (recent.size > 5000) recent.clear();
  try {
    await getPool().query(
      `INSERT INTO access_shadow_diffs
         (user_id, mis_user_id, capability, route, legacy_allowed, v2_allowed, v2_depth, sample_target)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, capability, route, legacy_allowed, v2_allowed)
       DO UPDATE SET hits = access_shadow_diffs.hits + 1, last_seen = now(),
                     v2_depth = EXCLUDED.v2_depth`,
      [d.userId, d.misUserId ?? null, d.capability.slice(0, 200), d.route.slice(0, 200),
       d.legacyAllowed, d.v2.allowed, d.v2.depth ?? null,
       d.target ? JSON.stringify(d.target).slice(0, 2000) : null],
    );
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === '42P01') { tableMissingUntil = Date.now() + 5 * 60_000; return; }
    console.warn('[access] shadow diff not recorded:', (err as Error)?.message ?? err);
  }
}

/** Tests only. */
export function __resetShadowThrottle(): void {
  recent.clear();
  tableMissingUntil = 0;
}

/** "GET /api/chat/directory" — the route pattern, not the concrete URL. */
export function routeOf(req: { method?: string; baseUrl?: string; route?: { path?: string }; path?: string }): string {
  return `${req.method ?? ''} ${(req.baseUrl ?? '') + (req.route?.path ?? req.path ?? '')}`.slice(0, 200);
}
