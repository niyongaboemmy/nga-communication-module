import React from 'react';
import { HIGHLIGHT_START, HIGHLIGHT_END } from '../pages/chat/searchHighlight';

/**
 * Search text with the server's match sentinels turned into `<mark>`.
 *
 * The server never sends HTML for this — the matched text is user content, so
 * injecting it as markup would be stored XSS with extra steps. It sends two
 * control characters instead and this splits on them, which is why the result
 * is React elements rather than `dangerouslySetInnerHTML`.
 *
 * Lives here rather than beside the chat search panel because the global
 * palette highlights the same way over mail, posts, meetings and filenames;
 * two copies would drift the moment one of them changed colour.
 */
export const Highlighted: React.FC<{ text: string }> = ({ text }) => {
  // Split on the start sentinel, then on the end sentinel: everything before an
  // end sentinel is a match, everything after it is ordinary text.
  const segments = text.split(HIGHLIGHT_START);
  return (
    <>
      {segments.map((segment, i) => {
        if (i === 0) return <React.Fragment key={i}>{segment}</React.Fragment>;
        const [matched, ...rest] = segment.split(HIGHLIGHT_END);
        return (
          <React.Fragment key={i}>
            <mark className="rounded bg-amber-200 px-0.5 text-inherit dark:bg-amber-500/40">
              {matched}
            </mark>
            {rest.join(HIGHLIGHT_END)}
          </React.Fragment>
        );
      })}
    </>
  );
};
