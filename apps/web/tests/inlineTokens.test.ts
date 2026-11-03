import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeInline } from '../src/pages/chat/inlineTokens.ts';

const kinds = (s: string) => tokenizeInline(s).map((t) => `${t.kind}:${t.text}`);

test('underscores inside words stay as written', () => {
  assert.deepEqual(kinds('open my_file_name_v2.txt now'), ['text:open my_file_name_v2.txt now']);
});

test('asterisks between digits are arithmetic, not italics', () => {
  assert.deepEqual(kinds('compute 2*3*4 please'), ['text:compute 2*3*4 please']);
  assert.deepEqual(kinds('a * b * c'), ['text:a * b * c']);
});

test('emphasis at word edges still works', () => {
  assert.deepEqual(kinds('this is _really_ good'), ['text:this is ', 'italic:_really_', 'text: good']);
  assert.deepEqual(kinds('a *big* deal'), ['text:a ', 'italic:*big*', 'text: deal']);
  assert.deepEqual(kinds('**bold** move'), ['bold:**bold**', 'text: move']);
  assert.deepEqual(kinds('(_aside_)'), ['text:(', 'italic:_aside_', 'text:)']);
  assert.deepEqual(kinds('~~old~~ new'), ['strike:~~old~~', 'text: new']);
});

test('code, links and mentions win over emphasis', () => {
  assert.deepEqual(kinds('run `a_b_c` at https://x.io/a_b_c'), ['text:run ', 'code:`a_b_c`', 'text: at ', 'link:https://x.io/a_b_c']);
  assert.deepEqual(kinds('hi <@user_1>'), ['text:hi ', 'mention:<@user_1>']);
});
