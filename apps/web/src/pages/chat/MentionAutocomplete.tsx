import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AtSign, Users, Radio } from 'lucide-react';
import { Avatar } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { toPresence } from './types';
import type { WireMember } from '@tupo/shared';

/**
 * `@` autocomplete (FR-MSG-4).
 *
 * Mentions are stored as `<@id>`, never as a display name, so that someone who
 * changes their name does not leave stale copies of the old one scattered
 * through history. This component is what turns a typed "@Al" into that id —
 * which means without it, mentions are unusable by anyone who does not know
 * user ids by heart.
 *
 * Keyboard-first: ↑/↓ to move, Enter or Tab to accept, Escape to dismiss. A
 * picker you have to reach for the mouse to use interrupts typing, which is the
 * one thing an inline autocomplete must not do.
 */

export interface MentionCandidate {
  id: string;
  name: string;
  avatarUrl: string | null;
  presence: string;
  /** Shown as the second line — "Chemistry", "Deputy Head". */
  detail: string | null;
  /** Broadcast entries (@channel, @here) are inserted literally, not as ids. */
  broadcast?: 'channel' | 'here';
}

/** Where the caret is inside an `@…` token, if it is inside one at all. */
export interface MentionQuery {
  /** Index of the `@`. */
  start: number;
  /** Text typed after the `@`. */
  term: string;
}

/**
 * Find the mention being typed.
 *
 * The `@` must start a word — an email address is not a mention, and treating
 * the `@` in "head@amashuri.com" as one would pop the picker open in the middle
 * of every address anyone types.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at === -1) return null;

  const before = at === 0 ? '' : upto[at - 1]!;
  if (before && !/\s/.test(before)) return null;

  const term = upto.slice(at + 1);
  // A space ends the token. Names contain spaces, but requiring the search to
  // be one word keeps the picker from staying open across a whole sentence.
  if (/[\s@]/.test(term)) return null;
  if (term.length > 32) return null;

  return { start: at, term };
}

export const MentionAutocomplete: React.FC<{
  members: WireMember[];
  query: MentionQuery;
  /** Called with the text to substitute for the whole `@…` token. */
  onPick: (replacement: string) => void;
  onDismiss: () => void;
  /** Broadcast mentions are hidden in a DM — there is nobody else to address. */
  allowBroadcast: boolean;
}> = ({ members, query, onPick, onDismiss, allowBroadcast }) => {
  const { can } = usePermissions();
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const candidates = useMemo<MentionCandidate[]>(() => {
    const term = query.term.toLowerCase();

    const people: MentionCandidate[] = members
      .filter((m) => !term || m.name.toLowerCase().includes(term))
      .slice(0, 8)
      .map((m) => ({
        id: m.userId,
        name: m.name,
        avatarUrl: m.avatarUrl,
        presence: m.presence,
        detail: m.platformRole,
      }));

    if (!allowBroadcast) return people;

    /*
     * `@channel` is offered only to people who may actually address everyone.
     * Showing it to someone whose message will then reach nobody is worse than
     * not showing it: they believe they have told the class.
     */
    const broadcasts: MentionCandidate[] = [];
    const mayBroadcast = can('CHANNEL_ANNOUNCE');
    for (const entry of [
      { key: 'here' as const, label: 'here', detail: 'Notify everyone who is online' },
      { key: 'channel' as const, label: 'channel', detail: 'Notify every member' },
    ]) {
      if (entry.key === 'channel' && !mayBroadcast) continue;
      if (!term || entry.label.startsWith(term)) {
        broadcasts.push({
          id: `@${entry.label}`,
          name: `@${entry.label}`,
          avatarUrl: null,
          presence: 'online',
          detail: entry.detail,
          broadcast: entry.key,
        });
      }
    }
    return [...broadcasts, ...people];
  }, [members, query.term, allowBroadcast, can]);

  // Reset the highlight whenever the candidate set changes, or a keystroke can
  // leave the selection pointing at a row that has moved.
  useEffect(() => { setActive(0); }, [query.term]);

  useEffect(() => {
    if (!candidates.length) { onDismiss(); return; }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % candidates.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + candidates.length) % candidates.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        // Stopped so the composer's own Enter handler does not also fire and
        // send a message containing a half-typed "@al".
        e.stopPropagation();
        const chosen = candidates[active];
        if (chosen) onPick(chosen.broadcast ? `${chosen.name} ` : `<@${chosen.id}> `);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    };

    // Capture phase, so this runs before the textarea's own key handling.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [candidates, active, onPick, onDismiss]);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!candidates.length) return null;

  return (
    <div
      role="listbox"
      aria-label="Mention someone"
      className="absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-2xl border border-border-light bg-white shadow-2xl dark:border-border-dark/50 dark:bg-elevated-dark"
    >
      <ul ref={listRef} className="max-h-60 overflow-y-auto py-1">
        {candidates.map((c, i) => (
          <li key={c.id}>
            <button
              role="option"
              aria-selected={i === active}
              // `onMouseDown` rather than `onClick`: click fires after blur,
              // and losing focus closes the picker before the pick lands.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(c.broadcast ? `${c.name} ` : `<@${c.id}> `);
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${
                i === active ? 'bg-blue-50 dark:bg-blue-900/30' : ''
              }`}
            >
              {c.broadcast ? (
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400">
                  {c.broadcast === 'here' ? <Radio size={14} /> : <Users size={14} />}
                </span>
              ) : (
                <Avatar name={c.name} src={c.avatarUrl ?? undefined} size={28} presence={toPresence(c.presence)} />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
                  {c.name}
                </span>
                {c.detail && (
                  <span className="block truncate text-[11px] capitalize text-text-secondary-light dark:text-text-secondary-dark">
                    {c.detail}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="border-t border-border-light px-3 py-1 text-[10px] text-text-secondary-light dark:border-border-dark/40 dark:text-text-secondary-dark">
        <AtSign size={9} className="mr-1 inline" />
        ↑↓ to choose · Enter to insert · Esc to dismiss
      </p>
    </div>
  );
};
