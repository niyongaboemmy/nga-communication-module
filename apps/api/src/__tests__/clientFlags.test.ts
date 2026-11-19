import { describe, it, expect } from 'vitest';
import { flagsFor, parseFlagRules } from '../clientFlags.js';

describe('client flags (chat experience plan 0.6)', () => {
  it('turns every known flag on when nothing is configured', () => {
    expect(flagsFor('student', '')).toEqual(['chat.inlineReplies', 'chat.threadPage', 'chat.actionSheet']);
  });

  it('honours off, all and role lists', () => {
    const raw = 'chat.inlineReplies=staff|admin, chat.threadPage=off, chat.actionSheet=all';
    expect(flagsFor('staff', raw)).toEqual(['chat.inlineReplies', 'chat.actionSheet']);
    expect(flagsFor('student', raw)).toEqual(['chat.actionSheet']);
    expect(flagsFor('ADMIN', raw)).toEqual(['chat.inlineReplies', 'chat.actionSheet']);
  });

  it('ignores unknown names so a typo cannot invent a flag', () => {
    expect([...parseFlagRules('chat.inlineReplys=off,bogus=all').keys()]).toEqual([]);
  });
});
