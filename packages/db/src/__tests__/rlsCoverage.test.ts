import { describe, it, expect } from 'vitest';
import { evaluateRlsCoverage, formatRlsCoverage, type PolicyRow, type RelationRow } from '../rlsCoverage.js';

const rel = (relname: string, o: Partial<RelationRow> = {}): RelationRow =>
  ({ relname, partition: false, rls: true, force: true, has_tenant: true, ...o });
const tenantPolicy = (tablename: string, o: Partial<PolicyRow> = {}): PolicyRow => ({
  tablename, policyname: 'tenant_isolation', permissive: 'PERMISSIVE', roles: ['public'], cmd: 'ALL',
  qual: '(tenant_id = tupo_tenant_id())', with_check: '(tenant_id = tupo_tenant_id())', ...o,
});
const platform = (tablename: string): PolicyRow => ({
  tablename, policyname: 'platform_access', permissive: 'PERMISSIVE', roles: ['tupo_platform'], cmd: 'ALL', qual: 'true', with_check: 'true',
});

describe('evaluateRlsCoverage', () => {
  it('passes a fully covered schema and reports next month', () => {
    const r = evaluateRlsCoverage(
      [rel('users'), rel('messages_2026_12', { partition: true }), rel('tenants', { has_tenant: false, rls: false, force: false })],
      [tenantPolicy('users'), platform('users'), tenantPolicy('messages_2026_12')],
      ['messages_2026_12', 'meeting_events_2026_12'],
    );
    expect(r.ok).toBe(true);
    expect(r.covered).toEqual(['messages_2026_12', 'users']);
    expect(formatRlsCoverage(r)).toEqual([
      'RLS check: 2 tables/partitions covered, 0 missing',
      'RLS check: next month messages_2026_12 covered, meeting_events_2026_12 not created yet (partitions:ensure makes it)',
    ]);
  });

  it('flags missing RLS, FORCE, policy and a non-allowlisted global table', () => {
    const r = evaluateRlsCoverage(
      [rel('a', { rls: false }), rel('b', { force: false }), rel('c'), rel('d', { has_tenant: false })],
      [tenantPolicy('a'), tenantPolicy('b')],
    );
    expect(r.ok).toBe(false);
    expect(r.offenders).toEqual([
      'a: row level security not enabled',
      'b: row level security not FORCEd',
      'c: no tenant_isolation policy',
      'd: no tenant_id column and not in the global-table allowlist',
    ]);
  });

  it('flags a tenant_isolation policy that does not use tupo_tenant_id(), or is restricted to a role', () => {
    const r = evaluateRlsCoverage(
      [rel('a'), rel('b'), rel('c')],
      [tenantPolicy('a', { qual: 'true' }), tenantPolicy('b', { with_check: null }), tenantPolicy('c', { roles: ['tupo'] })],
    );
    expect(r.offenders.map((o) => o.split(':')[0])).toEqual(['a', 'b', 'c']);
    expect(r.offenders[0]).toContain('USING does not reference');
    expect(r.offenders[1]).toContain('WITH CHECK does not reference');
    expect(r.offenders[2]).toContain('TO PUBLIC');
  });

  it('flags an extra permissive PUBLIC policy that would OR away the isolation, not the platform one', () => {
    const r = evaluateRlsCoverage([rel('a')], [tenantPolicy('a'), platform('a'),
      { ...platform('a'), policyname: 'open', roles: ['public'] }]);
    expect(r.offenders).toEqual(['a: permissive policy open applies to PUBLIC without tupo_tenant_id()']);
  });

  it('a next-month partition without RLS is NOT covered', () => {
    const r = evaluateRlsCoverage([rel('messages_2026_12', { partition: true, force: false })], [tenantPolicy('messages_2026_12')], ['messages_2026_12']);
    expect(formatRlsCoverage(r)[1]).toBe('RLS check: next month messages_2026_12 NOT covered');
    expect(r.offenders[0]).toBe('messages_2026_12 (partition): row level security not FORCEd');
  });
});
