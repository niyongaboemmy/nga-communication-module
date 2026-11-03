import { describe, it, expect } from 'vitest';
import { isEmoji } from '../emoji.js';

describe('isEmoji', () => {
  it('accepts single emoji, including modifiers, ZWJ sequences, flags and keycaps', () => {
    for (const e of ['👍', '👍🏽', '❤️', '😂', '👩‍💻', '🏳️‍🌈', '🇷🇼', '1️⃣', '#️⃣', '✅', '🎉']) {
      expect(isEmoji(e), e).toBe(true);
    }
  });
  it('refuses text, markup, several emoji and non-strings', () => {
    for (const e of ['<script>', 'ok', 'a👍', '👍👍', '', ' ', '1', ':thumbsup:', null, 5, {}]) {
      expect(isEmoji(e), String(e)).toBe(false);
    }
  });
});
