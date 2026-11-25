// Run with `npm test` (node --test; Node >= 23 strips TypeScript natively).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSchoolChangeAnswer, parseSchoolCookie, schoolGuardDecision, tidOfSessionToken } from '../src/lib/schoolGuard.ts';

const tok = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

test('nga_school parses <tid>.<sid> only', () => {
  assert.deepEqual(parseSchoolCookie('a=1; nga_school=2.abcdefgh12; b=2'), { tid: 2, sid: 'abcdefgh12' });
  assert.deepEqual(parseSchoolCookie('nga_school=2%2Eabcdefgh12'), { tid: 2, sid: 'abcdefgh12' });
  assert.equal(parseSchoolCookie('nga_school=0.abcdefgh12'), null);
  assert.equal(parseSchoolCookie('nga_school=2.short'), null);
  assert.equal(parseSchoolCookie('x_nga_school=2.abcdefgh12'), null);
  assert.equal(parseSchoolCookie(''), null);
});

test('only another school with a session present is a switch (Appendix A.1)', () => {
  assert.equal(schoolGuardDecision({ tid: 2, sid: 'abcdefgh12' }, 1), 'switch');
  assert.equal(schoolGuardDecision({ tid: 1, sid: 'abcdefgh12' }, 1), 'ok');
  assert.equal(schoolGuardDecision(null, 1), 'ok');
  assert.equal(schoolGuardDecision({ tid: 2, sid: 'abcdefgh12' }, null), 'ok');
});

test('school-change answers: 401 TENANT_MISMATCH/UNKNOWN, 409 SCHOOL_CHANGED', () => {
  assert.equal(isSchoolChangeAnswer(401, 'TENANT_MISMATCH'), true);
  assert.equal(isSchoolChangeAnswer(401, 'TENANT_UNKNOWN'), true);
  assert.equal(isSchoolChangeAnswer(409, 'SCHOOL_CHANGED'), true);
  assert.equal(isSchoolChangeAnswer(401, 'TOKEN_EXPIRED'), false);
  assert.equal(isSchoolChangeAnswer(401, undefined), false);
  assert.equal(isSchoolChangeAnswer(403, 'PASSWORD_REQUIRED'), false);
});

test('the session token names its school; no tid means school 1', () => {
  assert.equal(tidOfSessionToken(tok({ id: 'x', tid: 3 })), 3);
  assert.equal(tidOfSessionToken(tok({ id: 'x' })), 1);
  assert.equal(tidOfSessionToken('garbage'), null);
  assert.equal(tidOfSessionToken(null), null);
});
