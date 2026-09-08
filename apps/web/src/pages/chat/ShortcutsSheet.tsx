import React, { useEffect } from 'react';
import { X, Keyboard } from 'lucide-react';
import { IconButton } from '../../components/ui';

/**
 * The keyboard shortcut reference (UX-4).
 *
 * Every shortcut listed here has a visible control too. A shortcut sheet is a
 * way to go faster, never the only way to reach something — otherwise the
 * feature is hidden from everyone who has not opened this dialog.
 *
 * And every shortcut listed here is **bound**. Two of them were not: `↑` to
 * edit and `⇧Esc` to mark everything read were documented for a phase before
 * they existed. A reference that lies is worse than a shorter one, because
 * people stop trusting the rest of it.
 */

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

const GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: 'Getting around',
    items: [
      [`${MOD} K`, 'Search everything — messages, people, mail, posts, meetings'],
      [`${MOD} ⇧ K`, 'Chat actions'],
      [`${MOD} F`, 'Search messages'],
      [`${MOD} ⇧ S`, 'Saved items'],
      ['Esc', 'Close the open panel'],
    ],
  },
  {
    title: 'Writing',
    items: [
      ['Enter', 'Send (or a new line, if you turned that off)'],
      ['⇧ Enter', 'New line'],
      [`${MOD} Enter`, 'Send, whatever Enter is set to do'],
      ['@', 'Mention someone'],
      ['/', 'Slash command'],
      ['↑', 'Edit your last message (with the box empty)'],
    ],
  },
  {
    title: 'Reading',
    items: [
      ['Esc', 'Mark the conversation read and return to the bottom'],
      ['⇧ Esc', 'Mark everything read'],
    ],
  },
];

export const ShortcutsSheet: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-100 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="animate-fade-in relative max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border-light bg-white p-4 shadow-2xl dark:border-border-dark/40 dark:bg-chrome-dark"
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
            <Keyboard size={15} /> Keyboard shortcuts
          </h2>
          <IconButton label="Close shortcuts" onClick={onClose}><X size={18} /></IconButton>
        </header>

        <div className="space-y-4">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
                {group.title}
              </h3>
              <dl className="space-y-1">
                {group.items.map(([keys, what]) => (
                  <div key={keys + what} className="flex items-baseline gap-3">
                    <dt className="w-24 shrink-0 text-right">
                      <kbd className="rounded border border-border-light bg-surface-light px-1.5 py-0.5 font-sans text-[11px] font-semibold text-text-primary-light dark:border-border-dark dark:bg-elevated-dark dark:text-text-primary-dark">
                        {keys}
                      </kbd>
                    </dt>
                    <dd className="text-xs text-text-secondary-light dark:text-text-secondary-dark">
                      {what}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
};
