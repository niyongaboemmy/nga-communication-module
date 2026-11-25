import { describe, it, expect } from 'vitest';
import { presenceForQuery, resolveStatus, toChoice } from '../presence.js';

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

describe('TP-ISO-2 presence:query answers only for people of the asker\'s school', () => {
  // Redis knows everyone, whatever their school: keys are bare user ids.
  const redis = {
    mget: async (keys: string[]) => keys.map((k) => (k.startsWith('presence:') ? 'online' : null)),
    set: async () => 'OK',
  } as unknown as Parameters<typeof presenceForQuery>[0];

  it('leaves out ids the database (RLS) does not show in this school', async () => {
    const asked: string[][] = [];
    const out = await presenceForQuery(redis, ['mine', 'other-school'], {
      visible: async (ids) => new Set(ids.filter((id) => id === 'mine')),
      hidden: async () => new Set(),
      read: async (_r, ids) => { asked.push(ids); return Object.fromEntries(ids.map((id) => [id, { status: 'online' as const, lastSeenAt: null }])); },
    });
    expect(out).toEqual({ mine: { status: 'online', lastSeenAt: null } });
    expect(asked).toEqual([['mine']]);
  });

  it('answers nothing when none of the ids is visible, or the check fails', async () => {
    expect(await presenceForQuery(redis, ['x'], { visible: async () => new Set(), hidden: async () => new Set() })).toEqual({});
    expect(await presenceForQuery(redis, ['x'], { visible: async () => { throw new Error('db down'); }, hidden: async () => new Set() })).toEqual({});
  });

  it('a blocked person in this school still reads as offline', async () => {
    const out = await presenceForQuery(redis, ['a', 'b'], {
      visible: async (ids) => new Set(ids),
      hidden: async () => new Set(['b']),
      read: async (_r, ids) => Object.fromEntries(ids.map((id) => [id, { status: 'online' as const, lastSeenAt: null }])),
    });
    expect(out).toEqual({ a: { status: 'online', lastSeenAt: null }, b: { status: 'offline', lastSeenAt: null } });
  });
});
