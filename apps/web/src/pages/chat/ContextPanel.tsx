import React, { useState } from 'react';
import { X, Users, FileText, Info, Bell, BellOff, Star, LogOut } from 'lucide-react';
import { Avatar, IconButton, EmptyState } from '../../components/ui';
import type { Conversation, Member } from './types';

/**
 * The right-hand context panel (§15.1) — thread, members, files and details for
 * whatever is open in the main pane.
 *
 * It is inline from `xl` up, where there is width for three panes, and an
 * overlay below that. Same component either way: only the wrapper in
 * ChatLayout differs, so the two never drift apart.
 */

type Tab = 'about' | 'members' | 'files';

const TABS: { id: Tab; label: string; icon: typeof Info }[] = [
  { id: 'about', label: 'About', icon: Info },
  { id: 'members', label: 'Members', icon: Users },
  { id: 'files', label: 'Files', icon: FileText },
];

export const ContextPanel: React.FC<{
  conversation: Conversation;
  members: Member[];
  onClose: () => void;
}> = ({ conversation: c, members, onClose }) => {
  const [tab, setTab] = useState<Tab>('about');

  return (
    <aside
      aria-label="Conversation details"
      className="flex h-full min-h-0 w-full flex-col border-l border-border-light bg-white dark:border-gray-700/30 dark:bg-gray-800/20"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-light px-3 dark:border-gray-700/30">
        <h2 className="truncate text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">Details</h2>
        <IconButton label="Close details" onClick={onClose}><X size={18} /></IconButton>
      </header>

      <div className="shrink-0 border-b border-border-light px-2 pt-2 dark:border-gray-700/30" role="tablist">
        <div className="flex gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-t-xl border-b-2 px-2 py-2 text-xs font-medium transition-colors duration-150 ${
                tab === id
                  ? 'border-blue-600 text-blue-600 dark:border-blue-500 dark:text-blue-400'
                  : 'border-transparent text-text-secondary-light hover:text-text-primary-light dark:text-text-secondary-dark dark:hover:text-text-primary-dark'
              }`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4" role="tabpanel">
        {tab === 'about' && (
          <div className="space-y-5">
            <div className="text-center">
              {c.kind === 'dm' ? (
                <Avatar name={c.name} src={c.avatarUrl} size={72} className="mx-auto" presence={c.presence} />
              ) : (
                <span className="mx-auto grid h-[72px] w-[72px] place-items-center rounded-2xl bg-slate-100 text-2xl font-bold text-slate-500 dark:bg-gray-700/60 dark:text-slate-300">
                  #
                </span>
              )}
              <p className="mt-3 text-base font-semibold text-text-primary-light dark:text-text-primary-dark">{c.name}</p>
              {c.topic && (
                <p className="mt-1 text-sm leading-relaxed text-text-secondary-light dark:text-text-secondary-dark">{c.topic}</p>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[
                { icon: c.muted ? BellOff : Bell, label: c.muted ? 'Unmute' : 'Mute' },
                { icon: Star, label: c.starred ? 'Unstar' : 'Star' },
                { icon: LogOut, label: c.kind === 'dm' ? 'Block' : 'Leave' },
              ].map(({ icon: Icon, label }) => (
                <button
                  key={label}
                  className="flex flex-col items-center gap-1.5 rounded-xl border border-border-light bg-white px-2 py-3 text-[11px] font-medium text-text-secondary-light transition-colors duration-150 hover:bg-surface-light hover:text-text-primary-light dark:border-gray-700/50 dark:bg-gray-800/50 dark:text-text-secondary-dark dark:hover:bg-gray-700/50"
                >
                  <Icon size={16} /> {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {tab === 'members' && (
          <ul className="space-y-0.5">
            {members.map((m) => (
              <li key={m.id}>
                <button className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors duration-150 hover:bg-surface-light dark:hover:bg-surface-dark">
                  <Avatar name={m.name} src={m.avatarUrl} size={34} presence={m.presence} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
                      {m.name}
                    </span>
                    <span className="block truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">
                      {m.role}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {tab === 'files' && (
          <EmptyState
            icon={<FileText size={22} />}
            title="No files shared yet"
            hint="Files attached to messages in this conversation will collect here."
          />
        )}
      </div>
    </aside>
  );
};
