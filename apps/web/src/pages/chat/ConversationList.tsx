import type { ActivityKind } from '@tupo/shared';
import React, { useMemo, useState } from 'react';
import {
  Search, Plus, Hash, Megaphone, Star, ChevronRight, BellOff, Users, Filter, Lock, AtSign,
  Bookmark, Bell, Compass,
} from 'lucide-react';
import { IconButton, SearchInput, Skeleton, UnreadBadge, EmptyState } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../context/AuthContext';
import { shortStamp, sectionOf, SECTION_LABEL, SECTION_ORDER, typingLabel } from './data';
import type { SidebarSection } from './data';
import { useChat } from './ChatProvider';
import { ConversationAvatar } from './ConversationAvatar';
import type { Conversation } from './types';
import { NewConversationDialog } from './NewConversationDialog';

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
  typing: string[];
  typingKind?: ActivityKind;
  onSelect: (id: string) => void;
  onToggleStar: (id: string) => void;
}> = ({ conversation: c, active, typing, typingKind, onSelect, onToggleStar }) => {
  const { user } = useAuth();
  const unread = c.unread > 0;
  const muted = c.notification === 'none' || Boolean(c.mutedUntil);
  const Icon = c.type === 'dm' ? null : KIND_ICON[c.type];
  const mine = c.lastMessage?.senderId && c.lastMessage.senderId === user?.id;

  return (
    <li className="group/row relative">
      <button
        onClick={() => onSelect(c.id)}
        aria-current={active ? 'true' : undefined}
        className={`group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors duration-150 ${
          active
            ? 'bg-blue-50 dark:bg-blue-900/25'
            : 'hover:bg-surface-light dark:hover:bg-surface-dark'
        }`}
      >
        <ConversationAvatar
          conversation={c}
          size={38}
          fallback={Icon ? <Icon size={18} /> : null}
        />

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
            {c.isPrivate && c.type !== 'dm' && (
              <Lock size={11} className="shrink-0 text-text-secondary-light/70 dark:text-text-secondary-dark/70" />
            )}
            {muted && (
              <BellOff size={12} className="shrink-0 text-text-secondary-light/70 dark:text-text-secondary-dark/70" />
            )}
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
              {/* Typing wins over the preview and over a draft: it is the only
                  one of the three that is happening right now. */}
              {typing.length > 0
                ? <span className="text-blue-600 dark:text-blue-400">{typingLabel(typing, typingKind)}…</span>
                : c.draft
                ? <span className="text-amber-600 dark:text-amber-400">Draft: {c.draft}</span>
                : c.lastMessage
                  ? `${mine ? 'You: ' : c.type !== 'dm' && c.lastMessage.senderName ? `${c.lastMessage.senderName.split(' ')[0]}: ` : ''}${c.lastMessage.preview}`
                  : 'No messages yet'}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {/* A mention is called out on its own: on a muted channel it is
                  the one thing that still deserves attention. */}
              {c.unreadMentions > 0 && (
                <span
                  className="grid h-4 w-4 place-items-center rounded-full bg-red-500 text-white"
                  title={`${c.unreadMentions} mention${c.unreadMentions > 1 ? 's' : ''}`}
                >
                  <AtSign size={10} />
                </span>
              )}
              <UnreadBadge count={muted && c.unreadMentions === 0 ? 0 : c.unread} mention={c.unreadMentions > 0} />
            </span>
          </span>
        </span>
      </button>

      {/* Star sits outside the row button — a button inside a button is invalid
          HTML and the inner one stops working in Safari. */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggleStar(c.id); }}
        aria-label={c.isStarred ? `Unstar ${c.name}` : `Star ${c.name}`}
        aria-pressed={c.isStarred}
        className={`absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-md text-text-secondary-light transition-opacity duration-150 hover:bg-black/5 focus:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-text-secondary-dark dark:hover:bg-white/10 ${
          c.isStarred ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'
        }`}
      >
        <Star size={12} className={c.isStarred ? 'fill-amber-400 text-amber-400' : ''} />
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
  onOpenSaved?: () => void;
  onOpenSettings?: () => void;
  onOpenSearch?: () => void;
  onOpenBrowse?: () => void;
}> = ({ onOpenSaved, onOpenSettings, onOpenSearch, onOpenBrowse }) => {
  const { can } = usePermissions();
  const {
    conversations, conversationsLoading, activeId, setActiveId, toggleStar, connected,
    typingByConversation,
  } = useChat();
  const [query, setQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return conversations.filter((c) => {
      if (unreadOnly && c.unread === 0 && c.unreadMentions === 0) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q)
        || (c.topic ?? '').toLowerCase().includes(q)
        || (c.lastMessage?.preview ?? '').toLowerCase().includes(q);
    });
  }, [conversations, query, unreadOnly]);

  const grouped = useMemo(() => {
    const out: Record<SidebarSection, Conversation[]> = {
      starred: [], channels: [], groups: [], direct: [],
    };
    for (const c of filtered) out[sectionOf(c)].push(c);
    return out;
  }, [filtered]);

  const canCreate = can(['CHANNEL_CREATE', 'DM_START']);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-chrome-dark">
      <div className="shrink-0 border-b border-border-light px-3 py-3 dark:border-border-dark/30">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-bold tracking-tight text-text-primary-light dark:text-text-primary-dark">
            Chat
            {/* A quiet dot rather than a banner. Losing the socket degrades
                chat to "messages arrive when you reload"; that is worth
                showing, but not worth a bar across the top of the screen. */}
            {!connected && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-amber-500"
                title="Reconnecting — new messages may be delayed"
                role="status"
                aria-label="Reconnecting"
              />
            )}
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
            {onOpenBrowse && can('CHANNEL_VIEW') && (
              <IconButton label="Browse channels" size="sm" onClick={onOpenBrowse}>
                <Compass size={15} />
              </IconButton>
            )}
            {onOpenSearch && (
              <IconButton label="Search messages" size="sm" onClick={onOpenSearch}>
                <Search size={15} />
              </IconButton>
            )}
            {onOpenSettings && (
              <IconButton label="Notification settings" size="sm" onClick={onOpenSettings}>
                <Bell size={15} />
              </IconButton>
            )}
            {onOpenSaved && (
              <IconButton label="Saved items" size="sm" onClick={onOpenSaved}>
                <Bookmark size={15} />
              </IconButton>
            )}
            {canCreate && (
              <IconButton label="New conversation" size="sm" onClick={() => setCreating(true)}>
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
        {conversationsLoading ? (
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
                  : canCreate
                    ? 'Start one with the + button, or browse the channel directory.'
                    : 'Channels you are added to will appear here. Browse the directory to find more.'
            }
          />
        ) : (
          SECTION_ORDER.map((section) => grouped[section].length > 0 && (
            <Section key={section} title={SECTION_LABEL[section]} count={grouped[section].length}>
              {grouped[section].map((c) => (
                <Row
                  key={c.id}
                  conversation={c}
                  active={c.id === activeId}
                  typing={(typingByConversation[c.id] ?? []).map((t) => t.name.split(' ')[0]!)}
                  typingKind={typingByConversation[c.id]?.[0]?.kind}
                  onSelect={setActiveId}
                  onToggleStar={toggleStar}
                />
              ))}
            </Section>
          ))
        )}
      </div>

      {creating && <NewConversationDialog onClose={() => setCreating(false)} />}
    </div>
  );
};
