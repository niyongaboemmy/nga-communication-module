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
  email: string;
  presence: string;
}

/**
 * Highlight the part of a string the query matched.
 *
 * Worth the few lines: when six rows read "Aline Uwase" and you have typed an
 * address fragment, seeing *where* it matched is the difference between reading
 * the list and scanning it.
 */
const Highlight: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold text-blue-600 dark:text-blue-300">
        {text.slice(at, at + q.length)}
      </mark>
      {text.slice(at + q.length)}
    </>
  );
};

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

  /** Index of the keyboard-highlighted row in the results list. */
  const [cursor, setCursor] = useState(0);

  /* The Escape/Tab listener is bound once; this keeps ⌘↵ pointed at the
     current submit without re-binding the listener on every keystroke. */
  const submitRef = useRef<() => void>(() => {});

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => { firstFieldRef.current?.focus(); }, [mode]);

  // Escape closes, and focus is trapped: a modal you can tab out of behind the
  // overlay is a modal a keyboard user cannot use.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      // ⌘/Ctrl+↵ submits from anywhere, including the name and topic fields,
      // so filling the form never means hunting for the button.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitRef.current();
        return;
      }
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

  useEffect(() => { setCursor(0); }, [query, mode]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor, people]);

  /*
   * Display names are not unique, so work out which ones repeat *in this
   * result set* and show the address only for those. Showing everybody's email
   * all the time is noise; showing it exactly where the list is ambiguous is
   * the whole fix.
   */
  const ambiguous = useMemo(() => {
    const seen = new Map<string, number>();
    for (const p of people) seen.set(p.name, (seen.get(p.name) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([n]) => n));
  }, [people]);

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

  submitRef.current = () => { void submit(); };

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
              placeholder={mode === 'dm' ? 'Search by name or email' : 'Add people by name or email'}
              aria-label="Search people"
              role="combobox"
              aria-expanded={people.length > 0}
              aria-controls="directory-results"
              aria-activedescendant={people[cursor] ? `person-${people[cursor].id}` : undefined}
              autoComplete="off"
              /*
               * The list is navigable without leaving the box. Typing then
               * reaching for the mouse to pick the third of six identical rows
               * is the slow path; ↑/↓/Enter is the one people actually use.
               */
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setCursor((c) => Math.min(c + 1, people.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setCursor((c) => Math.max(c - 1, 0));
                } else if (e.key === 'Enter' && people[cursor]) {
                  e.preventDefault();
                  const p = people[cursor]!;
                  if (mode === 'dm') setSelected([p]); else toggle(p);
                  // In multi-select the box clears so you can type the next
                  // name straight away, which is how you add five people.
                  if (mode !== 'dm') setQuery('');
                } else if (e.key === 'Backspace' && !query && selected.length) {
                  // Backspace on an empty box removes the last chip — the
                  // convention every recipient field uses.
                  setSelected((prev) => prev.slice(0, -1));
                }
              }}
              className="w-full rounded-lg border border-border-light bg-surface-light py-2 pl-9 pr-3 text-sm text-text-primary-light outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark/50 dark:bg-elevated-dark/60 dark:text-text-primary-dark"
            />
          </div>

          {selected.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {selected.map((p) => (
                <button
                  key={p.id}
                  onClick={() => toggle(p)}
                  aria-label={`Remove ${p.name}${ambiguous.has(p.name) ? ` (${p.email})` : ''}`}
                  title={p.email}
                  className="flex items-center gap-1 rounded-full bg-blue-50 px-2 py-1 text-xs text-blue-700 transition-colors hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50"
                >
                  <Avatar name={p.name} tintKey={p.id} src={p.avatarUrl ?? undefined} size={16} />
                  {p.name} <X size={11} />
                </button>
              ))}
            </div>
          )}

          {searching && people.length === 0 ? (
            <div className="grid place-items-center py-6"><Spinner /></div>
          ) : people.length === 0 ? (
            <p className="py-6 text-center text-xs text-text-secondary-light dark:text-text-secondary-dark">
              {query ? `Nobody matches “${query}” — try an email address.` : 'No one to show.'}
            </p>
          ) : (
            <ul ref={listRef} id="directory-results" role="listbox" aria-label="People" className="space-y-0.5">
              {people.map((p, i) => {
                const on = selected.some((s) => s.id === p.id);
                const active = i === cursor;
                // Only where the name repeats — see `ambiguous` above.
                const needsEmail = ambiguous.has(p.name);
                return (
                  <li key={p.id}>
                    <button
                      id={`person-${p.id}`}
                      role="option"
                      aria-selected={on}
                      data-active={active}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => (mode === 'dm' ? setSelected([p]) : toggle(p))}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 ${
                        on
                          ? 'bg-blue-50 dark:bg-blue-900/25'
                          : active
                            ? 'bg-surface-light dark:bg-surface-dark'
                            : 'hover:bg-surface-light dark:hover:bg-surface-dark'
                      }`}
                    >
                      <Avatar
                        name={p.name}
                        /* Keyed on the id, so two people with one name are two
                           colours rather than one. */
                        tintKey={p.id}
                        src={p.avatarUrl ?? undefined}
                        size={30}
                        presence={toPresence(p.presence)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-text-primary-light dark:text-text-primary-dark">
                          <Highlight text={p.name} query={query} />
                        </span>
                        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
                          <span className="shrink-0 capitalize">{p.role}</span>
                          {needsEmail && (
                            <>
                              <span aria-hidden="true" className="opacity-40">·</span>
                              <span className="truncate">
                                <Highlight text={p.email} query={query} />
                              </span>
                            </>
                          )}
                        </span>
                      </span>
                      {on && <Check size={15} className="shrink-0 text-blue-600 dark:text-blue-400" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-border-light px-4 py-3 dark:border-border-dark/30">
          {/* Says what will happen, so the button is not the only feedback. */}
          <p className="min-w-0 flex-1 truncate text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
            {mode === 'dm'
              ? (selected[0]
                ? `Opening a chat with ${selected[0].name}`
                : 'Pick someone — ↑ ↓ to move, ↵ to choose')
              : selected.length
                ? `${selected.length} ${selected.length === 1 ? 'person' : 'people'} added`
                : 'Nobody added yet'}
          </p>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {busy ? <Spinner className="h-4 w-4" /> : mode === 'dm' ? 'Open chat' : 'Create'}
          </Button>
        </footer>
      </div>
    </div>
  );
};
