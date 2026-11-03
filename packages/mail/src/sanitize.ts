import sanitizeHtml from 'sanitize-html';

/**
 * The one HTML policy for anything that becomes a mail body (C-02).
 *
 * An allowlist matched to what the TipTap editor actually produces —
 * paragraphs, headings, lists, quotes, code, links, images, simple tables and
 * text alignment/colour — and nothing else. Applied on write (compose,
 * templates, campaigns, signatures, AI output) so stored mail is safe for
 * every reader, including external mail clients; the web client sanitises
 * again on render as a second layer.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'hr', 'div', 'span',
    'h1', 'h2', 'h3', 'h4',
    'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'mark', 'sub', 'sup', 'small',
    'ul', 'ol', 'li', 'blockquote', 'code', 'pre',
    'a', 'img',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    ol: ['start'],
    '*': ['style'],
  },
  allowedStyles: {
    '*': {
      'text-align': [/^(left|right|center|justify)$/],
      color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i],
      'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i],
      'font-weight': [/^(bold|normal|[1-9]00)$/],
      'font-style': [/^(italic|normal)$/],
      'text-decoration': [/^(underline|line-through|none)$/],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    // Every link opens in a new tab and carries no referrer or opener.
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer nofollow' }, true),
  },
  exclusiveFilter: (frame) =>
    // A data: URI is only ever an image, and only a raster one.
    frame.tag === 'img' && typeof frame.attribs.src === 'string'
      && frame.attribs.src.startsWith('data:')
      && !/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(frame.attribs.src),
};

export function sanitizeMailHtml(html: string | null | undefined): string {
  if (!html) return '';
  return sanitizeHtml(html, OPTIONS);
}
