import React, { useMemo, useState } from 'react';
import {
  Search, Plus, Hash, Megaphone, Star, ChevronRight, BellOff, Users, Filter,
} from 'lucide-react';
import { Avatar, IconButton, SearchInput, Skeleton, UnreadBadge, EmptyState } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { shortStamp } from './data';
import type { Conversation } from './types';

/**
 * The conversation list — the middle pane on desktop, the whole screen on a
 * phone before a conversation is opened.
 *
 * Density is the design problem here. Each row has to carry name, last message,
 * time, unread state and mute state in ~64px, and stay scannable at 34 rows.
 * The rules that make it work: two lines only, the preview truncated to one
 * line, the timestamp right-aligned and tabular, and unread expressed twice —
 * weight on the text and a pill on the right — so it survives colour-blindness
 * and a greyscale screenshot alike.
 */

const KIND_ICON = { channel: Hash, announcement: Megaphone, group: Users } as const;

const Row: React.FC<{
  conversation: Conversation;
  active: boolean;
  onSelect: (id: string) => void;
}> = ({ conversation: c, active, onSelect }) => {
  const unread = c.unread > 0;
  const Icon = c.kind === 'dm' ? null : KIND_ICON[c.kind];

  return (
    <li>
      <button
        onClick={() => onSelect(c.id)}
        aria-current={active ? 'true' : undefined}
        className={`group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors duration-150 ${
          active
            ? 'bg-blue-50 dark:bg-blue-900/25'
            : 'hover:bg-surface-light dark:hover:bg-surface-dark'
        }`}
      >
        {c.kind === 'dm' ? (
          <Avatar name={c.name} src={c.avatarUrl} size={38} presence={c.presence} />
        ) : (
          <span
            className={`grid h-[38px] w-[38px] shrink-0 place-items-center rounded-xl ${
              c.kind === 'announcement'
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                : 'bg-slate-100 text-slate-500 dark:bg-card-dark/60 dark:text-slate-300'
            }`}
          >
            {Icon && <Icon size={18} />}
          </span>
        )}

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span
              className={`truncate text-sm ${
                unread
                  ? 'font-semibold text-text-primary-light dark:text-text-primary-dark'
                  : 'font-medium text-text-primary-light/90 dark:text-text-primary-dark/90'
              }`}
            >
              {c.name}
            </span>
            {c.muted && <BellOff size={12} className="shrink-0 text-text-secondary-light/70 dark:text-text-secondary-dark/70" />}
            {c.lastMessage && (
              <span className="ml-auto shrink-0 text-[11px] tabular-nums text-text-secondary-light dark:text-text-secondary-dark">
                {shortStamp(c.lastMessage.at)}
              </span>
            )}
          </span>

          <span className="mt-0.5 flex items-center gap-2">
            <span
              className={`truncate text-xs ${
                unread
                  ? 'text-text-primary-light/80 dark:text-text-primary-dark/75'
                  : 'text-text-secondary-light dark:text-text-secondary-dark'
              }`}
            >
              {c.lastMessage
                ? `${c.lastMessage.author === 'You' ? 'You: ' : ''}${c.lastMessage.preview}`
                : 'No messages yet'}
            </span>
            <span className="ml-auto shrink-0">
              <UnreadBadge count={c.unread} mention={c.mention} />
            </span>
          </span>
        </span>
      </button>
    </li>
  );
};

const Section: React.FC<{
  title: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}> = ({ title, count, children, defaultOpen = true }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 transition-colors duration-150 hover:text-text-primary-light dark:text-text-secondary-dark/70 dark:hover:text-text-primary-dark"
      >
        <ChevronRight size={12} className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
        {title}
        <span className="ml-1 font-normal normal-case tracking-normal opacity-70">{count}</span>
      </button>
      {open && <ul className="space-y-0.5 px-1.5">{children}</ul>}
    </div>
  );
};

const RowSkeleton: React.FC = () => (
  <li className="flex items-center gap-3 px-2.5 py-2">
    <Skeleton className="h-[38px] w-[38px] rounded-xl" />
    <div className="flex-1 space-y-1.5">
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-2.5 w-4/5" />
    </div>
  </li>
);

export const ConversationList: React.FC<{
  conversations: Conversation[];
  loading: boolean;
  activeId: string | null;
  onSelect: (id: string) => void;
}> = ({ conversations, loading, activeId, onSelect }) => {
  const { can } = usePermissions();
  const [query, setQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return conversations.filter((c) => {
      if (unreadOnly && c.unread === 0) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || (c.topic ?? '').toLowerCase().includes(q);
    });
  }, [conversations, query, unreadOnly]);

  const starred = filtered.filter((c) => c.starred);
  const channels = filtered.filter((c) => !c.starred && (c.kind === 'channel' || c.kind === 'announcement'));
  const groups = filtered.filter((c) => !c.starred && c.kind === 'group');
  const dms = filtered.filter((c) => !c.starred && c.kind === 'dm');

  const canCreate = can(['CHANNEL_CREATE', 'DM_START']);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-chrome-dark">
      <div className="shrink-0 border-b border-border-light px-3 py-3 dark:border-border-dark/30">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <h2 className="text-base font-bold tracking-tight text-text-primary-light dark:text-text-primary-dark">
            Chat
          </h2>
          <div className="flex items-center gap-0.5">
            <IconButton
              label={unreadOnly ? 'Show all conversations' : 'Show unread only'}
              size="sm"
              active={unreadOnly}
              aria-pressed={unreadOnly}
              onClick={() => setUnreadOnly((v) => !v)}
            >
              <Filter size={15} />
            </IconButton>
            {canCreate && (
              <IconButton label="New conversation" size="sm">
                <Plus size={17} />
              </IconButton>
            )}
          </div>
        </div>

        <SearchInput
          icon={<Search size={15} />}
          placeholder="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search conversations"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {loading ? (
          <ul aria-busy="true" aria-label="Loading conversations">
            {Array.from({ length: 7 }, (_, i) => <RowSkeleton key={i} />)}
          </ul>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={query ? <Search size={22} /> : <Star size={22} />}
            title={query ? `Nothing matches “${query}”` : unreadOnly ? 'Nothing unread' : 'No conversations yet'}
            hint={
              query
                ? 'Try a channel name, a person, or part of a topic.'
                : unreadOnly
                  ? 'You are all caught up.'
                  : 'Channels you are added to will appear here.'
            }
          />
        ) : (
          <>
            {starred.length > 0 && (
              <Section title="Starred" count={starred.length}>
                {starred.map((c) => (
                  <Row key={c.id} conversation={c} active={c.id === activeId} onSelect={onSelect} />
                ))}
              </Section>
            )}
            {channels.length > 0 && (
              <Section title="Channels" count={channels.length}>
                {channels.map((c) => (
                  <Row key={c.id} conversation={c} active={c.id === activeId} onSelect={onSelect} />
                ))}
              </Section>
            )}
            {groups.length > 0 && (
              <Section title="Groups" count={groups.length}>
                {groups.map((c) => (
                  <Row key={c.id} conversation={c} active={c.id === activeId} onSelect={onSelect} />
                ))}
              </Section>
            )}
            {dms.length > 0 && (
              <Section title="Direct messages" count={dms.length}>
                {dms.map((c) => (
                  <Row key={c.id} conversation={c} active={c.id === activeId} onSelect={onSelect} />
                ))}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
};
