import { describe, it, expect, afterEach } from 'vitest';
import {
  TenantRegistry, currentDbScope, currentTid, primaryTenantCtx, type TenantCtx,
} from '@tupo/tenancy';
import { dispatchTenantJob } from '../tenantJobs.js';

const tenant = (tid: number, status: TenantCtx['status'] = 'ACTIVE'): TenantCtx =>
  ({ ...primaryTenantCtx(), tid, slug: `t${tid}`, isPrimary: tid === 1, status });
const registry = new TenantRegistry({
  load: async () => [tenant(1), tenant(2), tenant(3, 'SUSPENDED'), tenant(4, 'GRACE'), tenant(5, 'PENDING')],
});

function fakeQueue() {
  const added: Array<{ name: string; data: Record<string, unknown> }> = [];
  return { added, add: async (name: string, data: unknown) => { added.push({ name, data: data as Record<string, unknown> }); } };
}

afterEach(() => { delete process.env.TENANCY_MODE; });

describe('worker jobs and tenants', () => {
  it('fans a repeatable sweep out to one child per schedulable tenant', async () => {
    const queue = fakeQueue();
    let ran = 0;
    const out = await dispatchTenantJob({ name: 'chat:sweep', data: {}, id: 'r1' }, queue, async () => { ran++; return 'x'; }, registry);
    expect(ran).toBe(0);
    expect(out).toEqual({ fannedOut: 3, tenants: [1, 2, 4] });
    expect(queue.added.map((j) => [j.name, j.data.tid])).toEqual([['chat:sweep', 1], ['chat:sweep', 2], ['chat:sweep', 4]]);
  });

  it('runs each child, and every tenant-carrying job, inside its tenant', async () => {
    const queue = fakeQueue();
    const seen: number[] = [];
    for (const tid of [2, 4]) {
      await dispatchTenantJob({ name: 'chat:sweep', data: { tid } }, queue, async () => { seen.push(currentTid()); }, registry);
    }
    await dispatchTenantJob({ name: 'feed:announce', data: { postId: 'p', tid: 2 } }, queue, async () => { seen.push(currentTid()); }, registry);
    expect(seen).toEqual([2, 4, 2]);
    expect(queue.added).toEqual([]);
  });

  it('runs global jobs with no tenant, and refuses an untagged job in enforce mode', async () => {
    const queue = fakeQueue();
    expect(await dispatchTenantJob({ name: 'partitions:ensure', data: {} }, queue, async () => currentDbScope().kind, registry)).toBe('none');
    process.env.TENANCY_MODE = 'enforce';
    await expect(dispatchTenantJob({ name: 'mail:send', data: { messageId: 'm' } }, queue, async () => 1, registry))
      .rejects.toThrow(/No tenant context/);
  });
});
