import { describe, it, expect } from 'vitest';
import { errorFingerprint } from '../observability.js';

/** R-05: one problem is one row, however many ids and numbers it happens with. */
describe('errorFingerprint', () => {
  const stack = (file: string) => `TypeError: x\n    at render (http://localhost:5194/src/pages/chat/${file}.tsx:120:14)\n    at node_modules/react-dom/x.js:1:1`;

  it('groups the same error with different ids, numbers and quoted values', () => {
    const a = errorFingerprint({ source: 'web', message: "Cannot read 'name' of message 1234567890", stack: stack('MessageThread') });
    const b = errorFingerprint({ source: 'web', message: "Cannot read 'title' of message 98765", stack: stack('MessageThread') });
    expect(a).toBe(b);
  });

  it('ignores line and column, so a rebuild does not split a group', () => {
    const a = errorFingerprint({ source: 'api', message: 'boom', stack: 'Error: boom\n    at f (/app/dist/routes/chat.js:10:5)' });
    const b = errorFingerprint({ source: 'api', message: 'boom', stack: 'Error: boom\n    at f (/app/dist/routes/chat.js:99:1)' });
    expect(a).toBe(b);
  });

  it('keeps different places and different services apart', () => {
    const here = errorFingerprint({ source: 'web', message: 'boom', stack: stack('MessageThread') });
    expect(errorFingerprint({ source: 'web', message: 'boom', stack: stack('Composer') })).not.toBe(here);
    expect(errorFingerprint({ source: 'api', message: 'boom', stack: stack('MessageThread') })).not.toBe(here);
  });
});
