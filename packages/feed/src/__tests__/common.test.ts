import { describe, it, expect } from 'vitest';
import {
  visibleAudiences, canTargetAudience, levelsThatSee, effectiveAudience, slugify,
} from '../common.js';

describe('audience rules', () => {
  it('each role sees its own band and everyone; staff see all', () => {
    expect(visibleAudiences('STUDENT')).toEqual(['everyone', 'students']);
    expect(visibleAudiences('PARENT')).toEqual(['everyone', 'parents']);
    expect(visibleAudiences('STAFF')).toContain('parents');
    expect(visibleAudiences(null)).toEqual(['everyone']);
  });

  it('levelsThatSee is the inverse of visibleAudiences', () => {
    expect(levelsThatSee('staff')).toEqual(['STAFF', 'ADMIN']);
    expect(levelsThatSee('students')).toEqual(['STUDENT', 'STAFF', 'ADMIN']);
    expect(levelsThatSee('everyone')).toContain(null);
  });

  it('a page caps the audience of every post on it', () => {
    expect(effectiveAudience('everyone', 'staff')).toBe('staff');
    expect(effectiveAudience('students', 'everyone')).toBe('students');
    expect(effectiveAudience('students', 'students')).toBe('students');
    // Two different restricted bands leave only staff, who see every band.
    expect(effectiveAudience('students', 'parents')).toBe('staff');
  });

  it('students and parents may only address their own band', () => {
    expect(canTargetAudience('STUDENT', 'staff')).toBe(false);
    expect(canTargetAudience('STUDENT', 'students')).toBe(true);
    expect(canTargetAudience('PARENT', 'students')).toBe(false);
    expect(canTargetAudience('STAFF', 'parents')).toBe(true);
  });
});

describe('slugify', () => {
  it('produces a stable, url-safe slug', () => {
    expect(slugify('  École Nyanza — News! ')).toBe('ecole-nyanza-news');
    expect(slugify('***')).toBe('page');
  });
});
