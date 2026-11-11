import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { seedTenant } from '@tupo/db';
import { normalizeTenant, parseTid, tenantRegistry } from '@tupo/tenancy';

/**
 * Tenant lifecycle calls from the MIS control plane (contract §4/§5).
 * Authenticated by the shared provisioning secret, never by a session.
 *
 *   POST /api/integration/tenants/:tid/provision  body: TenantCtx
 *     -> { ok: true, tid, created }   (idempotent; seedTenant)
 *   POST /api/integration/tenants/changed         body: { tid }
 *     -> { ok: true }                  (drops the cached registry)
 */
const router = Router();

function secretOk(req: Request): boolean | null {
  const secret = process.env.TENANCY_PROVISION_SECRET;
  if (!secret) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  // Hash both sides so the comparison is constant-time whatever the lengths.
  const want = createHash('sha256').update(secret).digest();
  const got = createHash('sha256').update(match?.[1] ?? '').digest();
  return match !== null && timingSafeEqual(want, got);
}

function provisionAuth(req: Request, res: Response, next: NextFunction) {
  const ok = secretOk(req);
  if (ok === null) return res.status(503).json({ ok: false, code: 'PROVISIONING_DISABLED', message: 'TENANCY_PROVISION_SECRET is not set.' });
  if (!ok) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Invalid provisioning credentials.' });
  next();
}

router.use(provisionAuth);

router.post('/changed', (req: Request, res: Response) => {
  tenantRegistry().invalidate();
  res.json({ ok: true, tid: parseTid((req.body ?? {}).tid) });
});

router.post('/:tid/provision', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tid = parseTid(req.params.tid);
    if (!tid) return res.status(400).json({ ok: false, code: 'BAD_TENANT', message: 'tid must be a positive integer.' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const bodyTid = body.tid ?? body.tenant_id;
    if (bodyTid !== undefined && parseTid(bodyTid) !== tid) {
      return res.status(400).json({ ok: false, code: 'TENANT_MISMATCH', message: 'Body tid differs from the path.' });
    }
    const tenant = normalizeTenant({ ...body, tid });
    if (!tenant) return res.status(400).json({ ok: false, code: 'BAD_TENANT', message: 'Invalid tenant.' });
    const result = await seedTenant(tenant);
    tenantRegistry().invalidate();
    res.json({ ok: true, tid, created: result.created });
  } catch (err) {
    next(err);
  }
});

export default router;
