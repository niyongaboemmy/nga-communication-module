import { describe, it, expect } from 'vitest';
import { resolveMisRole, roleFromPermissions } from '../roles.js';

describe('roleFromPermissions', () => {
  it('gives admin precedence over teaching permissions', () => {
    expect(roleFromPermissions(['MANAGE_USERS', 'MARK_ATTENDANCE', 'VIEW_RESULTS'])).toBe('admin');
  });

  it('treats attendance/lesson permissions as staff', () => {
    expect(roleFromPermissions(['MARK_ATTENDANCE', 'VIEW_RESULTS'])).toBe('staff');
  });

  it('treats read-only self-service as student', () => {
    expect(roleFromPermissions(['VIEW_RESULTS', 'VIEW_ATTENDANCE'])).toBe('student');
  });

  it('returns unassigned rather than guessing', () => {
    expect(roleFromPermissions([])).toBe('unassigned');
    expect(roleFromPermissions(undefined)).toBe('unassigned');
    expect(roleFromPermissions('not-an-array')).toBe('unassigned');
  });
});

describe('resolveMisRole', () => {
  it('falls back to an explicit role field when permissions say nothing', () => {
    expect(resolveMisRole({ role: 'Teacher' }, [])).toBe('staff');
    expect(resolveMisRole({ user_type: 'parent' }, [])).toBe('parent');
  });

  it('prefers permissions over the role field', () => {
    expect(resolveMisRole({ role: 'student' }, ['MANAGE_SYSTEM'])).toBe('admin');
  });
});
