import React from 'react';
import { ChevronDown } from 'lucide-react';
import type { WireMessage } from '@tupo/shared';
import { Avatar } from '../../components/ui';

/**
 * The line under a message that has replies (R-02) — the Facebook pattern:
 * faces, who replied, how many, how long ago. One tap opens the replies in
 * place (R-03); the whole line is the target, at least 36 px tall (44 px on
 * touch).
 *
 *   (DH)(BR)  Didier and Bosco replied · 5 replies · 2 min   ⌄
 */

function firstName(name: string): string {
  return name.split(' ')[0] || name;
}

function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} d`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "Didier replied", "Didier and Bosco replied", "Didier and 2 others replied". */
export function whoReplied(people: Array<{ id: string; name: string }>, meId?: string): string {
  const names = people.map((p) => (p.id === meId ? 'You' : firstName(p.name)));
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} replied`;
  if (names.length === 2) return `${names[0]} and ${names[1]} replied`;
  return `${names[0]} and ${names.length - 1} others replied`;
}

export const ThreadSummary: React.FC<{
  message: WireMessage;
  newReplies: number;
  open: boolean;
  meId?: string;
  onToggle: () => void;
}> = ({ message: m, newReplies, open, meId, onToggle }) => {
  const people = m.threadParticipants ?? [];
  const count = m.replyCount;
  const who = whoReplied(people, meId);
  const label = `${who ? `${who} · ` : ''}${count} ${count === 1 ? 'reply' : 'replies'}`;
  const when = ago(m.threadLastAt);
  return (
    <button
      type="button"
      data-thread-summary=""
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${label}${newReplies > 0 ? `, ${newReplies} new` : ''}${when ? `, last ${when}` : ''}. ${open ? 'Hide' : 'Show'} replies`}
      className={`group/summary mt-1 flex min-h-9 max-w-full items-center gap-2 rounded-xl px-2 py-1 text-left text-xs transition-colors duration-150 [@media(pointer:coarse)]:min-h-11 ${
        newReplies > 0
          ? 'bg-blue-50 text-blue-800 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-200 dark:hover:bg-blue-900/45'
          : 'text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-900/25'
      }`}
    >
      {people.length > 0 && (
        <span className="flex shrink-0 -space-x-1.5" aria-hidden="true">
          {people.slice(0, 3).map((p) => (
            <span key={p.id} data-avatar="" className="rounded-full ring-2 ring-surface-light dark:ring-background-dark">
              <Avatar name={p.name} src={p.avatarUrl ?? undefined} size={20} />
            </span>
          ))}
        </span>
      )}
      <span className="min-w-0 truncate font-semibold">{label}</span>
      {newReplies > 0 && (
        <span className="shrink-0 rounded-full bg-blue-600 px-1.5 text-[10px] font-semibold leading-4 tabular-nums text-white">
          {newReplies} new
        </span>
      )}
      {when && <span className="shrink-0 text-text-secondary-light dark:text-text-secondary-dark">· {when}</span>}
      <ChevronDown size={14} className={`shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
    </button>
  );
};
