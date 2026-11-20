// Run with `npm test` (node --test; Node >= 23 strips TypeScript natively).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_RETRY_MS, SIGNED_OUT_HOLD_MS, clearSignInHolds, markSignedOut, noteAutoAttempt,
  rememberReturn, safeReturnPath, shouldAutoSignIn, takeReturn, type KeyStorage,
} from '../src/lib/autoSignIn.ts';

const mem = (): KeyStorage => {
  const d = new Map<string, string>();
  return { getItem: (k) => d.get(k) ?? null, setItem: (k, v) => void d.set(k, v), removeItem: (k) => void d.delete(k) };
};
const T = 1_800_000_000_000;

test('someone arriving with no session is signed in automatically', () => {
  assert.equal(shouldAutoSignIn({ tab: mem(), shared: mem(), now: T, online: true, search: '' }), true);
});

test('one automatic attempt per tab: a failed round trip does not loop', () => {
  const tab = mem(); const shared = mem();
  noteAutoAttempt(tab, T);
  assert.equal(shouldAutoSignIn({ tab, shared, now: T + 5_000, online: true, search: '' }), false);
  assert.equal(shouldAutoSignIn({ tab, shared, now: T + AUTO_RETRY_MS + 1, online: true, search: '' }), true);
});

test('a deliberate sign-out holds every tab on the sign-in screen, for a while', () => {
  const shared = mem();
  markSignedOut(shared, T);
  assert.equal(shouldAutoSignIn({ tab: mem(), shared, now: T + 60_000, online: true, search: '' }), false);
  assert.equal(shouldAutoSignIn({ tab: mem(), shared, now: T + SIGNED_OUT_HOLD_MS + 1, online: true, search: '' }), true);
});

test('signing in lifts both holds', () => {
  const tab = mem(); const shared = mem();
  noteAutoAttempt(tab, T); markSignedOut(shared, T);
  clearSignInHolds(tab, shared);
  assert.equal(shouldAutoSignIn({ tab, shared, now: T + 1, online: true, search: '' }), true);
});

test('offline, or ?signin=manual, shows the screen', () => {
  assert.equal(shouldAutoSignIn({ tab: mem(), shared: mem(), now: T, online: false, search: '' }), false);
  assert.equal(shouldAutoSignIn({ tab: mem(), shared: mem(), now: T, online: true, search: '?signin=manual' }), false);
});

test('the address they followed survives the round trip, once', () => {
  const tab = mem();
  rememberReturn('/app/chat/123?m=9#end', tab);
  assert.equal(takeReturn(tab), '/app/chat/123?m=9#end');
  assert.equal(takeReturn(tab), null);
});

test('only in-app addresses are ever returned to', () => {
  for (const bad of ['//evil.org/app', 'https://evil.org/app', '/apps', '/', '/sso/callback', '/app\\..\\x', '', null]) {
    assert.equal(safeReturnPath(bad as string | null), null, String(bad));
  }
  assert.equal(safeReturnPath('/app'), '/app');
  assert.equal(safeReturnPath('/app/mail?t=1'), '/app/mail?t=1');
  const tab = mem();
  tab.setItem('tupo_return_to', '//evil.org');
  assert.equal(takeReturn(tab), null);
});
