import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { conversationRoom, feedAudienceRoom, userRoom } from '@tupo/shared';
import {
  TenantContextMissing, TenantRegistry, createMisTenantRegistry, currentDbScope, effectiveTid, gateTenant,
  jobTid, legacyDefaultTid, primaryTenantCtx, runAsPlatform, runJobInTenant, runWithTenant, runWithoutTenant,
  setTenantRegistry, tenantHeaders, withJobTenant, currentTid, JobTenantMismatch, type TenantCtx,
} from '../index.js';

const T7: TenantCtx = { tid: 7, slug: 'seven', name: 'Seven', status: 'ACTIVE', isPrimary: false, timezone: 'Africa/Kigali', pkg: 'gold' };

afterEach(() => {
  delete process.env.TENANCY_MODE;
  delete process.env.TENANCY_LEGACY_DEFAULT_TID;
  setTenantRegistry(null);
});

describe('vendored core', () => {
  it('is an unedited copy of nga_central_mis/packages/tenancy (sha256 in its header)', () => {
    const text = readFileSync(new URL('../vendor/nga-tenancy/index.ts', import.meta.url), 'utf8');
    const lines = text.split('\n');
    const sha = /sha256:([0-9a-f]{64})/.exec(lines[2] ?? '')?.[1];
    const body = lines.slice(3).join('\n');
    expect(createHash('sha256').update(body).digest('hex')).toBe(sha);
  });
});

describe('modes', () => {
  it('shadow: no context is tenant 1; enforce: it throws', () => {
    expect(effectiveTid()).toBe(1);
    process.env.TENANCY_MODE = 'enforce';
    expect(() => effectiveTid()).toThrow(TenantContextMissing);
    expect(runWithTenant(T7, () => effectiveTid())).toBe(7);
  });

  it('legacy default: tenant 1 unless set to none', () => {
    expect(legacyDefaultTid()).toBe(1);
    process.env.TENANCY_LEGACY_DEFAULT_TID = 'none';
    expect(legacyDefaultTid()).toBeNull();
  });
});

describe('database scope', () => {
  it('follows the innermost of tenant / platform / none', () => {
    expect(runWithTenant(T7, () => currentDbScope())).toEqual({ kind: 'tenant', tid: 7 });
    expect(runWithTenant(T7, () => runAsPlatform('x', () => currentDbScope().kind))).toBe('platform');
    expect(runAsPlatform('x', () => runWithTenant(T7, () => currentDbScope()))).toEqual({ kind: 'tenant', tid: 7 });
    expect(runWithoutTenant('x', () => currentDbScope().kind)).toBe('none');
    process.env.TENANCY_MODE = 'enforce';
    expect(() => currentDbScope()).toThrow(TenantContextMissing);
    expect(runAsPlatform('x', () => currentDbScope().kind)).toBe('platform');
  });
});

describe('rooms carry the tenant (contract §8)', () => {
  it('prefixes every room helper with t<tid>:', () => {
    runWithTenant(T7, () => {
      expect(userRoom('42')).toBe('t7:user:42');
      expect(conversationRoom('9')).toBe('t7:conv:9');
      expect(feedAudienceRoom('everyone')).toBe('t7:feedaudience:everyone');
    });
    expect(userRoom('42', 3)).toBe('t3:user:42');
    expect(userRoom('42')).toBe('t1:user:42'); // shadow default
  });
});

describe('gates (contract §6)', () => {
  const reg = (list: TenantCtx[]) => ({ get: async (tid: number) => list.find((t) => t.tid === tid) ?? null });
  it('maps unknown / pending / suspended / archived / grace', async () => {
    expect(await gateTenant(null, reg([]))).toMatchObject({ ok: false, code: 'TENANT_REQUIRED', status: 401 });
    expect(await gateTenant(9, reg([]))).toMatchObject({ ok: false, code: 'TENANT_UNKNOWN', status: 401 });
    expect(await gateTenant(7, reg([{ ...T7, status: 'PENDING' }]))).toMatchObject({ code: 'TENANT_PENDING', status: 403 });
    expect(await gateTenant(7, reg([{ ...T7, status: 'SUSPENDED' }]))).toMatchObject({ code: 'TENANT_SUSPENDED' });
    expect(await gateTenant(7, reg([{ ...T7, status: 'ARCHIVED' }]))).toMatchObject({ code: 'TENANT_SUSPENDED' });
    expect(await gateTenant(7, reg([{ ...T7, status: 'GRACE' }]))).toMatchObject({ ok: true });
  });
  it('keeps tenant 1 usable when the registry cannot load', async () => {
    const broken = { get: async () => { throw new Error('down'); } };
    expect(await gateTenant(1, broken)).toMatchObject({ ok: true });
    expect(await gateTenant(7, broken)).toMatchObject({ ok: false, code: 'TENANT_UNKNOWN' });
  });
});

describe('registry (contract §4)', () => {
  it('reads MIS, falls back to the local table, then to the primary tenant', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ tenants: [{ tenant_id: 7, slug: 'seven', status: 'active' }] })));
    const r = createMisTenantRegistry({ misBaseUrl: 'http://mis', clientId: 'tupo', clientSecret: 's', fetchImpl: fetchImpl as never });
    expect((await r.list()).map((t) => t.tid)).toEqual([1, 7]);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(String((init.headers as Record<string, string>).Authorization)).toMatch(/^Basic /);

    const down = vi.fn(async () => new Response('nope', { status: 404 }));
    const local = createMisTenantRegistry({ misBaseUrl: 'http://mis', fetchImpl: down as never, localLoad: async () => [primaryTenantCtx(), T7] });
    expect((await local.list()).map((t) => t.tid)).toEqual([1, 7]);
    const bare = createMisTenantRegistry({ misBaseUrl: 'http://mis', fetchImpl: down as never });
    expect((await bare.list()).map((t) => t.tid)).toEqual([1]);
  });
});

describe('service calls and jobs', () => {
  it('stamps X-NGA-Tenant and job payloads with the current tenant', () => {
    expect(runWithTenant(T7, () => tenantHeaders())).toEqual({ 'X-NGA-Tenant': '7' });
    expect(runWithTenant(T7, () => withJobTenant({ postId: 'p' }))).toEqual({ postId: 'p', tid: 7 });
    // The payload never picks the tenant: a matching tid is kept, any other is refused.
    expect(runWithTenant(T7, () => withJobTenant({ tid: 7 }))).toEqual({ tid: 7 });
    expect(() => runWithTenant(T7, () => withJobTenant({ tid: 3 }))).toThrow(JobTenantMismatch);
    expect(() => runWithTenant(T7, () => withJobTenant({ tid: 'abc' }))).toThrow(JobTenantMismatch);
    expect(() => withJobTenant({ tid: 3 })).toThrow(JobTenantMismatch); // shadow: no context = tenant 1
    expect(withJobTenant({ postId: 'q' })).toEqual({ postId: 'q', tid: 1 });
    process.env.TENANCY_MODE = 'enforce';
    expect(() => withJobTenant({ postId: 'q' })).toThrow(TenantContextMissing);
    delete process.env.TENANCY_MODE;
  });
  it('re-enters the tenant a job carries', async () => {
    setTenantRegistry(new TenantRegistry({ load: async () => [primaryTenantCtx(), T7] }));
    expect(await runJobInTenant({ tid: 7 }, async () => currentTid())).toBe(7);
    expect(jobTid({})).toBe(1);
    process.env.TENANCY_MODE = 'enforce';
    expect(() => jobTid({})).toThrow(TenantContextMissing);
  });
});
