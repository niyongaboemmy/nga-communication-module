import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Search, Hash, MessageSquare, Paperclip, Filter } from 'lucide-react';
import { Avatar, IconButton, Skeleton, EmptyState } from '../../components/ui';
import { useChat } from './ChatProvider';
import * as chatApi from './api';
import { shortStamp } from './data';
import { Highlighted } from '../../components/Highlighted';

/**
 * Message search (FR-SRCH).
 *
 * The server returns matched runs wrapped in two control characters rather
 * than HTML. That is deliberate: the alternative is the database emitting
 * `<b>` and this component injecting it as markup, which — since the string
 * contains message text — is a stored XSS with extra steps. Splitting on the
 * sentinels and building React elements keeps every byte of user content
 * escaped.
 */

export const SearchPanel: React.FC<{
  onClose: () => void;
  /** Pre-scope the search to the open conversation. */
  scopedConversationId?: string | null;
}> = ({ onClose, scopedConversationId }) => {
  const { setActiveId, jumpTo, conversations } = useChat();

  const [query, setQuery] = useState('');
  const [scoped, setScoped] = useState(Boolean(scopedConversationId));
  const [hasFile, setHasFile] = useState(false);
  const [hits, setHits] = useState<chatApi.SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) { setHits(null); setSearching(false); return; }

    let cancelled = false;
    setSearching(true);
    // Debounced: full-text search over a term someone is still typing is a
    // query per keystroke against the largest table in the database.
    const t = setTimeout(() => {
      chatApi.searchMessages(term, {
        conversationId: scoped && scopedConversationId ? scopedConversationId : undefined,
        hasFile: hasFile || undefined,
      })
        .then((r) => { if (!cancelled) setHits(r.hits); })
        .catch(() => { if (!cancelled) setHits([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 280);

    return () => { cancelled = true; clearTimeout(t); };
  }, [query, scoped, scopedConversationId, hasFile]);

  const open = useCallback((hit: chatApi.SearchHit) => {
    setActiveId(hit.conversationId);
    // After the switch, so the jump searches the conversation it landed in.
    setTimeout(() => void jumpTo(hit.message.id), 350);
    onClose();
  }, [setActiveId, jumpTo, onClose]);

  const scopedName = conversations.find((c) => c.id === scopedConversationId)?.name;

  return (
    <aside
      aria-label="Search messages"
      className="flex h-full min-h-0 w-full flex-col border-l border-border-light bg-white dark:border-border-dark/30 dark:bg-chrome-dark"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-light px-3 dark:border-border-dark/30">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
          <Search size={15} /> Search
        </h2>
        <IconButton label="Close search" onClick={onClose}><X size={18} /></IconButton>
      </header>

      <div className="shrink-0 space-y-2 border-b border-border-light p-3 dark:border-border-dark/30">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary-light dark:text-text-secondary-dark" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages"
            // Distinct from the panel's own label and from the button that
            // opens it: three controls sharing one accessible name is
            // indistinguishable to a screen reader.
            aria-label="Search term"
            className="w-full rounded-lg border border-border-light bg-surface-light py-2 pl-9 pr-3 text-sm text-text-primary-light outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark/50 dark:bg-elevated-dark/60 dark:text-text-primary-dark"
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {scopedConversationId && (
            <button
              onClick={() => setScoped((v) => !v)}
              aria-pressed={scoped}
              className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors duration-150 ${
                scoped
                  ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                  : 'border-border-light text-text-secondary-light dark:border-border-dark dark:text-text-secondary-dark'
              }`}
            >
              <Filter size={10} /> In {scopedName ? `#${scopedName}` : 'this conversation'}
            </button>
          )}
          <button
            onClick={() => setHasFile((v) => !v)}
            aria-pressed={hasFile}
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors duration-150 ${
              hasFile
                ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                : 'border-border-light text-text-secondary-light dark:border-border-dark dark:text-text-secondary-dark'
            }`}
          >
            <Paperclip size={10} /> Has a file
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {query.trim().length < 2 ? (
          <EmptyState
            icon={<Search size={22} />}
            title="Search your messages"
            hint="Type at least two characters. Quoted phrases and -exclusions work."
          />
        ) : searching && hits === null ? (
          <div className="space-y-2 p-1" aria-busy="true">
            {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
          </div>
        ) : !hits?.length ? (
          <EmptyState
            icon={<Search size={22} />}
            title={`Nothing matches “${query.trim()}”`}
            hint="Try fewer words, or search across all conversations."
          />
        ) : (
          <>
            <p className="px-2 pb-1 text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
              {hits.length} {hits.length === 1 ? 'result' : 'results'}
            </p>
            <ul className="space-y-1.5">
              {hits.map((hit) => (
                <li key={hit.message.id}>
                  <button
                    onClick={() => open(hit)}
                    className="w-full rounded-xl border border-border-light bg-surface-light p-2.5 text-left transition-colors duration-150 hover:bg-white dark:border-border-dark/40 dark:bg-elevated-dark/40 dark:hover:bg-elevated-dark"
                  >
                    <span className="mb-1 flex items-center gap-1.5">
                      {hit.conversationType === 'dm'
                        ? <MessageSquare size={11} className="shrink-0 opacity-60" />
                        : <Hash size={11} className="shrink-0 opacity-60" />}
                      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-text-secondary-light dark:text-text-secondary-dark">
                        {hit.conversationName}
                      </span>
                      <span className="shrink-0 text-[10px] text-text-secondary-light dark:text-text-secondary-dark">
                        {shortStamp(hit.message.createdAt)}
                      </span>
                    </span>
                    <span className="flex gap-2">
                      <Avatar
                        name={hit.message.senderName}
                        src={hit.message.senderAvatarUrl ?? undefined}
                        size={24}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold text-text-primary-light dark:text-text-primary-dark">
                          {hit.message.senderName}
                        </span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-text-secondary-light dark:text-text-secondary-dark">
                          <Highlighted text={hit.highlight} />
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
};
