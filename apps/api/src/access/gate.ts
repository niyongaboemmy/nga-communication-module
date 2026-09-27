import { decide, type AccessSnapshot, type Decision, type Depth, type Target } from '../vendor/nga-access/index.js';
import { accessMode, type AccessMode } from './mode.js';
import { getAccessSnapshot, type SnapshotStatus } from './snapshot.js';
import { recordShadowDiff, routeOf } from './shadow.js';

/**
 * The bridge between Tupo's request handling and the v2 decision core.
 *
 * Legacy Tupo permissions are global ("the role holds DM_START"), so the v2
 * question asked in their place is "does the user hold this capability
 * anywhere" — decide() with an empty target. Scoped questions (dashboard,
 * contacts, oversight) are asked explicitly by their own modules.
 */

export interface RequestAccess {
  mode: AccessMode;
  snapshot: AccessSnapshot | null;
  status: SnapshotStatus;
  /** The local RBAC permission set, kept even when v2 is enforcing. */
  legacyPermissions: Set<string>;
}

interface AccessUser {
  id: string;
  misUserId?: string;
  misToken?: string;
  permissions: Set<string>;
  access?: RequestAccess;
}

/** Any-of (or all-of) over several capabilities, held anywhere. */
export function decideHeld(
  snapshot: AccessSnapshot | null | undefined, keys: string[], mode: 'any' | 'all' = 'any',
  minDepth?: Depth | null,
): Decision {
  const ds = keys.map((k) => decide(snapshot, k, {}, minDepth ?? null));
  const allowed = mode === 'all' ? ds.length > 0 && ds.every((d) => d.allowed) : ds.some((d) => d.allowed);
  const best = ds.find((d) => d.allowed) ?? ds[0] ?? { allowed: false, depth: null, via: [] };
  return { allowed, depth: allowed ? best.depth : null, via: allowed ? best.via : [] };
}

/** Every capability key the snapshot grants anywhere, at any depth. */
export function heldKeys(snapshot: AccessSnapshot | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const [k, entries] of Object.entries(snapshot?.caps ?? {})) {
    if (Array.isArray(entries) && entries.length > 0) out.add(k);
  }
  return out;
}

/**
 * Called by authMiddleware once the legacy permission set is resolved.
 *
 *   off / shadow  req.user.permissions stays the local RBAC set (unchanged).
 *   enforce       the snapshot is loaded (cache first) and req.user.permissions
 *                 is REPLACED by the capabilities it holds anywhere, so every
 *                 authorizePermission(...) and inline `permissions.has(...)`
 *                 check becomes a v2 decision. Snapshot unavailable (MIS down
 *                 beyond the 24 h last-good window, or token rejected) → an
 *                 empty set: fail closed.
 */
export async function attachAccess(user: AccessUser): Promise<void> {
  const mode = accessMode();
  const legacy = user.permissions;
  if (mode !== 'enforce') {
    user.access = { mode, snapshot: null, status: 'unavailable', legacyPermissions: legacy };
    return;
  }
  const { snapshot, status } = await getAccessSnapshot({
    misUserId: user.misUserId ?? '', misToken: user.misToken,
  });
  user.access = { mode, snapshot, status, legacyPermissions: legacy };
  user.permissions = heldKeys(snapshot);
}

/** True when enforcement could not obtain any snapshot for this request. */
export const accessUnavailable = (user: AccessUser | undefined): boolean =>
  !!user?.access && user.access.mode === 'enforce' && !user.access.snapshot;

/**
 * Shadow comparison for a global permission check. Fire-and-forget: the caller
 * has already answered with the legacy decision. Skips silently when MIS has
 * no snapshot for the user.
 */
export function shadowCompareHeld(
  req: unknown, keys: string[], mode: 'any' | 'all', legacyAllowed: boolean, label?: string,
): void {
  if (accessMode() !== 'shadow') return;
  const user = (req as { user?: AccessUser }).user;
  if (!user?.misUserId) return;
  // Resolved now: by the time the comparison runs the request has moved on.
  const route = label ?? routeOf(req as never);
  void (async () => {
    try {
      const { snapshot } = await getAccessSnapshot({ misUserId: user.misUserId!, misToken: user.misToken });
      if (!snapshot) return;
      const v2 = decideHeld(snapshot, keys, mode);
      if (v2.allowed === legacyAllowed) return;
      await recordShadowDiff({
        userId: user.id, misUserId: user.misUserId,
        capability: keys.join(mode === 'all' ? '&' : '|'),
        route,
        legacyAllowed, v2,
      });
    } catch { /* never affects the request */ }
  })();
}

/**
 * Inline permission check (`me.permissions.has(key)` sites). Returns what the
 * active mode says — in enforce `permissions` already is the v2 set — and in
 * shadow queues a comparison.
 */
export function hasPermission(req: unknown, key: string): boolean {
  const user = (req as { user?: AccessUser }).user;
  if (!user) return false;
  const allowed = user.permissions.has(key);
  shadowCompareHeld(req, [key], 'any', allowed);
  return allowed;
}

/** Scoped decision against the request's snapshot (enforce), or null if none. */
export function decideForRequest(
  req: unknown, cap: string, target?: Target | null, minDepth?: Depth | null,
): Decision | null {
  const snap = (req as { user?: AccessUser }).user?.access?.snapshot;
  return snap ? decide(snap, cap, target ?? {}, minDepth ?? null) : null;
}
