/**
 * Pure text transforms for mail — no database, no side effects, unit-tested on
 * their own.
 *
 * Merge-field rendering (FR-MAIL-5/6), HTML→text for the plain-text part and
 * for previews, and subject normalisation for threading (FR-MAIL-2).
 */
import { MAIL_MERGE_PATTERN } from '@tupo/shared';

export { normalizeSubject } from '@tupo/shared';

/**
 * Substitute `{{field}}` tokens from a variables map.
 *
 * An unknown or empty field renders as an empty string rather than leaving the
 * literal `{{class}}` in someone's fee notice — a missing merge value is a data
 * problem to surface in the preview, never something to mail out raw.
 * Values are HTML-escaped when `escape` is true (the html body); the text body
 * passes them through.
 */
export function renderMerge(
  template: string,
  vars: Record<string, string | number | null | undefined>,
  opts: { escape?: boolean } = {},
): string {
  const escape = opts.escape ?? false;
  return template.replace(MAIL_MERGE_PATTERN, (_m, rawKey: string) => {
    const key = rawKey.toLowerCase();
    const value = vars[key];
    if (value === undefined || value === null) return '';
    const str = String(value);
    return escape ? escapeHtml(str) : str;
  });
}

/** Every distinct `{{field}}` referenced by a body/subject, lower-cased. */
export function extractMergeFields(...texts: string[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(MAIL_MERGE_PATTERN)) {
      if (match[1]) seen.add(match[1].toLowerCase());
    }
  }
  return [...seen];
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A serviceable plain-text rendering of an HTML body — the multipart/alternative
 * text part, and the source for previews. Not a full HTML→Markdown engine:
 * block tags become newlines, `<br>` becomes a newline, links keep their text,
 * everything else is stripped and entities are decoded.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li)>/gi, '\n')
    .replace(/<li[^>]*>/gi, ' • ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** One-line preview for a mailbox list. */
export function snippetOf(html: string, text?: string, max = 160): string {
  const base = (text && text.trim()) || htmlToText(html);
  const flat = base.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** "Re: " a subject once — never "Re: Re: ". */
export function replySubject(subject: string): string {
  return /^\s*re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** "Fwd: " a subject once. */
export function forwardSubject(subject: string): string {
  return /^\s*fwd?\s*:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmailAddress(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

/**
 * Wrap a bare HTML fragment (what the editor produces) in a minimal, email-safe
 * document for SMTP delivery. Kept deliberately plain — inlined base styles,
 * no external anything.
 */
export function wrapEmailHtml(bodyHtml: string, opts: { signatureHtml?: string } = {}): string {
  const sig = opts.signatureHtml
    ? `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:13px">${opts.signatureHtml}</div>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">
<div style="background:#ffffff;border-radius:12px;padding:28px 28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#111827">
${bodyHtml}
${sig}
</div>
<div style="text-align:center;color:#9ca3af;font-size:12px;margin-top:16px">Sent via NGA Tupo</div>
</div></body></html>`;
}
