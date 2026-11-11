import jwt from 'jsonwebtoken';
import type { Socket } from 'socket.io';
import { roomTenant } from '@tupo/shared';
import {
  PRIMARY_TENANT_ID, belongsToTenant, gateTenant, legacyDefaultTid, parseTid, runWithTenant,
  tidFromClaims, type TenantClaims, type TenantCtx, type TenantRegistry,
} from '@tupo/tenancy';

/**
 * The gateway's side of multi-tenancy (contract §6 and §8).
 *
 *  - The handshake resolves the session's tenant exactly as the API does
 *    (status gates, MIS-token mismatch) and stores it on `socket.data.tenant`.
 *  - Every listener and per-event middleware of the socket runs inside that
 *    tenant (bindSocketTenant), so database reads, room names
 *    (`t<tid>:conv:<id>`) and caches downstream see it without threading it.
 *  - Relay messages from the API/worker carry `tid`; the subscriber delivers
 *    only into that tenant's rooms (relayRooms).
 */

export type HandshakeTenant =
  | { ok: true; tenant: TenantCtx }
  | { ok: false; message: string };

export async function tenantForSession(
  claims: TenantClaims & { misToken?: string },
  registry?: Pick<TenantRegistry, 'get'>,
): Promise<HandshakeTenant> {
  const tid = tidFromClaims(claims, legacyDefaultTid());
  if (claims.misToken) {
    const mis = jwt.decode(claims.misToken);
    const misTid = tidFromClaims(mis && typeof mis === 'object' ? (mis as TenantClaims) : null, legacyDefaultTid());
    if (misTid !== null && misTid !== tid) return { ok: false, message: 'unauthorized: TENANT_MISMATCH' };
  }
  const gate = await gateTenant(tid, registry);
  if (!gate.ok) return { ok: false, message: `${gate.status === 401 ? 'unauthorized' : 'forbidden'}: ${gate.code}` };
  return { ok: true, tenant: gate.tenant };
}

const BOUND = Symbol.for('tupo.socketTenant');

/**
 * Run every listener (including reserved ones such as `disconnect`, which
 * bypass `socket.use`) and every per-event middleware of this socket inside
 * its tenant. Call before any handler is registered, and before hardenSocket.
 */
export function bindSocketTenant<S extends Socket>(socket: S, tenant: TenantCtx): S {
  const s = socket as unknown as Record<PropertyKey, unknown> & {
    on: (ev: string, fn: (...a: unknown[]) => unknown) => unknown;
    once: (ev: string, fn: (...a: unknown[]) => unknown) => unknown;
    use: (fn: (packet: unknown, next: (err?: Error) => void) => void) => unknown;
  };
  if (s[BOUND]) return socket;
  s[BOUND] = tenant;
  const on = s.on.bind(socket);
  const once = s.once.bind(socket);
  const use = s.use.bind(socket);
  s.on = (ev, fn) => on(ev, (...args: unknown[]) => runWithTenant(tenant, () => fn(...args)));
  s.once = (ev, fn) => once(ev, (...args: unknown[]) => runWithTenant(tenant, () => fn(...args)));
  s.use = (fn) => use((packet, next) => runWithTenant(tenant, () => fn(packet, next)));
  return socket;
}

/** The tenant a socket was admitted for (tenant 1 for one admitted before tenancy). */
export function socketTid(socket: { data: Record<string, unknown> }): number {
  return (socket.data.tenant as TenantCtx | undefined)?.tid ?? PRIMARY_TENANT_ID;
}

/** The tenant a relay message is for: its `tid`, or tenant 1 from a publisher older than tenancy. */
export function relayTid(message: unknown): number {
  return parseTid((message as { tid?: unknown } | null)?.tid) ?? PRIMARY_TENANT_ID;
}

/**
 * The rooms a relay message may reach: bare names (an old publisher) are
 * read as the message's tenant; a room of any other tenant is dropped.
 */
export function relayRooms(rooms: unknown, tid: number): string[] {
  if (!Array.isArray(rooms)) return [];
  return rooms
    .filter((r): r is string => typeof r === 'string' && r.length > 0)
    .map((r) => (roomTenant(r) === null ? `t${tid}:${r}` : r))
    .filter((r) => belongsToTenant(r, tid));
}
