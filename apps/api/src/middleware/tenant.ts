import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import { fail } from '@tupo/shared';
import {
  gateTenant, legacyDefaultTid, runAsPlatform, runWithTenant, tidFromClaims,
  type TenantClaims, type TenantCtx, type TenantGate,
} from '@tupo/tenancy';
import { getPool } from '@tupo/db';

/**
 * Request-side tenancy helpers (contract §6). Every authenticated entry point
 * resolves the tenant of the session, applies the status rules and runs the
 * rest of the request inside runWithTenant, so the database pool, room names,
 * caches and MIS calls downstream all see it.
 */

/** The tid a token's claims speak for (legacy tokens: TENANCY_LEGACY_DEFAULT_TID). */
export function tidOf(claims: TenantClaims | null | undefined): number | null {
  return tidFromClaims(claims ?? null, legacyDefaultTid());
}

/** The tid inside a MIS JWT we hold but cannot verify ourselves (MIS verified it). */
export function misTokenTid(misToken: string | undefined | null): number | null {
  if (!misToken) return null;
  const claims = jwt.decode(misToken);
  return tidOf(claims && typeof claims === 'object' ? (claims as TenantClaims) : null);
}

export function sendTenantRefusal(res: Response, gate: Exclude<TenantGate, { ok: true }>) {
  return res.status(gate.status).json({ ...fail(gate.message), code: gate.code });
}

export function sendTenantMismatch(res: Response) {
  return res.status(401).json({
    ...fail('Your NGA session belongs to another school. Please sign in again.'),
    code: 'TENANT_MISMATCH',
  });
}

/**
 * Gate `tid` and run `fn` inside its context, or answer the refusal. Returns
 * whether `fn` ran.
 */
export async function withRequestTenant(
  tid: number | null, res: Response, fn: (tenant: TenantCtx) => unknown,
): Promise<boolean> {
  const gate = await gateTenant(tid);
  if (!gate.ok) {
    sendTenantRefusal(res, gate);
    return false;
  }
  await runWithTenant(gate.tenant, () => fn(gate.tenant));
  return true;
}

/**
 * The tenant that owns a meeting, found without a session (guest links carry
 * only a meeting id or join code). Ids and codes are unique across tenants.
 */
export async function meetingTenant(idOrCode: string): Promise<number | null> {
  const { rows } = await runAsPlatform('guest meeting lookup', () => getPool().query<{ tenant_id: string }>(
    'SELECT tenant_id FROM meetings WHERE id = $1 OR join_code = $1 LIMIT 1', [idOrCode]));
  return rows[0] ? Number(rows[0].tenant_id) : null;
}
