import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import {
  decide, depthAt as coreDepthAt, scopeFor as coreScopeFor,
  type AccessSnapshot, type Depth, type Target,
} from '../vendor/nga-access';

/**
 * Access control v2 on the client: the same decisions the API makes, over the
 * same MIS snapshot (`GET /api/access/me`).
 *
 * NOT USED BY ANY SCREEN YET — the UI still gates on `usePermissions()`. This
 * exists so screens can move over one at a time once the API runs with
 * ACCESS_V2_MODE=enforce. Like `usePermissions`, it is UX only: the server is
 * the security boundary.
 *
 * While loading, or when MIS has no snapshot, every check is false (fail closed).
 */
export function useAccess() {
  const [snapshot, setSnapshot] = useState<AccessSnapshot | null>(null);
  const [mode, setMode] = useState<'off' | 'shadow' | 'enforce' | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ mode: 'off' | 'shadow' | 'enforce'; snapshot: AccessSnapshot }>('/api/access/me');
      setSnapshot(res.data?.snapshot ?? null);
      setMode(res.data?.mode ?? null);
    } catch {
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const can = useCallback(
    (cap: string, target?: Target | null, minDepth?: Depth | null) => decide(snapshot, cap, target ?? {}, minDepth ?? null).allowed,
    [snapshot],
  );
  const depthAt = useCallback((cap: string, target?: Target | null) => coreDepthAt(snapshot, cap, target ?? {}), [snapshot]);
  const scopeFor = useCallback((cap: string, minDepth?: Depth | null) => coreScopeFor(snapshot, cap, minDepth ?? null), [snapshot]);

  return { snapshot, mode, loading, can, depthAt, scopeFor, reload: load };
}
