/**
 * Mentions as people read them (B-09 / CHAT2-11).
 *
 * The composer used to show what the wire carries — "hi <@gapc-d6f61e5699>" —
 * the moment a name was picked. Now the box shows "@Ada Journey", and the
 * text is turned into `<@id>` tokens only as it is sent, from the names that
 * were picked and the conversation's member list (so a draft that came from
 * another device still resolves).
 */
export interface MentionTarget { id: string; name: string }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What to put in the box for a picked entry: `<@id> ` becomes `@Name `. */
export function toDisplay(replacement: string, targets: MentionTarget[]): { text: string; target?: MentionTarget } {
  const m = /^<@([A-Za-z0-9_-]{1,64})>(\s?)$/.exec(replacement);
  if (!m) return { text: replacement };
  const target = targets.find((t) => t.id === m[1]);
  return target ? { text: `@${target.name}${m[2] || ' '}`, target } : { text: replacement };
}

/**
 * Turn "@Full Name" back into `<@id>`. Longest names first, so "@Ada Journey"
 * is not read as "@Ada" followed by " Journey"; a name only matches as a
 * whole word. When two people share a name, the one picked wins (it comes
 * first in `targets`).
 */
export function toWire(text: string, targets: MentionTarget[]): string {
  const seen = new Set<string>();
  const ordered = targets
    .filter((t) => t.name && !seen.has(t.name.toLowerCase()) && seen.add(t.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length);
  let out = text;
  for (const t of ordered) {
    out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}_<])@${escape(t.name)}(?![\\p{L}\\p{N}_])`, 'giu'), `$1<@${t.id}>`);
  }
  return out;
}
