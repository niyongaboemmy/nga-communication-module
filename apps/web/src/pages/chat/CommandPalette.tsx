import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, Hash, Megaphone, Users, MessageSquare, CornerDownLeft, Bookmark,
  Bell, Settings, Plus, Clock,
} from 'lucide-react';
import { Avatar } from '../../components/ui';
import { useChat } from './ChatProvider';
import { toPresence } from './types';
import type { Conversation } from './types';

/**
 * ⌘K — jump to anything.
 *
 * Conversations first, then actions. Not messages: full-text search belongs in
 * a panel where results can carry their context and be filtered, and mixing
 * "jump to #senior-4" with "a message from March that mentions senior 4" in one
 * list makes both harder to find.
 *
 * The whole thing is keyboard-driven. A palette you have to click is a menu.
 */

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

const KIND_ICON = { channel: Hash, announcement: Megaphone, group: Users } as const;

/**
 * Rank a conversation against what has been typed.
 *
 * A prefix match beats a word-start match, which beats a match anywhere. Without
 * that ordering, typing "sci" puts "Basic Science Club" above "science-dept",
 * and the palette stops being faster than the sidebar.
 */
function score(name: string, term: string): number {
  const n = name.toLowerCase();
  if (!term) return 0;
  if (n.startsWith(term)) return 3;
  if (n.split(/[\s-_]+/).some((word) => word.startsWith(term))) return 2;
  if (n.includes(term)) return 1;
  return -1;
}

export const CommandPalette: React.FC<{
  onClose: () => void;
  actions: PaletteAction[];
}> = ({ onClose, actions }) => {
  const { conversations, setActiveId } = useChat();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setActive(0); }, [query]);

  const term = query.trim().toLowerCase();

  const matchedConversations = useMemo(() => {
    const scored = conversations
      .map((c) => ({ c, s: score(c.name, term) }))
      .filter(({ s }) => term === '' || s >= 0);
    scored.sort((a, b) => b.s - a.s || Number(b.c.unread > 0) - Number(a.c.unread > 0));
    return scored.slice(0, term ? 8 : 6).map(({ c }) => c);
  }, [conversations, term]);

  const matchedActions = useMemo(
    () => actions.filter((a) => !term || a.label.toLowerCase().includes(term)),
    [actions, term],
  );

  type Row =
    | { kind: 'conversation'; conversation: Conversation }
    | { kind: 'action'; action: PaletteAction };

  const rows: Row[] = useMemo(() => [
    ...matchedConversations.map((c) => ({ kind: 'conversation' as const, conversation: c })),
    ...matchedActions.map((a) => ({ kind: 'action' as const, action: a })),
  ], [matchedConversations, matchedActions]);

  const choose = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === 'conversation') setActiveId(row.conversation.id);
    else row.action.run();
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % Math.max(rows.length, 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + rows.length) % Math.max(rows.length, 1)); }
      if (e.key === 'Enter') { e.preventDefault(); choose(rows[active]); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, active, onClose]);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div className="fixed inset-0 z-100 flex items-start justify-center p-4 pt-[12vh]">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="animate-fade-in relative flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border-light bg-white shadow-2xl dark:border-border-dark/40 dark:bg-chrome-dark"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border-light px-3 dark:border-border-dark/30">
          <Search size={16} className="shrink-0 text-text-secondary-light dark:text-text-secondary-dark" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a conversation, or type a command"
            aria-label="Jump to a conversation, or type a command"
            aria-controls="palette-results"
            className="flex-1 bg-transparent py-3.5 text-sm text-text-primary-light outline-none placeholder:text-text-secondary-light/80 dark:text-text-primary-dark"
          />
          <kbd className="shrink-0 rounded border border-border-light px-1.5 py-0.5 text-[10px] text-text-secondary-light dark:border-border-dark dark:text-text-secondary-dark">
            Esc
          </kbd>
        </div>

        <ul id="palette-results" ref={listRef} role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.length === 0 ? (
            <li className="px-3 py-8 text-center text-xs text-text-secondary-light dark:text-text-secondary-dark">
              Nothing matches “{query.trim()}”.
            </li>
          ) : rows.map((row, i) => {
            const selected = i === active;
            const cls = `flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left ${
              selected ? 'bg-blue-50 dark:bg-blue-900/30' : ''
            }`;

            if (row.kind === 'conversation') {
              const c = row.conversation;
              const Icon = c.type === 'dm' ? null : KIND_ICON[c.type];
              return (
                <li key={c.id} role="option" aria-selected={selected}>
                  <button className={cls} onMouseEnter={() => setActive(i)} onClick={() => choose(row)}>
                    {c.type === 'dm' ? (
                      <Avatar
                        name={c.name}
                        src={c.avatarUrl ?? undefined}
                        size={26}
                        presence={toPresence(c.peer?.presence)}
                      />
                    ) : (
                      <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500 dark:bg-card-dark/60 dark:text-slate-300">
                        {Icon && <Icon size={13} />}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm text-text-primary-light dark:text-text-primary-dark">
                      {c.name}
                    </span>
                    {c.unread > 0 && (
                      <span className="shrink-0 rounded-full bg-blue-600 px-1.5 text-[10px] font-semibold text-white">
                        {c.unread}
                      </span>
                    )}
                    {selected && <CornerDownLeft size={12} className="shrink-0 opacity-50" />}
                  </button>
                </li>
              );
            }

            return (
              <li key={row.action.id} role="option" aria-selected={selected}>
                <button className={cls} onMouseEnter={() => setActive(i)} onClick={() => choose(row)}>
                  <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500 dark:bg-card-dark/60 dark:text-slate-300">
                    {row.action.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text-primary-light dark:text-text-primary-dark">
                      {row.action.label}
                    </span>
                    {row.action.hint && (
                      <span className="block truncate text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
                        {row.action.hint}
                      </span>
                    )}
                  </span>
                  {selected && <CornerDownLeft size={12} className="shrink-0 opacity-50" />}
                </button>
              </li>
            );
          })}
        </ul>

        <p className="shrink-0 border-t border-border-light px-3 py-1.5 text-[10px] text-text-secondary-light dark:border-border-dark/40 dark:text-text-secondary-dark">
          ↑↓ to move · Enter to open · Esc to close
        </p>
      </div>
    </div>
  );
};

/** Icons for the standard actions, so callers do not each import their own. */
export const PALETTE_ICONS = {
  search: <Search size={13} />,
  saved: <Bookmark size={13} />,
  notifications: <Bell size={13} />,
  settings: <Settings size={13} />,
  newConversation: <Plus size={13} />,
  scheduled: <Clock size={13} />,
  thread: <MessageSquare size={13} />,
};
