// Run with `npm test` (node --test; Node >= 23 strips TypeScript natively).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { largeAvatarUrl } from '../src/lib/avatarUrl.ts';

test('previews use the 512 px rendition of an NGA MIS photo, keeping the signature', () => {
  assert.equal(
    largeAvatarUrl('https://api.amashuri.com/avatars/42/1790000000/md.webp?s=abc'),
    'https://api.amashuri.com/avatars/42/1790000000/lg.webp?s=abc',
  );
  assert.equal(
    largeAvatarUrl('https://api.amashuri.com/avatars/42/1790000000/sm.webp?s=abc'),
    'https://api.amashuri.com/avatars/42/1790000000/lg.webp?s=abc',
  );
});

test('other links are left alone', () => {
  for (const url of [
    'https://api.amashuri.com/avatars/42/1790000000/lg.webp?s=abc',
    'https://api.amashuri.com/covers/42/1790000000/md.webp?s=abc',
    '/files/abc/md.webp',
    'https://example.com/me.png',
  ]) assert.equal(largeAvatarUrl(url), url);
});
