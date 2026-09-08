import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  Search, MessageSquare, Hash, Users, Mail, Newspaper, LayoutGrid, Video, FileText,
  CornerDownLeft, Loader2, X, ArrowRight, Compass,
} from 'lucide-react';
import { Avatar, Skeleton } from './ui';
import { Highlighted } from './Highlighted';
import { apiGet } from '../lib/api';
import { usePermissions } from '../hooks/usePermissions';
import { shortStamp } from '../pages/chat/data';

/**
 * One search box for the whole product (⌘K).
 *
 * The server decides what a person may find — every section is scoped by the
 * same rule its own module enforces, so this component can render whatever it
 * is handed. What it must get right is the other half: making a federated
 * result list feel like one list. Hence a single flat cursor that runs through
 * every section in order, rather than per-section focus traps, and one Enter
 * that always opens the highlighted row wherever it came from.
 *
 * With no query it is a launcher rather than an empty box: the destinations the
 * viewer can actually reach, which is also the answer to "search in all pages".
 */

type SectionKey =
  | 'message' | 'conversation' | 'channel' | 'person'
  | 'mail' | 'post' | 'page' | 'meeting' | 'file';

interface SearchResult {
  id: string;
  type: SectionKey;
  title: string;
  subtitle?: string;
  meta?: string;
  href: string;
  avatarName?: string;
  avatarUrl?: string | null;
  at?: string | null;
}

interface SearchResponse {
  query: string;
  results: Partial<Record<SectionKey, SearchResult[]>>;
  total?: number;
  failedSections?: SectionKey[];
  tookMs?: number;
}

/** Order is the order they appear in the palette: conversation-shaped things
 *  first, because that is what people search for most. */
const SECTIONS: Array<{ key: SectionKey; label: string; icon: typeof Search }> = [
  { key: 'message', label: 'Messages', icon: MessageSquare },
  { key: 'conversation', label: 'Conversations', icon: Hash },
  { key: 'person', label: 'People', icon: Users },
  { key: 'mail', label: 'Mail', icon: Mail },
  { key: 'post', label: 'Feed posts', icon: Newspaper },
  { key: 'page', label: 'Pages', icon: LayoutGrid },
  { key: 'meeting', label: 'Meetings', icon: Video },
  { key: 'file', label: 'Files', icon: FileText },
  { key: 'channel', label: 'Channels you can join', icon: Compass },
];

/** Where you can go. Each carries the permission that gates the route itself,
 *  so the launcher never offers a page that would bounce you. */
const DESTINATIONS: Array<{ label: string; hint: string; href: string; icon: typeof Search; perm?: string[] }> = [
  { label: 'Chat', hint: 'Conversations, channels and groups', href: '/app/chat', icon: MessageSquare },
  { label: 'Feed', hint: 'Announcements and pages', href: '/app/feed', icon: Newspaper, perm: ['FEED_VIEW'] },
  { label: 'Saved posts', hint: 'Everything you bookmarked', href: '/app/feed/saved', icon: Newspaper, perm: ['FEED_VIEW'] },
  { label: 'Pages', hint: 'Browse and follow pages', href: '/app/feed/pages', icon: LayoutGrid, perm: ['FEED_VIEW'] },
  { label: 'Mail', hint: 'Your mailbox', href: '/app/mail', icon: Mail, perm: ['MAIL_READ'] },
  { label: 'Meet', hint: 'Start or join a meeting', href: '/app/meet', icon: Video, perm: ['MEET_JOIN'] },
  { label: 'Meeting history', hint: 'Past meetings and their notes', href: '/app/meet/history', icon: Video, perm: ['MEET_JOIN'] },
  { label: 'Moderation queue', hint: 'Reported posts and comments', href: '/app/feed/moderation', icon: LayoutGrid, perm: ['MODERATION_QUEUE_VIEW'] },
  { label: 'People', hint: 'Manage accounts', href: '/app/admin/users', icon: Users, perm: ['USERS_VIEW', 'USERS_MANAGE'] },
  { label: 'Roles and permissions', hint: 'Who can do what', href: '/app/admin/roles', icon: Users, perm: ['ROLES_PERMISSIONS_VIEW', 'ROLES_PERMISSIONS_MANAGE'] },
  { label: 'Audit log', hint: 'What happened, and who did it', href: '/app/admin/audit', icon: FileText, perm: ['AUDIT_VIEW'] },
  { label: 'System status', hint: 'Services and health', href: '/app/system', icon: FileText, perm: ['SYSTEM_HEALTH_VIEW'] },
];

const ICON_FOR: Record<SectionKey, typeof Search> = {
  message: MessageSquare, conversation: Hash, channel: Compass, person: Users,
  mail: Mail, post: Newspaper, page: LayoutGrid, meeting: Video, file: FileText,
};

export const GlobalSearch: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const [query, setQuery] = useState('');
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<SectionKey | null>(null);
  /*
   * Which sections this query can offer, remembered from the *unfiltered*
   * response. Deriving the chips from the current response instead meant that
   * picking one collapsed the row to that single section — taking the
   * "Everything" chip with it, so there was no way back out of a filter.
   */
  const [available, setAvailable] = useState<SectionKey[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const term = query.trim();
  const searching = term.length >= 2;

  const destinations = useMemo(
    () => DESTINATIONS.filter((d) => !d.perm || can(d.perm)),
    [can],
  );

  /* Debounced fetch. 220ms is long enough that typing a word is one request
     and short enough that the list feels like it is keeping up. */
  useEffect(() => {
    if (!searching) { setData(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      const params = new URLSearchParams({ q: term, limit: '5' });
      if (filter) params.set('types', filter);
      apiGet<SearchResponse>(`/api/search?${params.toString()}`)
        .then((r) => {
          if (cancelled) return;
          setData(r.data ?? null);
          if (!filter) {
            setAvailable(SECTIONS
              .map((s) => s.key)
              .filter((k) => (r.data?.results?.[k] ?? []).length > 0));
          }
        })
        .catch(() => { if (!cancelled) setData(null); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [term, filter, searching]);

  /* One flat list across every section — the cursor does not care which
     section a row came from, because neither does the person pressing Down. */
  const rows = useMemo(() => {
    if (!searching) {
      return destinations.map((d) => ({
        key: `dest:${d.href}`,
        href: d.href,
        render: 'destination' as const,
        destination: d,
      }));
    }
    const out: Array<{
      key: string; href: string; render: 'result'; result: SearchResult; section: SectionKey;
    }> = [];
    for (const section of SECTIONS) {
      for (const r of data?.results?.[section.key] ?? []) {
        out.push({ key: r.id, href: r.href, render: 'result', result: r, section: section.key });
      }
    }
    return out;
  }, [searching, destinations, data]);

  useEffect(() => { setActive(0); }, [term, filter]);
  // A new query starts from a clean slate — a filter left over from the last
  // one silently hides most of what was just typed.
  useEffect(() => { setFilter(null); setAvailable([]); }, [term]);

  const choose = useCallback((href: string) => {
    navigate(href);
    onClose();
  }, [navigate, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (!rows.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % rows.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + rows.length) % rows.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const row = rows[active];
        if (row) choose(row.href);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rows, active, choose, onClose]);

  // Keep the highlighted row on screen when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const sectionsWithHits = SECTIONS.filter((s) => available.includes(s.key));
  let cursor = -1; // running index so each row knows its place in the flat list

  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-start justify-center p-4 pt-[10vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Search Tupo"
    >
      <button
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/50 backdrop-blur-sm"
      />

      <div className="animate-fade-in relative flex max-h-[78vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border-light bg-white shadow-2xl dark:border-border-dark/40 dark:bg-chrome-dark">
        {/* Input */}
        <div className="flex shrink-0 items-center gap-2.5 border-b border-border-light px-4 dark:border-border-dark/30">
          {loading
            ? <Loader2 size={17} className="shrink-0 animate-spin text-blue-500" />
            : <Search size={17} className="shrink-0 text-text-secondary-light dark:text-text-secondary-dark" />}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages, people, mail, posts, meetings and files"
            aria-label="Search Tupo"
            className="min-w-0 flex-1 bg-transparent py-3.5 text-sm text-text-primary-light outline-none placeholder:text-text-secondary-light/70 dark:text-text-primary-dark dark:placeholder:text-text-secondary-dark/60"
          />
          {query && (
            <button
              onClick={() => { setQuery(''); inputRef.current?.focus(); }}
              aria-label="Clear search"
              className="shrink-0 rounded-lg p-1 text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-surface-dark"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Filter chips — only the sections that actually returned something,
            so this never offers a filter that empties the list. */}
        {searching && sectionsWithHits.length > 1 && (
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border-light px-3 py-2 dark:border-border-dark/30">
            <button
              onClick={() => setFilter(null)}
              aria-pressed={filter === null}
              className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                filter === null
                  ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                  : 'text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-surface-dark'
              }`}
            >
              Everything
            </button>
            {sectionsWithHits.map((s) => (
              <button
                key={s.key}
                onClick={() => setFilter((f) => (f === s.key ? null : s.key))}
                aria-pressed={filter === s.key}
                className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  filter === s.key
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                    : 'text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-surface-dark'
                }`}
              >
                <s.icon size={11} /> {s.label}
              </button>
            ))}
          </div>
        )}

        {/* Results */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          {!searching ? (
            <>
              <p className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
                Go to
              </p>
              <ul role="listbox" aria-label="Destinations">
                {destinations.map((d) => {
                  cursor += 1;
                  const isActive = cursor === active;
                  const idx = cursor;
                  return (
                    <li key={d.href} role="option" aria-selected={isActive}>
                      <button
                        data-active={isActive}
                        onMouseEnter={() => setActive(idx)}
                        onClick={() => choose(d.href)}
                        className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors ${
                          isActive ? 'bg-blue-50 dark:bg-blue-900/30' : 'hover:bg-surface-light dark:hover:bg-surface-dark'
                        }`}
                      >
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-light text-text-secondary-light dark:bg-card-dark/60 dark:text-text-secondary-dark">
                          <d.icon size={15} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
                            {d.label}
                          </span>
                          <span className="block truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">
                            {d.hint}
                          </span>
                        </span>
                        {isActive && <ArrowRight size={14} className="shrink-0 text-blue-500" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : loading && !data ? (
            <div className="space-y-2 p-1" aria-busy="true">
              {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
            </div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
                Nothing matches “{term}”
              </p>
              <p className="mt-1 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                Only things you have access to are searched.
              </p>
            </div>
          ) : (
            SECTIONS.map((section) => {
              const hits = (data?.results?.[section.key] ?? []);
              if (!hits.length) return null;
              return (
                <div key={section.key} className="mb-1">
                  <p className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
                    <section.icon size={11} /> {section.label}
                  </p>
                  <ul role="listbox" aria-label={section.label}>
                    {hits.map((r) => {
                      cursor += 1;
                      const isActive = cursor === active;
                      const idx = cursor;
                      const Icon = ICON_FOR[r.type];
                      return (
                        <li key={r.id} role="option" aria-selected={isActive}>
                          <button
                            data-active={isActive}
                            onMouseEnter={() => setActive(idx)}
                            onClick={() => choose(r.href)}
                            className={`flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-left transition-colors ${
                              isActive ? 'bg-blue-50 dark:bg-blue-900/30' : 'hover:bg-surface-light dark:hover:bg-surface-dark'
                            }`}
                          >
                            {r.type === 'person' || r.type === 'message' ? (
                              <Avatar
                                name={r.avatarName ?? r.title}
                                src={r.avatarUrl ?? undefined}
                                size={32}
                                className="mt-0.5"
                              />
                            ) : (
                              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-light text-text-secondary-light dark:bg-card-dark/60 dark:text-text-secondary-dark">
                                <Icon size={15} />
                              </span>
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline gap-2">
                                <span className="min-w-0 truncate text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
                                  <Highlighted text={r.title} />
                                </span>
                                {r.at && (
                                  <span className="ml-auto shrink-0 text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
                                    {shortStamp(r.at)}
                                  </span>
                                )}
                              </span>
                              {r.subtitle && (
                                <span className="mt-0.5 block line-clamp-2 text-xs leading-relaxed text-text-secondary-light dark:text-text-secondary-dark">
                                  <Highlighted text={r.subtitle} />
                                </span>
                              )}
                              {r.meta && (
                                <span className="mt-0.5 block truncate text-[11px] text-text-secondary-light/80 dark:text-text-secondary-dark/70">
                                  {r.meta}
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })
          )}

          {/* Honest about a section that fell over, rather than quietly
              pretending it had no matches. */}
          {data?.failedSections?.length ? (
            <p className="px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
              Some results could not be loaded ({data.failedSections.join(', ')}). Try again.
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-light px-3 py-2 text-[11px] text-text-secondary-light dark:border-border-dark/30 dark:text-text-secondary-dark">
          <span className="flex items-center gap-2">
            <kbd className="rounded border border-border-light px-1 dark:border-border-dark">↑↓</kbd> move
            <kbd className="rounded border border-border-light px-1 dark:border-border-dark">
              <CornerDownLeft size={9} className="inline" />
            </kbd> open
            <kbd className="rounded border border-border-light px-1 dark:border-border-dark">Esc</kbd> close
          </span>
          {searching && data && (
            <span>
              {data.total ?? 0} result{(data.total ?? 0) === 1 ? '' : 's'}
              {typeof data.tookMs === 'number' ? ` · ${data.tookMs}ms` : ''}
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
