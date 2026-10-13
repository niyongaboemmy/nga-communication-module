/**
 * The inline tokeniser behind RichText, kept apart so it can be tested.
 *
 * Order matters. Code is matched first so that `**` inside a code span is not
 * treated as bold, and links before emphasis so an underscore in a URL does not
 * italicise the rest of the sentence.
 *
 * Emphasis only opens and closes at word edges (B-10 / CHAT2-24), the way Slack
 * and Teams read it: `my_file_name_v2.txt` and `2*3*4` are written as they are,
 * where they used to come out as "my<em>file</em>name" and "2<em>3</em>4". The
 * marked text may not start or end with a space either, so "a * b * c" stays
 * arithmetic.
 */
const EDGE_BEFORE = '(?<![\\p{L}\\p{N}_*~])';
const EDGE_AFTER = '(?![\\p{L}\\p{N}_*~])';

export const INLINE = new RegExp([
  '(`[^`\\n]+`)',                                                   // `code`
  '(<@[A-Za-z0-9_-]{1,64}>)',                                       // mention
  '(@channel\\b|@here\\b|@everyone\\b)',                            // broadcast mention
  '(https?://[^\\s<>()]+[^\\s<>().,;:!?])',                         // bare link
  `(${EDGE_BEFORE}\\*\\*(?!\\s)[^*\\n]+?(?<!\\s)\\*\\*${EDGE_AFTER})`, // **bold**
  `(${EDGE_BEFORE}~~(?!\\s)[^~\\n]+?(?<!\\s)~~${EDGE_AFTER})`,         // ~~strike~~
  `(${EDGE_BEFORE}\\*(?![\\s*])[^*\\n]+?(?<!\\s)\\*${EDGE_AFTER}`
    + `|${EDGE_BEFORE}_(?![\\s_])[^_\\n]+?(?<!\\s)_${EDGE_AFTER})`,    // *italic* / _italic_
].join('|'), 'gu');

export type InlineKind = 'code' | 'mention' | 'broadcast' | 'link' | 'bold' | 'strike' | 'italic' | 'text';

/** Split text into tokens, each tagged with what it is. */
export function tokenizeInline(text: string): Array<{ kind: InlineKind; text: string }> {
  const out: Array<{ kind: InlineKind; text: string }> = [];
  for (const part of text.split(INLINE)) {
    // String.split with a capturing group yields undefined for groups that did
    // not participate in the match; they are not content.
    if (part === undefined || part === '') continue;
    out.push({ kind: kindOf(part), text: part });
  }
  return out;
}

function kindOf(part: string): InlineKind {
  if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) return 'code';
  if (/^<@[A-Za-z0-9_-]{1,64}>$/.test(part)) return 'mention';
  if (/^@(channel|here|everyone)$/.test(part)) return 'broadcast';
  if (/^https?:\/\//.test(part)) return 'link';
  if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return 'bold';
  if (part.length > 4 && part.startsWith('~~') && part.endsWith('~~')) return 'strike';
  if (part.length > 2 && ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_')))) return 'italic';
  return 'text';
}
