import { describe, it, expect, afterEach } from 'vitest';
import { runWithTenant, type TenantCtx } from '@tupo/tenancy';
import { internalReadHeaders } from '../outbound.js';

const T2: TenantCtx = { tid: 2, slug: 'two', name: 'Two', status: 'ACTIVE', isPrimary: false, timezone: 'Africa/Kigali', pkg: 'starter' };

afterEach(() => { delete process.env.TENANCY_MODE; });

describe('TP-ISO-5 the attachment read names the school', () => {
  it('sends the current tenant as x-tenant-id with the secret', () => {
    expect(runWithTenant(T2, () => internalReadHeaders('s3cret'))).toEqual({ 'x-internal-secret': 's3cret', 'x-tenant-id': '2' });
  });
  it('refuses to guess a school in enforce mode (the attachment is then reported unavailable)', () => {
    process.env.TENANCY_MODE = 'enforce';
    expect(() => internalReadHeaders('s3cret')).toThrow();
  });
});
