import { describe, it, expect } from 'vitest';
import { resolveStatus, toChoice } from '../presence.js';

describe('resolveStatus — one status from every tab, meeting and pick (F-10)', () => {
  const on = ['online'] as const;
  it('no tabs is offline, whatever was picked', () => {
    expect(resolveStatus({ choice: 'busy', inMeeting: false, activities: [] })).toBe('offline');
  });
  it('one active tab beside an idle one is online, not away', () => {
    expect(resolveStatus({ choice: 'auto', inMeeting: false, activities: ['away', 'online'] })).toBe('online');
  });
  it('away only when every tab is idle', () => {
    expect(resolveStatus({ choice: 'auto', inMeeting: false, activities: ['away', 'away'] })).toBe('away');
  });
  it('a meeting shows as in a meeting, over busy', () => {
    expect(resolveStatus({ choice: 'auto', inMeeting: true, activities: [...on] })).toBe('in-a-meeting');
    expect(resolveStatus({ choice: 'busy', inMeeting: true, activities: [...on] })).toBe('in-a-meeting');
  });
  it('busy holds while idle; do not disturb wins over a meeting', () => {
    expect(resolveStatus({ choice: 'busy', inMeeting: false, activities: ['away'] })).toBe('busy');
    expect(resolveStatus({ choice: 'dnd', inMeeting: true, activities: [...on] })).toBe('dnd');
  });
  it('appear offline reads as offline to everyone', () => {
    expect(resolveStatus({ choice: 'invisible', inMeeting: true, activities: [...on] })).toBe('offline');
  });
  it('an unknown pick falls back to automatic', () => {
    expect(toChoice('napping')).toBe('auto');
    expect(toChoice('dnd')).toBe('dnd');
  });
});
