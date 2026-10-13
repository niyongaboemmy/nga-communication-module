import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDisplay, toWire } from '../src/pages/chat/mentionText.ts';

const people = [{ id: 'u1', name: 'Ada' }, { id: 'u2', name: 'Ada Journey' }, { id: 'u3', name: 'Bo Li' }];

test('a picked mention shows as a name', () => {
  assert.deepEqual(toDisplay('<@u2> ', people), { text: '@Ada Journey ', target: people[1] });
  assert.deepEqual(toDisplay('@channel ', people), { text: '@channel ' });
});

test('names go back to tokens on send, longest first, whole words only', () => {
  assert.equal(toWire('hi @Ada Journey and @Ada!', people), 'hi <@u2> and <@u1>!');
  assert.equal(toWire('@bo li, see this', people), '<@u3>, see this');
  assert.equal(toWire('email ada@Ada.com', people), 'email ada@Ada.com');
  assert.equal(toWire('@Adams is not Ada', people), '@Adams is not Ada');
  assert.equal(toWire('keep <@u9> as it is', people), 'keep <@u9> as it is');
});
