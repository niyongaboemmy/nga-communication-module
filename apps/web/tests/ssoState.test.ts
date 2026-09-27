// Run with `npm test` (node --test; Node >= 23 strips TypeScript natively).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SSO_STATE_KEY,
  SSO_STATE_TTL_MS,
  beginSsoState,
  consumeSsoState,
  generateSsoState,
  type StateStorage,
} from '../src/lib/ssoState.ts';

function memoryStorage(): StateStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

test('generateSsoState returns 32 hex chars and differs per call', () => {
  const a = generateSsoState();
  const b = generateSsoState();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test('matching state is accepted and removed', () => {
  const s = memoryStorage();
  const state = beginSsoState(s, 1000);
  assert.ok(s.data.has(SSO_STATE_KEY));
  assert.deepEqual(consumeSsoState(state, s, 2000), { ok: true, reason: 'match' });
  assert.equal(s.data.has(SSO_STATE_KEY), false);
});

test('present but mismatched state is rejected and removed', () => {
  const s = memoryStorage();
  beginSsoState(s, 1000);
  assert.deepEqual(consumeSsoState('attacker', s, 2000), { ok: false, reason: 'mismatch' });
  assert.equal(s.data.has(SSO_STATE_KEY), false);
});

test('a stored state can only be used once', () => {
  const s = memoryStorage();
  const state = beginSsoState(s, 1000);
  assert.equal(consumeSsoState(state, s, 2000).ok, true);
  assert.deepEqual(consumeSsoState('other', s, 3000), { ok: true, reason: 'no-state-stored' });
});

test('missing returned state is accepted (legacy / launcher flows)', () => {
  const s = memoryStorage();
  beginSsoState(s, 1000);
  assert.deepEqual(consumeSsoState(null, s, 2000), { ok: true, reason: 'no-state-returned' });
  assert.equal(s.data.has(SSO_STATE_KEY), false);
});

test('returned state with nothing stored is accepted (MIS app switcher)', () => {
  assert.deepEqual(consumeSsoState('abc', memoryStorage(), 1), { ok: true, reason: 'no-state-stored' });
});

test('expired or corrupt stored state is treated as absent', () => {
  const s = memoryStorage();
  beginSsoState(s, 1000);
  assert.deepEqual(consumeSsoState('x', s, 1000 + SSO_STATE_TTL_MS + 1), { ok: true, reason: 'no-state-stored' });
  s.setItem(SSO_STATE_KEY, 'not json');
  assert.deepEqual(consumeSsoState('x', s, 1), { ok: true, reason: 'no-state-stored' });
});

test('null storage never throws', () => {
  assert.match(beginSsoState(null), /^[0-9a-f]{32}$/);
  assert.deepEqual(consumeSsoState('x', null), { ok: true, reason: 'no-state-stored' });
});
