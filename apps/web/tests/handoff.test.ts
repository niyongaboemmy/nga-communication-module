// Run with `npm test` (node --test; Node >= 23 strips TypeScript natively).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoffDestination, PREFILL_MAX } from '../src/lib/handoff.ts';

test('short prompts are prefilled into Claude and ChatGPT, never copied', () => {
  assert.deepEqual(handoffDestination('claude', 'a b&c'), { url: 'https://claude.ai/new?q=a%20b%26c', copy: false });
  assert.deepEqual(handoffDestination('chatgpt', 'hi'), { url: 'https://chatgpt.com/?q=hi', copy: false });
});

test('long prompts are copied and the site opened without a prefill', () => {
  const long = 'x'.repeat(PREFILL_MAX + 1);
  assert.deepEqual(handoffDestination('claude', long), { url: 'https://claude.ai/new', copy: true });
  assert.deepEqual(handoffDestination('chatgpt', long), { url: 'https://chatgpt.com/', copy: true });
  assert.equal(handoffDestination('claude', 'x'.repeat(PREFILL_MAX)).copy, false);
});

test('Gemini has no prefill (copy + open); Copy opens nothing', () => {
  assert.deepEqual(handoffDestination('gemini', 'hi'), { url: 'https://gemini.google.com/app', copy: true });
  assert.deepEqual(handoffDestination('copy', 'hi'), { url: null, copy: true });
});
