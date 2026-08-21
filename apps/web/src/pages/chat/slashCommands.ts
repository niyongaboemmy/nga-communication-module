/**
 * Slash commands (FR-MSG-26).
 *
 * Deliberately few. A command set nobody can remember is a command set nobody
 * uses, and every one of these has a button somewhere too — the slash is the
 * fast path for people who are already typing, not the only path.
 *
 * Parsing rules that matter:
 *
 *  - A command is only a command at the **start** of the message. "see /poll
 *    results" is a sentence.
 *  - An unrecognised `/word` is sent as text, not rejected. Refusing to post
 *    "/etc/hosts is the file" would be absurd, and a chat that argues with what
 *    you typed is worse than one with no commands at all.
 */

export type SlashResult =
  | { kind: 'text'; body: string }
  | { kind: 'poll'; question: string; options: string[] }
  | { kind: 'shrug'; body: string }
  | { kind: 'me'; body: string }
  | { kind: 'open'; target: 'search' | 'saved' | 'settings' | 'scheduled' | 'shortcuts' }
  | { kind: 'meet' }
  | { kind: 'error'; message: string };

export interface SlashCommand {
  name: string;
  args?: string;
  hint: string;
}

/** Shown by the composer's `/` hint list. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'poll', args: '"Question" "Option A" "Option B"', hint: 'Start a poll' },
  { name: 'me', args: 'is running late', hint: 'Post an action, in the third person' },
  { name: 'shrug', hint: 'Append ¯\\_(ツ)_/¯' },
  { name: 'search', hint: 'Open search' },
  { name: 'saved', hint: 'Open your saved items' },
  { name: 'scheduled', hint: 'Show messages waiting to send' },
  { name: 'meet', hint: 'Start a video meeting' },
  { name: 'shortcuts', hint: 'List the keyboard shortcuts' },
];

/**
 * Split a command's arguments on quotes, falling back to a bare split.
 *
 * `/poll "Which day?" "Thursday" "Friday"` is the documented form, but people
 * type `/poll Which day? | Thursday | Friday` too, and the pipe form is worth
 * supporting because it needs no shift key on a phone.
 */
function parseArguments(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const quoted = [...trimmed.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.trim()).filter(Boolean);
  if (quoted.length) return quoted;

  if (trimmed.includes('|')) {
    return trimmed.split('|').map((p) => p.trim()).filter(Boolean);
  }
  return [trimmed];
}

export function parseSlashCommand(input: string): SlashResult {
  // Only at the start of the message.
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(input.trim());
  if (!match) return { kind: 'text', body: input };

  const name = match[1]!.toLowerCase();
  const rest = match[2] ?? '';

  switch (name) {
    case 'poll': {
      const parts = parseArguments(rest);
      if (parts.length < 3) {
        return {
          kind: 'error',
          message: 'Try: /poll "Which day?" "Thursday" "Friday" — a question and at least two options.',
        };
      }
      return { kind: 'poll', question: parts[0]!, options: parts.slice(1) };
    }

    case 'me':
      if (!rest.trim()) return { kind: 'error', message: 'Try: /me is on the way' };
      return { kind: 'me', body: rest.trim() };

    case 'shrug':
      return { kind: 'shrug', body: `${rest.trim()} ¯\\_(ツ)_/¯`.trim() };

    case 'search': return { kind: 'open', target: 'search' };
    case 'saved': return { kind: 'open', target: 'saved' };
    case 'scheduled': return { kind: 'open', target: 'scheduled' };
    case 'shortcuts': return { kind: 'open', target: 'shortcuts' };
    case 'meet': return { kind: 'meet' };

    // Not ours. Send it as what it is: text.
    default:
      return { kind: 'text', body: input };
  }
}

/** Suggestions for the `/` hint list, filtered by what has been typed. */
export function matchCommands(input: string): SlashCommand[] {
  const m = /^\/([a-z]*)$/i.exec(input);
  if (!m) return [];
  const term = m[1]!.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(term));
}
