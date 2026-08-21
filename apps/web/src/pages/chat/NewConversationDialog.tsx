import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Hash, Megaphone, Users, MessageSquare, Search, Check, Lock } from 'lucide-react';
import { Avatar, Button, IconButton, Spinner } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { useNotify } from '../../context/NotificationContext';
import { apiGet } from '../../lib/api';
import { useChat } from './ChatProvider';
import * as chatApi from './api';
import { toPresence } from './types';

/**
 * Start something new — a DM, a group, or a channel.
 *
 * One dialog for all three because the decision is genuinely one decision:
 * "who am I talking to, and how public is it". Splitting it into a "new
 * message" and a "new channel" entry point makes people pick before they know
 * which they want.
 */

interface Person {
  id: string;
  name: string;
  avatarUrl: string | null;
  role: string;
  presence: string;
}

type Mode = 'dm' | 'group' | 'channel';

export const NewConversationDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { can } = usePermissions();
  const { notify } = useNotify();
  const { setActiveId, refresh } = useChat();

  const canDm = can('DM_START');
  const canChannel = can('CHANNEL_CREATE');

  const [mode, setMode] = useState<Mode>(canDm ? 'dm' : 'channel');
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<Person[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Person[]>([]);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [announcement, setAnnouncement] = useState(false);
  const [busy, setBusy] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => { firstFieldRef.current?.focus(); }, [mode]);

  // Escape closes, and focus is trapped: a modal you can tab out of behind the
  // overlay is a modal a keyboard user cannot use.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])',
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

  // Debounced directory search — a request per keystroke would be a request per
  // keystroke.
  useEffect(() => {
    if (mode === 'channel') return;
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      apiGet<{ people: Person[] }>(`/api/chat/directory?q=${encodeURIComponent(query)}`)
        .then((r) => { if (!cancelled) setPeople(r.data!.people); })
        .catch(() => { if (!cancelled) setPeople([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, mode]);

  const toggle = (p: Person) => setSelected((prev) => (
    prev.some((s) => s.id === p.id) ? prev.filter((s) => s.id !== p.id) : [...prev, p]
  ));

  const canSubmit = useMemo(() => {
    if (busy) return false;
    if (mode === 'dm') return selected.length === 1;
    if (mode === 'group') return selected.length >= 1;
    return name.trim().length > 0;
  }, [mode, selected, name, busy]);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      let id: string;
      if (mode === 'dm') {
        id = (await chatApi.openDirect(selected[0]!.id)).id;
      } else if (mode === 'group') {
        id = (await chatApi.createConversation({
          type: 'group',
          name: name.trim() || selected.map((s) => s.name.split(' ')[0]).join(', '),
          memberIds: selected.map((s) => s.id),
        })).id;
      } else {
        id = (await chatApi.createConversation({
          type: announcement ? 'announcement' : 'channel',
          name: name.trim(), topic: topic.trim() || undefined,
          isPrivate, memberIds: selected.map((s) => s.id),
        })).id;
      }
      await refresh();
      setActiveId(id);
      onClose();
    } catch (err) {
      notify({
        title: 'Could not create that',
        body: err instanceof Error ? err.message : 'Something went wrong.',
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  const MODES: Array<{ id: Mode; label: string; icon: typeof Hash; show: boolean }> = [
    { id: 'dm', label: 'Direct message', icon: MessageSquare, show: canDm },
    { id: 'group', label: 'Group', icon: Users, show: canChannel },
    { id: 'channel', label: 'Channel', icon: Hash, show: canChannel },
  ];

  return (
    <div className="fixed inset-0 z-90 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-conversation-title"
        className="animate-panel-in-right relative flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border-light bg-white shadow-2xl dark:border-border-dark/40 dark:bg-chrome-dark"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border-light px-4 py-3 dark:border-border-dark/30">
          <h2 id="new-conversation-title" className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
            New conversation
          </h2>
          <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
        </header>

        <div className="flex shrink-0 gap-1 border-b border-border-light px-3 py-2 dark:border-border-dark/30" role="tablist">
          {MODES.filter((m) => m.show).map((m) => (
            <button
              key={m.id}
              role="tab"
              aria-selected={mode === m.id}
              onClick={() => setMode(m.id)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors duration-150 ${
                mode === m.id
                  ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                  : 'text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-surface-dark'
              }`}
            >
              <m.icon size={14} /> {m.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {mode !== 'dm' && (
            <div className="mb-3 space-y-2">
              <input
                ref={firstFieldRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={mode === 'channel' ? 'e.g. senior-4-science' : 'Group name (optional)'}
                aria-label="Name"
                className="w-full rounded-lg border border-border-light bg-surface-light px-3 py-2 text-sm text-text-primary-light outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark/50 dark:bg-elevated-dark/60 dark:text-text-primary-dark"
              />
              {mode === 'channel' && (
                <>
                  <input
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="What is this channel for?"
                    aria-label="Topic"
                    className="w-full rounded-lg border border-border-light bg-surface-light px-3 py-2 text-sm text-text-primary-light outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark/50 dark:bg-elevated-dark/60 dark:text-text-primary-dark"
                  />
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                    <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} className="accent-blue-600" />
                    <Lock size={12} /> Private — only invited people can find it
                  </label>
                  {can('CHANNEL_ANNOUNCE') && (
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                      <input type="checkbox" checked={announcement} onChange={(e) => setAnnouncement(e.target.checked)} className="accent-blue-600" />
                      <Megaphone size={12} /> Announcement — most members can read but not post
                    </label>
                  )}
                </>
              )}
            </div>
          )}

          <div className="relative mb-2">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary-light dark:text-text-secondary-dark" />
            <input
              ref={mode === 'dm' ? firstFieldRef : undefined}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={mode === 'dm' ? 'Search people' : 'Add people'}
              aria-label="Search people"
              className="w-full rounded-lg border border-border-light bg-surface-light py-2 pl-9 pr-3 text-sm text-text-primary-light outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark/50 dark:bg-elevated-dark/60 dark:text-text-primary-dark"
            />
          </div>

          {selected.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {selected.map((p) => (
                <button
                  key={p.id}
                  onClick={() => toggle(p)}
                  className="flex items-center gap-1 rounded-full bg-blue-50 px-2 py-1 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                >
                  {p.name} <X size={11} />
                </button>
              ))}
            </div>
          )}

          {searching && people.length === 0 ? (
            <div className="grid place-items-center py-6"><Spinner /></div>
          ) : people.length === 0 ? (
            <p className="py-6 text-center text-xs text-text-secondary-light dark:text-text-secondary-dark">
              {query ? 'Nobody matches that name.' : 'No one to show.'}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {people.map((p) => {
                const on = selected.some((s) => s.id === p.id);
                return (
                  <li key={p.id}>
                    <button
                      onClick={() => (mode === 'dm' ? setSelected([p]) : toggle(p))}
                      aria-pressed={on}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 ${
                        on ? 'bg-blue-50 dark:bg-blue-900/25' : 'hover:bg-surface-light dark:hover:bg-surface-dark'
                      }`}
                    >
                      <Avatar name={p.name} src={p.avatarUrl ?? undefined} size={30} presence={toPresence(p.presence)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-text-primary-light dark:text-text-primary-dark">{p.name}</span>
                        <span className="block truncate text-[11px] capitalize text-text-secondary-light dark:text-text-secondary-dark">{p.role}</span>
                      </span>
                      {on && <Check size={15} className="shrink-0 text-blue-600 dark:text-blue-400" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border-light px-4 py-3 dark:border-border-dark/30">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {busy ? <Spinner className="h-4 w-4" /> : mode === 'dm' ? 'Open chat' : 'Create'}
          </Button>
        </footer>
      </div>
    </div>
  );
};
