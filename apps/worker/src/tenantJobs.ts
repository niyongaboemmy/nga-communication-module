import {
  parseTid, runJobInTenant, runWithoutTenant, tenantRegistry,
  type TenantCtx, type TenantRegistry,
} from '@tupo/tenancy';

/**
 * How each job meets the tenant model (multi-tenancy Phase 6, TP-6).
 *
 *  - Repeatable sweeps are registered once, with no tenant. When one fires it
 *    fans out: one child job per schedulable tenant (ACTIVE/GRACE, from the
 *    registry: MIS /platform/tenants/active, local `tenants` table as
 *    fallback), each carrying `tid`. A slow or failing school never holds up
 *    the others, and each child retries on its own.
 *  - Every other job carries `tid` from the request that queued it
 *    (withJobTenant) and runs inside that tenant.
 *  - Global jobs touch only tables without tenant rows (partition DDL,
 *    process metrics) and run with no tenant at all.
 */
export const TENANT_SWEEPS = new Set([
  'avatars:sync', 'chat:scheduled-sweep', 'chat:sweep', 'mail:sweep',
  'feed:sweep', 'story:sweep', 'reminders:sync', 'notify:digest',
]);

export const GLOBAL_JOBS = new Set(['heartbeat', 'partitions:ensure', 'monitor:tick', 'monitor:prune']);

export interface JobLike { name: string; data: unknown; id?: string }
export interface QueueLike {
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>;
}

export async function dispatchTenantJob<T>(
  job: JobLike,
  queue: QueueLike,
  run: () => Promise<T>,
  registry: Pick<TenantRegistry, 'list'> = tenantRegistry(),
): Promise<T | { fannedOut: number; tenants: number[] }> {
  if (GLOBAL_JOBS.has(job.name)) return runWithoutTenant(`job ${job.name}`, run);

  const data = (job.data ?? {}) as Record<string, unknown>;
  if (TENANT_SWEEPS.has(job.name) && !parseTid(data.tid)) {
    const tenants: TenantCtx[] = (await registry.list()).filter((t) => t.status === 'ACTIVE' || t.status === 'GRACE');
    for (const t of tenants) {
      await queue.add(job.name, { ...data, tid: t.tid }, {
        // One child per tenant per firing; the parent's id keeps it unique.
        jobId: `${job.name.replace(/:/g, '-')}-t${t.tid}-${job.id ?? Date.now()}`,
        removeOnComplete: 20,
        removeOnFail: 20,
      });
    }
    return { fannedOut: tenants.length, tenants: tenants.map((t) => t.tid) };
  }
  return runJobInTenant(job.data, run);
}
