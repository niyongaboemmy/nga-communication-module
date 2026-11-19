import { describe, it, expect } from 'vitest';
import { cleanLinkPreview } from '../posts.js';

describe('cleanLinkPreview (F-05)', () => {
  it('keeps an ordinary preview', () => {
    expect(cleanLinkPreview({ url: 'https://example.org/a', title: ' Hello ', image: 'https://cdn.example.org/x.png', siteName: 'Ex' }))
      .toEqual({ url: 'https://example.org/a', title: 'Hello', description: null, image: 'https://cdn.example.org/x.png', siteName: 'Ex' });
  });

  it('refuses a script link and drops a script picture', () => {
    expect(cleanLinkPreview({ url: 'javascript:alert(1)', title: 'x' })).toBeNull();
    expect(cleanLinkPreview({ url: 'https://ok.example', image: 'javascript:alert(1)' })?.image).toBeNull();
    expect(cleanLinkPreview({ url: 'data:text/html,hi' })).toBeNull();
  });

  it('caps text and ignores junk', () => {
    const p = cleanLinkPreview({ url: 'https://ok.example', title: 'a'.repeat(1000), extra: '<script>' });
    expect(p?.title?.length).toBe(300);
    expect(p).not.toHaveProperty('extra');
    expect(cleanLinkPreview(null)).toBeNull();
    expect(cleanLinkPreview('https://x.example')).toBeNull();
  });
});
