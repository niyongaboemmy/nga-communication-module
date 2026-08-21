import React, { useMemo } from 'react';

/**
 * Message formatting (FR-MSG-3).
 *
 * A deliberately small Markdown subset — bold, italic, strikethrough, inline
 * code, fenced code blocks, blockquotes, lists, links and mentions. Not a
 * Markdown library: a chat message is not a document, and pulling in a full
 * parser would bring HTML passthrough with it, which is the one thing this must
 * not have.
 *
 * ── The security property ───────────────────────────────────────────────────
 * Nothing here ever produces HTML from user input. The message is *tokenised*
 * into React elements, so every piece of user text is a string child that React
 * escapes on the way to the DOM. There is no `dangerouslySetInnerHTML`, no
 * sanitiser to keep patched, and no configuration in which a crafted message
 * becomes markup. A stored XSS in a school chat would be handed straight to
 * every pupil in the channel; the only defence worth having is one that cannot
 * be switched off.
 */

interface Props {
  text: string;
  /** userId → display name, for resolving `<@id>` mentions. */
  names: Record<string, string>;
  /** The viewer, so a mention of them can be highlighted differently. */
  meId?: string;
  /** Inverts colours for use inside the sender's own blue bubble. */
  onDark?: boolean;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Inline
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Order matters. Code is matched first so that `**` inside a code span is not
 * treated as bold, and links before emphasis so an underscore in a URL does not
 * italicise the rest of the sentence.
 */
const INLINE = new RegExp([
  '(`[^`\\n]+`)',                                   // `code`
  '(<@[A-Za-z0-9_-]{1,64}>)',                       // mention
  '(@channel\\b|@here\\b|@everyone\\b)',            // broadcast mention
  '(https?://[^\\s<>()]+[^\\s<>().,;:!?])',         // bare link
  '(\\*\\*[^*\\n]+\\*\\*)',                         // **bold**
  '(~~[^~\\n]+~~)',                                 // ~~strike~~
  '(\\*[^*\\n]+\\*|_[^_\\n]+_)',                    // *italic* / _italic_
].join('|'), 'g');

function renderInline(
  text: string, names: Record<string, string>, meId: string | undefined,
  onDark: boolean, keyPrefix: string,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let i = 0;
  for (const part of text.split(INLINE)) {
    // String.split with a capturing group yields undefined for groups that did
    // not participate in the match; they are not content.
    if (part === undefined || part === '') continue;
    const key = `${keyPrefix}-${i++}`;

    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      out.push(
        <code
          key={key}
          className={`rounded px-1 py-0.5 font-mono text-[0.85em] ${
            onDark ? 'bg-white/20' : 'bg-slate-100 text-pink-600 dark:bg-slate-800 dark:text-pink-300'
          }`}
        >
          {part.slice(1, -1)}
        </code>,
      );
      continue;
    }

    const mention = /^<@([A-Za-z0-9_-]{1,64})>$/.exec(part);
    if (mention) {
      const id = mention[1]!;
      const isMe = id === meId;
      out.push(
        <span
          key={key}
          className={`rounded px-1 font-medium ${
            isMe
              ? 'bg-amber-200 text-amber-900 dark:bg-amber-500/30 dark:text-amber-200'
              : onDark
                ? 'bg-white/25 text-white'
                : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
          }`}
        >
          @{names[id] ?? 'someone'}
        </span>,
      );
      continue;
    }

    if (/^@(channel|here|everyone)$/.test(part)) {
      out.push(
        <span key={key} className="rounded bg-amber-200 px-1 font-medium text-amber-900 dark:bg-amber-500/30 dark:text-amber-200">
          {part}
        </span>,
      );
      continue;
    }

    if (/^https?:\/\//.test(part)) {
      out.push(
        // noreferrer as well as noopener: a school chat should not leak which
        // channel a link was posted in to whoever it points at.
        <a
          key={key}
          href={part}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className={`underline underline-offset-2 ${onDark ? 'text-white' : 'text-blue-600 dark:text-blue-400'}`}
        >
          {part.length > 60 ? `${part.slice(0, 57)}…` : part}
        </a>,
      );
      continue;
    }

    if (part.startsWith('**') && part.endsWith('**')) {
      out.push(<strong key={key} className="font-semibold">{part.slice(2, -2)}</strong>);
      continue;
    }
    if (part.startsWith('~~') && part.endsWith('~~')) {
      out.push(<s key={key} className="opacity-80">{part.slice(2, -2)}</s>);
      continue;
    }
    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) {
      out.push(<em key={key}>{part.slice(1, -1)}</em>);
      continue;
    }

    out.push(<React.Fragment key={key}>{part}</React.Fragment>);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Block
 * ────────────────────────────────────────────────────────────────────────── */

type Block =
  | { kind: 'code'; language: string; lines: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'text'; lines: string[] };

/**
 * Group lines into blocks.
 *
 * A single pass with an explicit current-block, rather than nested regex over
 * the whole string: fenced code has to swallow everything until its closing
 * fence, including lines that would otherwise look like list items, and that is
 * only expressible as state.
 */
function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let inCode = false;
  let current: Block | null = null;

  const flush = () => { if (current) { blocks.push(current); current = null; } };

  for (const line of lines) {
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      if (inCode) { flush(); inCode = false; }
      else {
        flush();
        inCode = true;
        current = { kind: 'code', language: fence[1] ?? '', lines: [] };
      }
      continue;
    }

    if (inCode) {
      if (current?.kind === 'code') current.lines.push(line);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      if (current?.kind !== 'quote') { flush(); current = { kind: 'quote', lines: [] }; }
      (current as Extract<Block, { kind: 'quote' }>).lines.push(quote[1] ?? '');
      continue;
    }

    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) {
      if (current?.kind !== 'ul') { flush(); current = { kind: 'ul', items: [] }; }
      (current as Extract<Block, { kind: 'ul' }>).items.push(ul[1] ?? '');
      continue;
    }

    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      if (current?.kind !== 'ol') { flush(); current = { kind: 'ol', items: [] }; }
      (current as Extract<Block, { kind: 'ol' }>).items.push(ol[1] ?? '');
      continue;
    }

    if (current?.kind !== 'text') { flush(); current = { kind: 'text', lines: [] }; }
    (current as Extract<Block, { kind: 'text' }>).lines.push(line);
  }
  flush();
  return blocks;
}

export const RichText: React.FC<Props> = ({ text, names, meId, onDark = false }) => {
  const blocks = useMemo(() => parseBlocks(text), [text]);

  return (
    <>
      {blocks.map((block, bi) => {
        const key = `b${bi}`;
        switch (block.kind) {
          case 'code':
            return (
              <pre
                key={key}
                className={`my-1.5 overflow-x-auto rounded-lg p-2.5 font-mono text-xs leading-relaxed ${
                  onDark ? 'bg-black/25' : 'bg-slate-900 text-slate-100'
                }`}
              >
                <code>{block.lines.join('\n')}</code>
              </pre>
            );

          case 'quote':
            return (
              <blockquote
                key={key}
                className={`my-1 border-l-2 pl-2.5 ${
                  onDark ? 'border-white/40 opacity-90' : 'border-slate-300 text-text-secondary-light dark:border-slate-600 dark:text-text-secondary-dark'
                }`}
              >
                {block.lines.map((l, i) => (
                  <div key={i}>{renderInline(l, names, meId, onDark, `${key}-${i}`)}</div>
                ))}
              </blockquote>
            );

          case 'ul':
            return (
              <ul key={key} className="my-1 list-disc space-y-0.5 pl-5">
                {block.items.map((l, i) => (
                  <li key={i}>{renderInline(l, names, meId, onDark, `${key}-${i}`)}</li>
                ))}
              </ul>
            );

          case 'ol':
            return (
              <ol key={key} className="my-1 list-decimal space-y-0.5 pl-5">
                {block.items.map((l, i) => (
                  <li key={i}>{renderInline(l, names, meId, onDark, `${key}-${i}`)}</li>
                ))}
              </ol>
            );

          default:
            return (
              <span key={key} className="whitespace-pre-wrap break-words">
                {block.lines.map((l, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <br />}
                    {renderInline(l, names, meId, onDark, `${key}-${i}`)}
                  </React.Fragment>
                ))}
              </span>
            );
        }
      })}
    </>
  );
};
