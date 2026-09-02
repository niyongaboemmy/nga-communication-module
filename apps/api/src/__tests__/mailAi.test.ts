import { describe, it, expect } from 'vitest';
import { sanitizeAiHtml } from '../services/mailAiService.js';

/**
 * The model's drafted body reaches an inbox, so the sanitiser is a security
 * boundary, not a formatting nicety.
 */
describe('sanitizeAiHtml', () => {
  it('keeps a normal drafted body intact', () => {
    const out = sanitizeAiHtml('<p>Dear <strong>Aline</strong>,</p><ul><li>Point one</li></ul>');
    expect(out).toBe('<p>Dear <strong>Aline</strong>,</p><ul><li>Point one</li></ul>');
  });

  it('strips a fenced code wrapper the model sometimes adds', () => {
    expect(sanitizeAiHtml('```html\n<p>Hi</p>\n```')).toBe('<p>Hi</p>');
  });

  it('removes <script> and inline event handlers', () => {
    const out = sanitizeAiHtml('<p onclick="steal()">Hi</p><script>evil()</script>');
    expect(out).toBe('<p>Hi</p>');
    expect(out).not.toMatch(/script|onclick/i);
  });

  it('drops disallowed tags but keeps their text', () => {
    expect(sanitizeAiHtml('<p>Before <iframe src="x"></iframe><style>x{}</style>after</p>'))
      .toBe('<p>Before after</p>');
  });

  it('allows only http/https/mailto links and forces safe rel/target', () => {
    const ok = sanitizeAiHtml('<p><a href="https://nga.ac.rw">site</a></p>');
    expect(ok).toContain('href="https://nga.ac.rw"');
    expect(ok).toContain('rel="noopener nofollow"');
    const bad = sanitizeAiHtml('<p><a href="javascript:alert(1)">x</a></p>');
    expect(bad).toBe('<p><a>x</a></p>');
  });

  it('wraps a bare-text response in a paragraph', () => {
    expect(sanitizeAiHtml('just some text')).toBe('<p>just some text</p>');
  });
});
