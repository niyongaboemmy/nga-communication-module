// Run with `npm test` (node --test; Node >= 23 strips TypeScript natively).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountChange, prepareAccountReplace, signOutCleanup, storedAccount, storedSessionUsable, msUntilExpiry, type CleanupDeps,
} from '../src/lib/accountReplace.ts';

const tok = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const now = Date.UTC(2026, 10, 25, 12);
const inAnHour = Math.floor(now / 1000) + 3600;

/** Records the order cleanup steps ran in, and whether a token was still stored for push. */
function recorder(storage: { token: string | null }) {
  const steps: string[] = [];
  const deps: CleanupDeps = {
    disablePush: async () => { steps.push(`push(${storage.token ?? 'none'})`); },
    clearOutbox: async () => { steps.push('outbox:clear'); },
    keepOutbox: () => { steps.push('outbox:keep'); },
    clearSession: () => { steps.push('session:clear'); storage.token = null; },
  };
  return { steps, deps };
}

test('WEB-ISO-1 accountChange: same account, same person in another school, someone else', () => {
  const a = { id: 'u1', tid: 1, email: 'Aline@nga.ac.rw' };
  assert.equal(accountChange(null, a), null);
  assert.equal(accountChange(a, { ...a }), 'same');
  assert.equal(accountChange(a, { id: 'u9', tid: 2, email: 'aline@nga.ac.rw ' }), 'school-switch');
  assert.equal(accountChange(a, { id: 'u2', tid: 1, email: 'other@nga.ac.rw' }), 'other-person');
  // Same id in another school is another account (ids repeat across schools).
  assert.equal(accountChange(a, { id: 'u1', tid: 2, email: 'x@y.z' }), 'other-person');
  // Same e-mail in the SAME school with another id is not a switch.
  assert.equal(accountChange(a, { id: 'u3', tid: 1, email: 'aline@nga.ac.rw' }), 'other-person');
  // No e-mail on either side never counts as the same person.
  assert.equal(accountChange({ id: 'u1', tid: 1 }, { id: 'u4', tid: 2 }), 'other-person');
});

test('WEB-ISO-1 a different person: push off with the OLD token first, outbox cleared, then session cleared', async () => {
  const storage = { token: 'old-token' };
  const { steps, deps } = recorder(storage);
  const change = await prepareAccountReplace({ id: 'u1', tid: 1, email: 'a@x' }, { id: 'u2', tid: 1, email: 'b@x' }, deps);
  assert.equal(change, 'other-person');
  assert.deepEqual(steps, ['push(old-token)', 'outbox:clear', 'session:clear']);
});

test('WEB-ISO-1 the same person in another school keeps the queued messages (switch semantics)', async () => {
  const storage = { token: 'old-token' };
  const { steps, deps } = recorder(storage);
  assert.equal(await prepareAccountReplace({ id: 'u1', tid: 1, email: 'a@x' }, { id: 'u7', tid: 2, email: 'a@x' }, deps), 'school-switch');
  assert.deepEqual(steps, ['push(old-token)', 'outbox:keep', 'session:clear']);
});

test('WEB-ISO-1 nothing runs for the same account or when nobody was signed in', async () => {
  const { steps, deps } = recorder({ token: 't' });
  assert.equal(await prepareAccountReplace({ id: 'u1', tid: 1 }, { id: 'u1', tid: 1 }, deps), 'same');
  assert.equal(await prepareAccountReplace(null, { id: 'u1', tid: 1 }, deps), null);
  assert.deepEqual(steps, []);
});

test('WEB-ISO-1 a hanging or failing push step never blocks the sign-in', async () => {
  const steps: string[] = [];
  const deps: CleanupDeps = {
    disablePush: () => new Promise(() => {}),
    clearOutbox: async () => { throw new Error('idb gone'); },
    keepOutbox: () => {},
    clearSession: () => { steps.push('session:clear'); },
  };
  await signOutCleanup(deps, false, 20);
  assert.deepEqual(steps, ['session:clear']);
  const failing = { ...deps, disablePush: async () => { throw new Error('offline'); } };
  await signOutCleanup(failing, false, 20);
  assert.deepEqual(steps, ['session:clear', 'session:clear']);
});

test('WEB-ISO-1 storedAccount reads the stored user and the token school', () => {
  assert.deepEqual(storedAccount(tok({ id: 'u1', tid: 2 }), JSON.stringify({ id: 'u1', email: 'a@x' })), { id: 'u1', tid: 2, email: 'a@x' });
  assert.deepEqual(storedAccount(tok({ id: 'u1' }), JSON.stringify({ id: 'u1' })), { id: 'u1', tid: 1, email: null });
  assert.equal(storedAccount(null, '{"id":"u1"}'), null);
  assert.equal(storedAccount('t', 'not json'), null);
});

test('WEB-ISO-2 a stored session is used only while unexpired and owned by the stored user', () => {
  const user = { id: 'u1' };
  assert.equal(storedSessionUsable(tok({ id: 'u1', tid: 2, exp: inAnHour }), user, now), true);
  assert.equal(storedSessionUsable(tok({ id: 'u1', exp: Math.floor(now / 1000) - 1 }), user, now), false, 'expired');
  assert.equal(storedSessionUsable(tok({ id: 'u1' }), user, now), false, 'no exp');
  assert.equal(storedSessionUsable(tok({ id: 'u2', exp: inAnHour }), user, now), false, 'another user than the cache owner');
  assert.equal(storedSessionUsable('garbage', user, now), false);
  assert.equal(storedSessionUsable(tok({ id: 'u1', exp: inAnHour }), null, now), false);
});

test('WEB-ISO-2 msUntilExpiry', () => {
  assert.equal(msUntilExpiry(tok({ exp: inAnHour }), now), 3_600_000);
  assert.equal(msUntilExpiry(tok({ exp: 1 }), now), 0);
  assert.equal(msUntilExpiry(tok({}), now), 0);
  assert.equal(msUntilExpiry(null, now), 0);
});
