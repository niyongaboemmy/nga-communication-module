import React, { useMemo } from 'react';
import DOMPurify from 'dompurify';

/**
 * Render stored HTML (mail bodies, campaign previews, AI drafts) safely.
 *
 * The server already sanitises on write; this is the second layer, so a body
 * stored before that existed — or anything that slipped past it — still
 * cannot run script, carry event handlers or point a link at `javascript:`.
 * Links open in a new tab without an opener. Every place that renders mail
 * HTML goes through here instead of `dangerouslySetInnerHTML` directly.
 */

let hooked = false;
function purifier(): typeof DOMPurify {
  if (!hooked) {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.getAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer nofollow');
      }
    });
    hooked = true;
  }
  return DOMPurify;
}

export function sanitizeHtml(html: string): string {
  return purifier().sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['srcset'],
    ALLOW_DATA_ATTR: false,
  });
}

export const SafeHtml: React.FC<{ html: string; className?: string; fallback?: string }> = ({ html, className, fallback = '' }) => {
  const clean = useMemo(() => sanitizeHtml(html || fallback), [html, fallback]);
  // eslint-disable-next-line react/no-danger -- sanitised above
  return <div className={className} dangerouslySetInnerHTML={{ __html: clean }} />;
};

/** Escape text for insertion into an HTML string (names, subjects). */
export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
