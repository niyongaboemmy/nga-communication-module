import type express from 'express';
import jwt from 'jsonwebtoken';
import { fail } from '@tupo/shared';
import {
  gateTenant, legacyDefaultTid, runWithTenant, tidFromClaims, type TenantClaims, type TenantCtx,
} from '@tupo/tenancy';
import { getPool } from '@tupo/db';
import { config } from './config.js';

/**
 * The files service's tenant entry point (contract §6). Every credential it
 * accepts -- the session JWT in the header, or a media ticket in `?t=` --
 * names a school; the request runs inside it, so RLS bounds every file row
 * it can see. Requests with no credential (health) run with none.
 */
export async function tenantFromCredential(req: express.Request, res: express.Response, next: express.NextFunction) {
  type Claims = TenantClaims & { misToken?: string };
  let claims: Claims | null = null as Claims | null;
  const header = req.headers.authorization;
  try {
    if (header?.startsWith('Bearer ')) claims = jwt.verify(header.slice(7), config.jwtSecret) as unknown as Claims;
    else if (typeof req.query.t === 'string') claims = jwt.verify(req.query.t, config.jwtSecret, { audience: "file" }) as unknown as Claims;
  } catch {
    // An invalid credential is the route's own 401 to give.
    return next();
  }
  if (!claims) return next();
  const tid = tidFromClaims(claims, legacyDefaultTid());
  if (claims.misToken) {
    const mis = jwt.decode(claims.misToken);
    const misTid = tidFromClaims(mis && typeof mis === 'object' ? (mis as TenantClaims) : null, legacyDefaultTid());
    if (misTid !== null && misTid !== tid) {
      return res.status(401).json({ ...fail('Your NGA session belongs to another school. Please sign in again.'), code: 'TENANT_MISMATCH' });
    }
  }
  const gate = await gateTenant(tid);
  if (!gate.ok) return res.status(gate.status).json({ ...fail(gate.message), code: gate.code });
  runWithTenant(gate.tenant, () => next());
}

/** `t<tid>/…`: new uploads are namespaced by school (TP-8). Old keys stay as stored. */
export function tenantStorageKey(tid: number, rest: string): string {
  return `t${tid}/${rest}`;
}

/**
 * The school's storage allowance in bytes, or null for none. Per package
 * (`TENANT_QUOTA_BYTES_<PKG>`, e.g. TENANT_QUOTA_BYTES_STARTER) or one value
 * for every tenant (`TENANT_QUOTA_BYTES`). Unset: no tenant-wide limit.
 */
export function tenantQuotaBytes(tenant: TenantCtx, env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[`TENANT_QUOTA_BYTES_${tenant.pkg.toUpperCase()}`] ?? env.TENANT_QUOTA_BYTES;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : null;
}

/** Would `size` more bytes take the current tenant over its allowance? (RLS: this school's files only.) */
export async function overTenantQuota(tenant: TenantCtx, size: number): Promise<boolean> {
  const quota = tenantQuotaBytes(tenant);
  if (quota === null) return false;
  const { rows } = await getPool().query<{ bytes: string }>(
    `SELECT COALESCE(sum(size_bytes), 0)::text AS bytes FROM files
      WHERE deleted_at IS NULL AND status IN ('ready', 'pending')`);
  return Number(rows[0]?.bytes ?? 0) + size > quota;
}
