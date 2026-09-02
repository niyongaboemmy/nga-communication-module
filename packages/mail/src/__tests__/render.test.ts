import { describe, it, expect } from 'vitest';
import {
  renderMerge, extractMergeFields, htmlToText, snippetOf, normalizeSubject,
  replySubject, forwardSubject, isEmailAddress, wrapEmailHtml,
} from '../render.js';

describe('renderMerge', () => {
  it('substitutes known fields and blanks unknown ones', () => {
    const out = renderMerge('Hi {{first_name}}, your balance is {{amount}} — {{missing}}', {
      first_name: 'Aline', amount: '15,000 RWF',
    });
    expect(out).toBe('Hi Aline, your balance is 15,000 RWF — ');
  });

  it('is case-insensitive on the field name', () => {
    expect(renderMerge('{{ NAME }}', { name: 'Bosco' })).toBe('Bosco');
  });

  it('escapes values into an HTML body when asked', () => {
    expect(renderMerge('<p>{{x}}</p>', { x: '<script>' }, { escape: true }))
      .toBe('<p>&lt;script&gt;</p>');
  });
});

describe('extractMergeFields', () => {
  it('collects distinct lower-cased fields from every input', () => {
    expect(extractMergeFields('Dear {{Name}}', '<p>{{name}} owes {{Amount}}</p>').sort())
      .toEqual(['amount', 'name']);
  });
});

describe('htmlToText', () => {
  it('turns block structure into newlines and keeps link text', () => {
    const text = htmlToText('<h1>Term 2</h1><p>Fees are <strong>due</strong>.</p><ul><li>Item</li></ul>');
    expect(text).toContain('Term 2');
    expect(text).toContain('Fees are due.');
    expect(text).toContain('• Item');
  });

  it('strips script and style', () => {
    expect(htmlToText('<style>x{}</style><script>evil()</script><p>Hello</p>')).toBe('Hello');
  });
});

describe('snippetOf', () => {
  it('flattens whitespace and truncates with an ellipsis', () => {
    const s = snippetOf('<p>' + 'word '.repeat(60) + '</p>', undefined, 40);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('…')).toBe(true);
  });
});

describe('normalizeSubject', () => {
  it('strips a run of reply/forward prefixes and folds case', () => {
    expect(normalizeSubject('Re: Fwd:  RE: Term Fees')).toBe('term fees');
  });
  it('leaves a clean subject alone', () => {
    expect(normalizeSubject('Sports Day')).toBe('sports day');
  });
});

describe('subject prefixing', () => {
  it('adds Re:/Fwd: at most once', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('Re: Hello')).toBe('Re: Hello');
    expect(forwardSubject('Notice')).toBe('Fwd: Notice');
    expect(forwardSubject('Fwd: Notice')).toBe('Fwd: Notice');
  });
});

describe('isEmailAddress', () => {
  it('accepts well-formed addresses and rejects the rest', () => {
    expect(isEmailAddress('parent@example.com')).toBe(true);
    expect(isEmailAddress('userId:12345')).toBe(false);
    expect(isEmailAddress('not an email')).toBe(false);
  });
});

describe('wrapEmailHtml', () => {
  it('wraps a fragment and appends a signature when given', () => {
    const html = wrapEmailHtml('<p>Body</p>', { signatureHtml: '<em>NGA</em>' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<p>Body</p>');
    expect(html).toContain('<em>NGA</em>');
  });
});
