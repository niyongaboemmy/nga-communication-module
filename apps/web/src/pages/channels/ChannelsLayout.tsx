import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Hash, Loader2, Plus, Search, X, BookOpen } from 'lucide-react';
import type { ConversationSummary, SubjectSummary } from '@tupo/shared';
import { EmptyState } from '../../components/ui';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { useChat } from '../chat/ChatProvider';
import { MessageThread } from '../chat/MessageThread';
import { Composer } from '../chat/Composer';
import { ThreadPanel } from '../chat/ThreadPanel';
import { ContextPanel } from '../chat/ContextPanel';
import { ChannelSettings } from '../chat/ChannelSettings';
import { SearchPanel } from '../chat/SearchPanel';
import * as chatApi from '../chat/api';
import type { Member } from '../chat/types';

/**
 * Channels: a Slack-style home for every subject, separate from Chat.
 *
 * Left, the subjects you teach or take (from the NGA MIS, refreshed at each
 * sign-in), each with its channels and unread counts; teachers can add a
 * channel. Right, the channel itself -- the same thread, composer, files,
 * threads and pins as Chat, because a subject channel is a chat conversation
 * underneath. The conversations come from the app-wide chat store; this page
 * shows only those with a subject.
 */

type Panel = 'none' | 'thread' | 'details' | 'channel' | 'search';

const HUES = [211, 262, 340, 24, 152, 190, 45, 288];
const hueFor = (id: string) => HUES[[...id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % HUES.length]!;
const COLLAPSE_KEY = 'tupo.channels.collapsed';

const SubjectBadge: React.FC<{ subject: { id: string; name: string; code: string | null }; size?: number }> = ({ subject, size = 28 }) => {
  const hue = hueFor(subject.id);
  // Initials of the subject's main words ("Development of Web User Interface" -> "DW"):
  // codes share prefixes (SPE...), names do not.
  const words = subject.name.split(/\s+/).filter((w) => w && !/^(of|and|the|using|to|for|in|&)$/i.test(w));
  const label = (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? subject.name).slice(0, 2)).toUpperCase();
  return (
    <span
      className="grid shrink-0 place-items-center rounded-lg text-[11px] font-bold"
      style={{ width: size, height: size, backgroundColor: `hsl(${hue} 85% 92%)`, color: `hsl(${hue} 65% 32%)` }}
      aria-hidden
    >
      {label}
    </span>
  );
};

const SidePanel: React.FC<{ wide?: boolean; onDismiss: () => void; children: React.ReactNode }> = ({ wide, onDismiss, children }) => (
  <>
    <div className="fixed inset-0 z-70 bg-black/40 xl:hidden" onClick={onDismiss} aria-hidden="true" />
    <div className={`animate-panel-in-right fixed inset-y-0 right-0 z-80 max-w-[90vw] xl:static xl:z-auto ${wide ? 'w-96' : 'w-80'}`}>
      {children}
    </div>
  </>
);

/* ── Create a channel ────────────────────────────────────────────────────── */

const CreateChannelDialog: React.FC<{
  subject: SubjectSummary; onClose: () => void; onCreated: (c: ConversationSummary) => void;
}> = ({ subject, onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = name.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clean || busy) return;
    setBusy(true); setError(null);
    try {
      onCreated(await chatApi.createSubjectChannel(subject.id, { name: clean, topic: topic.trim() || undefined }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the channel.');
      setBusy(false);
    }
  };

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-label="Create a channel"
        className="w-full max-w-md animate-pop overflow-hidden rounded-2xl border border-border-light bg-white shadow-2xl dark:border-border-dark/50 dark:bg-elevated-dark" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-6 pt-5">
          <div>
            <h2 className="text-lg font-bold text-text-primary-light dark:text-text-primary-dark">Create a channel</h2>
            <p className="mt-0.5 flex items-center gap-1.5 text-sm text-text-secondary-light dark:text-text-secondary-dark">
              <SubjectBadge subject={subject} size={18} /> in {subject.name}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-text-secondary-light hover:bg-surface-light dark:hover:bg-card-dark"><X size={18} /></button>
        </div>
        <div className="space-y-4 px-6 py-5">
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">Name</span>
            <span className="flex items-center rounded-lg border border-border-light focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 dark:border-border-dark/60">
              <Hash size={16} className="ml-3 text-text-secondary-light dark:text-text-secondary-dark" />
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} placeholder="e.g. homework"
                className="w-full bg-transparent px-2 py-2.5 text-sm text-text-primary-light outline-none dark:text-text-primary-dark" />
            </span>
            <span className="mt-1.5 block text-xs text-text-secondary-light dark:text-text-secondary-dark">
              Everyone in {subject.name} will be in it. Lowercase, no spaces.
            </span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
              Topic <span className="font-normal text-text-secondary-light dark:text-text-secondary-dark">(optional)</span>
            </span>
            <input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={120} placeholder="What is this channel for?"
              className="w-full rounded-lg border border-border-light bg-transparent px-3 py-2.5 text-sm text-text-primary-light outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark/60 dark:text-text-primary-dark" />
          </label>
          {error && <p className="text-sm font-medium text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border-light px-6 py-3.5 dark:border-border-dark/40">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-semibold text-text-primary-light hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-card-dark">Cancel</button>
          <button type="submit" disabled={!clean || busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
            {busy && <Loader2 size={14} className="animate-spin" />} Create
          </button>
        </div>
      </form>
    </div>
  );
};

/* ── The sidebar ─────────────────────────────────────────────────────────── */

const ChannelSidebar: React.FC<{
  subjects: SubjectSummary[] | null;
  channels: ConversationSummary[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onCreate: (s: SubjectSummary) => void;
  error: boolean;
  onRetry: () => void;
}> = ({ subjects, channels, activeId, onOpen, onCreate, error, onRetry }) => {
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]') as string[]); } catch { return new Set(); }
  });
  const toggle = (id: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next])); } catch { /* not remembered */ }
    return next;
  });

  const term = q.trim().toLowerCase();
  const groups = useMemo(() => (subjects ?? []).map((s) => {
    const own = channels
      .filter((c) => c.subjectId === s.id)
      .sort((a, b) => (a.name === 'general' ? -1 : b.name === 'general' ? 1 : a.name.localeCompare(b.name)));
    const subjectMatch = !term || s.name.toLowerCase().includes(term) || (s.code ?? '').toLowerCase().includes(term);
    const shown = subjectMatch ? own : own.filter((c) => c.name.toLowerCase().includes(term));
    return { subject: s, channels: shown, unread: own.reduce((n, c) => n + c.unread, 0), visible: subjectMatch || shown.length > 0 };
  }).filter((g) => g.visible), [subjects, channels, term]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-chrome-dark">
      <div className="px-4 pb-3 pt-4">
        <h1 className="text-lg font-bold text-text-primary-light dark:text-text-primary-dark">Channels</h1>
        <p className="text-xs text-text-secondary-light dark:text-text-secondary-dark">Your subjects and their channels</p>
        <label className="relative mt-3 block">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary-light dark:text-text-secondary-dark" />
          <span className="sr-only">Find a subject or channel</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a subject or channel"
            className="w-full rounded-lg border border-border-light bg-surface-light py-2 pl-9 pr-3 text-sm outline-none focus:border-blue-500 dark:border-border-dark/50 dark:bg-card-dark/50 dark:text-text-primary-dark" />
        </label>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4" aria-label="Subjects and channels">
        {subjects === null && !error && <div className="grid place-items-center py-10"><Loader2 className="animate-spin text-text-secondary-light" /></div>}
        {error && subjects === null && (
          <p className="px-3 py-8 text-center text-sm text-text-secondary-light dark:text-text-secondary-dark">
            Couldn't load your subjects. <button onClick={onRetry} className="font-medium text-blue-600 hover:underline dark:text-blue-400">Try again</button>
          </p>
        )}
        {subjects?.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-text-secondary-light dark:text-text-secondary-dark">
            You have no subjects yet. They come from NGA MIS and appear here after you next sign in.
          </p>
        )}
        {subjects && subjects.length > 0 && groups.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-text-secondary-light dark:text-text-secondary-dark">Nothing matches “{q}”.</p>
        )}

        {groups.map(({ subject, channels: list, unread }) => {
          const isCollapsed = collapsed.has(subject.id) && !term;
          const listId = `subject-${subject.id}`;
          return (
            <section key={subject.id} className="mb-1">
              <div className="group flex items-center rounded-lg pr-1 hover:bg-surface-light dark:hover:bg-card-dark/50">
                <button onClick={() => toggle(subject.id)} aria-expanded={!isCollapsed} aria-controls={listId}
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-2 text-left">
                  <SubjectBadge subject={subject} />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 block text-sm font-semibold leading-snug text-text-primary-light dark:text-text-primary-dark" title={subject.name}>{subject.name}</span>
                    <span className="block truncate text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
                      {subject.code ? `${subject.code} · ` : ''}{subject.myRole === 'teacher' ? 'Teaching' : 'Enrolled'}
                    </span>
                  </span>
                  {isCollapsed && unread > 0 && (
                    <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{unread}</span>
                  )}
                  <ChevronDown size={15} className={`shrink-0 text-text-secondary-light transition-transform dark:text-text-secondary-dark ${isCollapsed ? '-rotate-90' : ''}`} />
                </button>
                {subject.canCreateChannels && (
                  <button onClick={() => onCreate(subject)} aria-label={`Add a channel to ${subject.name}`} title="Add a channel"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-secondary-light opacity-0 transition hover:bg-border-light focus:opacity-100 group-hover:opacity-100 dark:text-text-secondary-dark dark:hover:bg-border-dark/40">
                    <Plus size={15} />
                  </button>
                )}
              </div>

              {!isCollapsed && (
                <ul id={listId} className="mb-1 ml-5 border-l border-border-light pl-2 dark:border-border-dark/40">
                  {list.map((c) => {
                    const active = c.id === activeId;
                    const hasUnread = c.unread > 0;
                    return (
                      <li key={c.id}>
                        <button onClick={() => onOpen(c.id)} aria-current={active ? 'page' : undefined}
                          className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                            active
                              ? 'bg-blue-600 text-white'
                              : hasUnread
                                ? 'font-semibold text-text-primary-light hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-card-dark/50'
                                : 'text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-card-dark/50'
                          }`}>
                          <Hash size={15} className={`shrink-0 ${active ? 'opacity-90' : 'opacity-60'}`} />
                          <span className="min-w-0 flex-1 truncate">{c.name}</span>
                          {c.unreadMentions > 0 ? (
                            <span className={`rounded-full px-1.5 text-[10px] font-bold ${active ? 'bg-white text-blue-600' : 'bg-red-500 text-white'}`}>@{c.unreadMentions}</span>
                          ) : hasUnread && !active ? (
                            <span className="rounded-full bg-blue-600 px-1.5 text-[10px] font-bold text-white">{c.unread}</span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                  {list.length === 0 && <li className="px-2 py-1.5 text-xs text-text-secondary-light dark:text-text-secondary-dark">No channels yet.</li>}
                  {subject.canCreateChannels && (
                    <li>
                      <button onClick={() => onCreate(subject)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-text-secondary-light hover:bg-surface-light hover:text-text-primary-light dark:text-text-secondary-dark dark:hover:bg-card-dark/50">
                        <Plus size={15} className="opacity-70" /> Add channel
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </section>
          );
        })}
      </nav>
    </div>
  );
};

/* ── The page ────────────────────────────────────────────────────────────── */

const ChannelsWorkspace: React.FC = () => {
  const { conversations, conversationsLoading, activeId, setActiveId, active: activeAny, threadRootId, openThread, refresh } = useChat();
  const channels = useMemo(() => conversations.filter((c) => c.subjectId), [conversations]);
  const active = activeAny?.subjectId ? activeAny : null;

  const [subjects, setSubjects] = useState<SubjectSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [creating, setCreating] = useState<SubjectSummary | null>(null);
  const [panel, setPanel] = useState<Panel>('none');
  const [members, setMembers] = useState<Member[]>([]);
  const [membersVersion, setMembersVersion] = useState(0);

  const loadSubjects = useCallback(() => {
    setError(false);
    chatApi.listSubjects().then(setSubjects).catch(() => setError(true));
  }, []);
  useEffect(() => { loadSubjects(); }, [loadSubjects]);

  // Opening the page: keep a subject channel that was already open, else open
  // the first one on a wide screen (a phone stays on the list).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || conversationsLoading) return;
    opened.current = true;
    if (active) return;
    const first = channels[0];
    if (first && window.matchMedia('(min-width: 768px)').matches) setActiveId(first.id);
    else if (activeAny) setActiveId(null);
  }, [conversationsLoading, channels, active, activeAny, setActiveId]);

  useEffect(() => {
    if (threadRootId) setPanel('thread');
    else setPanel((p) => (p === 'thread' ? 'none' : p));
  }, [threadRootId]);

  const closePanel = useCallback(() => {
    if (threadRootId) openThread(null);
    setPanel('none');
  }, [threadRootId, openThread]);

  useEffect(() => {
    if (!active || (panel !== 'details' && panel !== 'channel')) return;
    let cancelled = false;
    chatApi.listMembers(active.id).then((m) => { if (!cancelled) setMembers(m); }).catch(() => { if (!cancelled) setMembers([]); });
    return () => { cancelled = true; };
  }, [active, panel, membersVersion]);

  const onCreated = async (c: ConversationSummary) => {
    setCreating(null);
    await refresh();
    setActiveId(c.id);
  };

  const showListOnMobile = active === null;
  const subjectOf = active ? subjects?.find((s) => s.id === active.subjectId) : undefined;

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className={`w-full min-w-0 shrink-0 border-r border-border-light md:w-72 lg:w-80 dark:border-border-dark/30 ${showListOnMobile ? 'flex' : 'hidden md:flex'}`}>
        <div className="w-full min-w-0">
          <ChannelSidebar
            subjects={subjects}
            channels={channels}
            activeId={active?.id ?? null}
            onOpen={(id) => { setPanel('none'); setActiveId(id); }}
            onCreate={setCreating}
            error={error}
            onRetry={loadSubjects}
          />
        </div>
      </div>

      {active ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {subjectOf && (
            <div className="flex items-center gap-2 border-b border-border-light bg-surface-light/60 px-4 py-1.5 text-xs text-text-secondary-light dark:border-border-dark/30 dark:bg-card-dark/30 dark:text-text-secondary-dark">
              <BookOpen size={13} /> {subjectOf.name}{subjectOf.code ? ` · ${subjectOf.code}` : ''}
            </div>
          )}
          <MessageThread
            conversation={active}
            onBack={() => setActiveId(null)}
            onToggleContext={() => setPanel((p) => (p === 'details' ? 'none' : 'details'))}
            contextOpen={panel === 'details'}
            onOpenSearch={() => setPanel('search')}
            onOpenChannelSettings={() => setPanel('channel')}
          >
            <Composer conversation={active} onOpenPanel={(p) => { if (p === 'search') setPanel('search'); }} />
          </MessageThread>
        </div>
      ) : (
        <div className="hidden min-h-0 min-w-0 flex-1 place-items-center bg-surface-light md:grid dark:bg-background-dark">
          <EmptyState
            icon={<Hash size={22} />}
            title={conversationsLoading || subjects === null ? 'Loading your channels' : 'Pick a channel'}
            hint={subjects?.length === 0 ? 'Your subjects will appear here once NGA MIS lists them for you.' : 'Choose a subject channel on the left to start reading.'}
          />
        </div>
      )}

      {panel === 'thread' && active && (
        <SidePanel wide onDismiss={closePanel}><ThreadPanel conversation={active} /></SidePanel>
      )}
      {panel === 'details' && active && (
        <SidePanel onDismiss={closePanel}>
          <ContextPanel conversation={active} members={members} onClose={closePanel} onOpenSettings={() => setPanel('channel')} />
        </SidePanel>
      )}
      {panel === 'search' && (
        <SidePanel wide onDismiss={closePanel}><SearchPanel onClose={closePanel} scopedConversationId={active?.id ?? null} /></SidePanel>
      )}
      {panel === 'channel' && active && (
        <SidePanel wide onDismiss={closePanel}>
          <ChannelSettings conversation={active} members={members} onMembersChanged={() => setMembersVersion((v) => v + 1)} onClose={closePanel} />
        </SidePanel>
      )}

      {creating && <CreateChannelDialog subject={creating} onClose={() => setCreating(null)} onCreated={(c) => void onCreated(c)} />}
    </div>
  );
};

export const ChannelsLayout: React.FC = () => (
  <ErrorBoundary label="channels">
    <ChannelsWorkspace />
  </ErrorBoundary>
);
