import { describe, it, expect } from 'vitest';
import { activeUserSql, inactiveUserSql, isActiveUser, normaliseMisStatus } from '../activeUsers.js';

describe('active user rule', () => {
  it('builds the shared SQL predicate for an alias', () => {
    expect(activeUserSql('u')).toBe("(u.status = 'active' AND COALESCE(u.mis_status, 'ACTIVE') = 'ACTIVE')");
    expect(activeUserSql()).toContain('users.status');
    expect(inactiveUserSql('x')).toBe(`(NOT ${activeUserSql('x')})`);
  });

  it('refuses an alias that is not an identifier', () => {
    expect(() => activeUserSql("u; DROP TABLE users")).toThrow();
  });

  it('treats a never-synced MIS status as active', () => {
    expect(isActiveUser({ status: 'active', mis_status: null })).toBe(true);
    expect(isActiveUser({ status: 'active' })).toBe(true);
    expect(isActiveUser({ status: 'active', mis_status: 'ACTIVE' })).toBe(true);
  });

  it('anything else in MIS, or a local suspension, is inactive', () => {
    for (const s of ['INACTIVE', 'SUSPENDED', 'REMOVED']) {
      expect(isActiveUser({ status: 'active', mis_status: s })).toBe(false);
      expect(isActiveUser({ status: 'active', misStatus: s })).toBe(false);
    }
    expect(isActiveUser({ status: 'suspended', mis_status: 'ACTIVE' })).toBe(false);
  });

  it('normalises MIS status values and ignores missing ones', () => {
    expect(normaliseMisStatus('inactive')).toBe('INACTIVE');
    expect(normaliseMisStatus(' ACTIVE ')).toBe('ACTIVE');
    expect(normaliseMisStatus(undefined)).toBeUndefined();
    expect(normaliseMisStatus(null)).toBeUndefined();
    expect(normaliseMisStatus('')).toBeUndefined();
    expect(normaliseMisStatus(1)).toBeUndefined();
  });
});
