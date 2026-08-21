import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search, Check, Hash, Megaphone, Users, Forward } from 'lucide-react';
import { Avatar, Button, IconButton, Spinner } from '../../components/ui';
import { useNotify } from '../../context/NotificationContext';
import { useChat } from './ChatProvider';
import { RichText } from './RichText';
import type { Message } from './types';

/**
 * Forward a message to one or more conversations (FR-MSG-10).
 *
 * The preview at the top is not decoration. Forwarding is the action people most
 * often perform on the wrong message — the hover toolbar is small and the rows
 * are dense — and in a school the cost of that mistake is a pupil's words landing
 * in a channel they were never meant for. Showing exactly what is about to be
 * sent, above the list of places it will go, is the cheapest possible guard.
 */

const KIND_ICON = { channel: Hash, announcement: Megaphone, group: Users } as const;

export const ForwardDialog: React.FC<{
  message: Message;
  onClose: () => void;
}> = ({ message, onClose }) => {
  const { conversations, forward, activeId } = useChat();
  const { notify } = useNotify();

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, input, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const targets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return conversations
      // Forwarding into the conversation it came from is a copy, not a forward.
      .filter((c) => c.id !== activeId && !c.isArchived)
      .filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [conversations, query, activeId]);

  const toggle = (id: string) => setSelected((prev) => (
    prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
  ));

  const submit = async () => {
    if (!selected.length || busy) return;
    setBusy(true);
    try {
      await forward(message.id, selected, comment.trim() || undefined);
      notify({
        title: `Forwarded to ${selected.length} ${selected.length === 1 ? 'conversation' : 'conversations'}`,
        tone: 'success',
        confirmation: true,
      });
      onClose();
    } catch (err) {
      notify({
        title: 'Could not forward that',
        body: err instanceof Error ? err.message : 'Something went wrong.',
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-90 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="forward-title"
        className="animate-panel-in-right relative flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border-light bg-white shadow-2xl dark:border-border-dark/40 dark:bg-chrome-dark"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border-light px-4 py-3 dark:border-border-dark/30">
          <h2 id="forward-title" className="flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
            <Forward size={15} /> Forward message
          </h2>
          <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
        </header>

        {/* What is actually about to be sent, and whose words they are. */}
        <div className="shrink-0 border-b border-border-light bg-surface-light px-4 py-3 dark:border-border-dark/30 dark:bg-elevated-dark/40">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light dark:text-text-secondary-dark">
            From {message.senderName}
          </p>
          <div className="max-h-24 overflow-y-auto text-sm text-text-primary-light dark:text-text-primary-dark">
            {message.body
              ? <RichText text={message.body} names={message.mentionNames} />
              : <span className="italic opacity-70">{message.attachments.length} attachment(s)</span>}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="relative mb-2">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary-light dark:text-text-secondary-dark" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
              className="w-full rounded-lg border border-border-light bg-surface-light py-2 pl-9 pr-3 text-sm text-text-primary-light outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark/50 dark:bg-elevated-dark/60 dark:text-text-primary-dark"
            />
          </div>

          {targets.length === 0 ? (
            <p className="py-6 text-center text-xs text-text-secondary-light dark:text-text-secondary-dark">
              {query ? `Nothing matches “${query}”.` : 'Nowhere else to forward this.'}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {targets.map((c) => {
                const on = selected.includes(c.id);
                const Icon = c.type === 'dm' ? null : KIND_ICON[c.type];
                return (
                  <li key={c.id}>
                    <button
                      onClick={() => toggle(c.id)}
                      aria-pressed={on}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 ${
                        on ? 'bg-blue-50 dark:bg-blue-900/25' : 'hover:bg-surface-light dark:hover:bg-surface-dark'
                      }`}
                    >
                      {c.type === 'dm' ? (
                        <Avatar name={c.name} src={c.avatarUrl ?? undefined} size={28} />
                      ) : (
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500 dark:bg-card-dark/60 dark:text-slate-300">
                          {Icon && <Icon size={14} />}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm text-text-primary-light dark:text-text-primary-dark">
                        {c.name}
                      </span>
                      {on && <Check size={15} className="shrink-0 text-blue-600 dark:text-blue-400" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            placeholder="Add a note (optional)"
            aria-label="Add a note"
            className="mt-3 w-full resize-none rounded-lg border border-border-light bg-surface-light px-3 py-2 text-sm text-text-primary-light outline-none focus:border-blue-500 dark:border-border-dark/50 dark:bg-elevated-dark/60 dark:text-text-primary-dark"
          />
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border-light px-4 py-3 dark:border-border-dark/30">
          <span className="text-xs text-text-secondary-light dark:text-text-secondary-dark">
            {selected.length ? `${selected.length} selected` : 'Choose at least one'}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={!selected.length || busy}>
              {busy ? <Spinner className="h-4 w-4" /> : 'Forward'}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
};
