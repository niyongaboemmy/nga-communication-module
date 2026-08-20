import { useAuth } from '../context/AuthContext';

/**
 * Gate UI on Tupo's own RBAC permission keys.
 *
 * The backend is always the authoritative enforcer (see
 * apps/api/src/middleware/authorize.ts) — this hook is UX polish, not the
 * security boundary. Hiding a button here never substitutes for the 403.
 */
export function usePermissions() {
  const { rolePermissions, roleName } = useAuth();
  const set = new Set(rolePermissions);

  /** True if the user holds ANY of the given keys. */
  const can = (key: string | string[]): boolean =>
    (Array.isArray(key) ? key : [key]).some((k) => set.has(k));

  /** True if the user holds ALL of the given keys. */
  const canAll = (keys: string[]): boolean => keys.every((k) => set.has(k));

  return { can, canAll, permissions: rolePermissions, roleName, hasRole: rolePermissions.length > 0 };
}
