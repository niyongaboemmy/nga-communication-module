/**
 * Tenant-scoped Socket.IO room names (multi-tenancy contract §8:
 * `tenantRoom(name)` -> `t<tid>:<name>`).
 *
 * This module is shared with the browser bundle, so it cannot reach the
 * Node-only tenant context itself. The server processes install a resolver
 * once (@tupo/tenancy does it on import); every room helper in this package
 * then prefixes the current tenant. Without a resolver (the web bundle, a
 * unit test that never loads @tupo/tenancy) names are left bare.
 */
let resolveTid: (() => number) | null = null;

export function setRoomTenantResolver(fn: (() => number) | null): void {
  resolveTid = fn;
}

/** `t<tid>:<name>`; an explicit `tid` wins over the ambient tenant. */
export function scopedRoom(name: string, tid?: number): string {
  const t = tid ?? (resolveTid ? resolveTid() : null);
  return t == null ? name : `t${t}:${name}`;
}

/** The tenant a scoped room belongs to, or null for a bare name. */
export function roomTenant(room: string): number | null {
  const m = /^t(\d+):/.exec(room);
  return m ? Number(m[1]) : null;
}
