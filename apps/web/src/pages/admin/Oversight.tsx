import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ShieldCheck, Search, Lock, Hash, Users as UsersIcon, MessageSquare, Megaphone,
  AlertTriangle, ChevronDown, ChevronUp, Archive, RefreshCw, X, Download, FileText, Play,
  ImageOff, Trash2, Eye, EyeOff, CornerUpLeft, Forward, ArrowLeft,
} from 'lucide-react';
import type { WireAttachment } from '@tupo/shared';
import { apiGet, apiPost, ApiError } from '../../lib/api';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../context/AuthContext';
import {
  Card, PageHeader, Spinner, EmptyState, Badge, Button, Avatar, SearchInput,
} from '../../components/ui';
import { Lightbox, VoiceNote } from '../chat/Attachments';
import { useMediaUrl, downloadFile } from '../chat/uploads';
import { formatBytes } from '../chat/data';

/* ────────────────────────────────────────────────────────────────────────── *
 * Types — the slices of the API payloads this page reads
 * ────────────────────────────────────────────────────────────────────────── */

type ConvType = 'dm' | 'group' | 'channel' | 'announcement';

interface OversightConversation {
  id: string;
  type: ConvType;
  name: string;
  topic: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  memberCount: number;
  messageCount: number;
  createdAt: string;
  createdByName: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  participants: string | null;
}

interface Member {
  userId: string;
  name: string;
  avatarUrl: string | null;
  role: string;
  platformRole: string | null;
}

interface ConversationDetail extends OversightConversation {
  description: string | null;
  members: Member[];
}

interface WireMessage {
  id: string;
  seq: number;
  type: string;
  body: string | null;
  senderId: string | null;
  senderName: string;
  senderAvatarUrl: string | null;
  senderRole: string | null;
  createdAt: string;
  editedAt: string | null;
  editedCount?: number;
  deletedAt: string | null;
  deletedBy: string | null;
  attachments: WireAttachment[];
  mentionNames?: Record<string, string>;
  reactions?: { emoji: string; count: number }[];
  replyTo?: {
    id: string; senderName: string; body: string | null; deleted: boolean;
  } | null;
  forwardedFrom?: { senderName: string; conversationName: string | null } | null;
}

interface Stats {
  conversations: number;
  dms: number;
  groups: number;
  channels: number;
  messages: number;
  redactions: number;
  attachmentsRemoved: number;
}

/* ────────────────────────────────────────────────────────────────────────── */

const TYPE_META: Record<ConvType, { label: string; icon: React.ElementType }> = {
  dm: { label: 'Direct message', icon: MessageSquare },
  group: { label: 'Private group', icon: UsersIcon },
  channel: { label: 'Channel', icon: Hash },
  announcement: { label: 'Announcement', icon: Megaphone },
};

const FILTERS: { key: 'all' | ConvType; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'dm', label: 'Direct messages' },
  { key: 'group', label: 'Groups' },
  { key: 'channel', label: 'Channels' },
  { key: 'announcement', label: 'Announcements' },
];

const PAGE_SIZE = 30;

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Turn `<@id>` mention tokens into readable @names. */
function renderBody(m: WireMessage): string {
  if (!m.body) return '';
  return m.body.replace(/<@([a-zA-Z0-9_-]+)>/g, (_, id) => `@${m.mentionNames?.[id] ?? 'someone'}`);
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], {
    weekday: 'long', day: 'numeric', month: 'long',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

/** A flat list of day dividers and messages, with sender-grouping decided once. */
type Row =
  | { kind: 'day'; id: string; label: string }
  | { kind: 'msg'; id: string; message: WireMessage; grouped: boolean };

function buildRows(messages: WireMessage[]): Row[] {
  const rows: Row[] = [];
  let lastDay = '';
  let prev: WireMessage | null = null;
  for (const m of messages) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) {
      rows.push({ kind: 'day', id: `day-${day}`, label: dayLabel(m.createdAt) });
      lastDay = day;
      prev = null;
    }
    const grouped = Boolean(
      prev
      && prev.senderId === m.senderId
      && m.type !== 'system' && prev.type !== 'system'
      && !m.deletedAt && !prev.deletedAt
      && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60 * 1000,
    );
    rows.push({ kind: 'msg', id: m.id, message: m, grouped });
    prev = m;
  }
  return rows;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Page
 * ────────────────────────────────────────────────────────────────────────── */

export const Oversight: React.FC = () => {
  const { can } = usePermissions();
  const mayRedact = can('OVERSIGHT_MESSAGE_DELETE');

  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState<'all' | ConvType>('all');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);

  const [conversations, setConversations] = useState<OversightConversation[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const refreshStats = useCallback(() => {
    apiGet<{ stats: Stats }>('/api/oversight/stats')
      .then((r) => setStats(r.data?.stats ?? null))
      .catch(() => { /* header chips are optional */ });
  }, []);
  useEffect(refreshStats, [refreshStats]);

  const loadList = useCallback(async (offset: number) => {
    const params = new URLSearchParams();
    if (debounced) params.set('q', debounced);
    if (filter !== 'all') params.set('type', filter);
    if (includeArchived) params.set('includeArchived', 'true');
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset));
    const r = await apiGet<{ conversations: OversightConversation[]; total: number }>(
      `/api/oversight/conversations?${params.toString()}`,
    );
    return r.data ?? { conversations: [], total: 0 };
  }, [debounced, filter, includeArchived]);

  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    loadList(0)
      .then((d) => {
        if (cancelled) return;
        setConversations(d.conversations);
        setTotal(d.total);
      })
      .finally(() => { if (!cancelled) setListLoading(false); });
    return () => { cancelled = true; };
  }, [loadList]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const d = await loadList(conversations.length);
      setConversations((prev) => [...prev, ...d.conversations]);
      setTotal(d.total);
    } finally {
      setLoadingMore(false);
    }
  };

  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  return (
    // Below lg the page scrolls as a whole and the panes are master/detail:
    // the list is the screen until a conversation is opened, then the viewer
    // replaces it with a way back — two half-height cards on a phone left
    // room for one row each.
    <div className="flex h-full flex-col overflow-y-auto p-4 sm:p-6 lg:overflow-hidden">
      <PageHeader
        title="Communication oversight"
        subtitle="Read any group, channel or direct message for academic-conduct review, and remove content that breaks the rules. Every conversation opened and every removal is written to the audit log."
      />

      <StatsRow stats={stats} onRefresh={refreshStats} />

      <div className="mt-4 grid flex-1 grid-cols-1 gap-4 lg:min-h-0 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        {/* ── Conversation list ─────────────────────────────────────────── */}
        <Card className={`min-h-[70dvh] flex-col overflow-hidden lg:min-h-0 ${selected ? 'hidden lg:flex' : 'flex'}`}>
          <div className="space-y-2.5 border-b border-border-light p-3 dark:border-border-dark/50">
            <SearchInput
              icon={<Search size={15} />}
              placeholder="Search by name, topic or participant…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                    filter === f.key
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700/60 dark:text-slate-300 dark:hover:bg-slate-700'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
                className="rounded border-slate-300"
              />
              <Archive size={13} /> Include archived
            </label>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {listLoading ? (
              <div className="grid place-items-center py-16"><Spinner /></div>
            ) : conversations.length === 0 ? (
              <EmptyState title="No conversations match" />
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-border-dark/50">
                {conversations.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    active={c.id === selectedId}
                    onClick={() => setSelectedId(c.id)}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-border-light p-2 text-center dark:border-border-dark/50">
            <p className="text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
              {conversations.length} of {total}
            </p>
            {conversations.length < total && (
              <Button variant="ghost" size="sm" onClick={loadMore} disabled={loadingMore} className="mt-1">
                {loadingMore ? <Spinner className="h-4 w-4" /> : <><ChevronDown size={14} /> Load more</>}
              </Button>
            )}
          </div>
        </Card>

        {/* ── Message viewer ────────────────────────────────────────────── */}
        <Card className={`h-[80dvh] flex-col overflow-hidden lg:h-auto lg:min-h-0 ${selected ? 'flex' : 'hidden lg:flex'}`}>
          {selected && (
            <button
              onClick={() => setSelectedId(null)}
              className="flex shrink-0 items-center gap-1.5 border-b border-border-light px-3 py-2 text-xs font-medium text-blue-600 lg:hidden dark:border-border-dark/50 dark:text-blue-400"
            >
              <ArrowLeft size={14} /> All conversations
            </button>
          )}
          {selected ? (
            <ConversationViewer
              key={selected.id}
              summary={selected}
              mayRedact={mayRedact}
              onRedacted={refreshStats}
            />
          ) : (
            <div className="grid flex-1 place-items-center p-8 text-center">
              <div className="max-w-sm space-y-2">
                <ShieldCheck size={32} className="mx-auto text-slate-300 dark:text-slate-600" />
                <p className="text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
                  Select a conversation
                </p>
                <p className="text-xs text-text-secondary-light dark:text-text-secondary-dark">
                  Opening a conversation records an audit entry against your name. Use this
                  access only for genuine academic-conduct or safeguarding review.
                </p>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────────── */

const StatsRow: React.FC<{ stats: Stats | null; onRefresh: () => void }> = ({ stats, onRefresh }) => (
  <div className="mt-3 flex flex-wrap items-center gap-2">
    {stats ? (
      <>
        <Chip label="Conversations" value={stats.conversations} />
        <Chip label="Direct messages" value={stats.dms} />
        <Chip label="Groups" value={stats.groups} />
        <Chip label="Channels" value={stats.channels} />
        <Chip label="Messages" value={stats.messages} />
        <Chip label="Messages removed" value={stats.redactions} tone={stats.redactions > 0 ? 'amber' : 'slate'} />
        <Chip label="Attachments removed" value={stats.attachmentsRemoved} tone={stats.attachmentsRemoved > 0 ? 'amber' : 'slate'} />
      </>
    ) : (
      <span className="text-xs text-text-secondary-light dark:text-text-secondary-dark">Loading totals…</span>
    )}
    <button
      onClick={onRefresh}
      className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-text-secondary-light hover:bg-slate-100 dark:text-text-secondary-dark dark:hover:bg-slate-700/60"
    >
      <RefreshCw size={12} /> Refresh
    </button>
  </div>
);

const Chip: React.FC<{ label: string; value: number; tone?: 'slate' | 'amber' }> = ({ label, value, tone = 'slate' }) => (
  <span
    className={`inline-flex items-baseline gap-1.5 rounded-lg border px-2.5 py-1 text-xs ${
      tone === 'amber'
        ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300'
        : 'border-border-light bg-surface-light text-text-secondary-light dark:border-border-dark/50 dark:bg-elevated-dark/40 dark:text-text-secondary-dark'
    }`}
  >
    <span className="text-sm font-semibold tabular-nums text-text-primary-light dark:text-text-primary-dark">
      {value.toLocaleString()}
    </span>
    {label}
  </span>
);

const ConversationRow: React.FC<{
  conversation: OversightConversation;
  active: boolean;
  onClick: () => void;
}> = ({ conversation: c, active, onClick }) => {
  const Icon = TYPE_META[c.type].icon;
  return (
    <li>
      <button
        onClick={onClick}
        className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors ${
          active ? 'bg-blue-50 dark:bg-blue-900/20' : 'hover:bg-slate-50 dark:hover:bg-card-dark/40'
        }`}
      >
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-700/60 dark:text-slate-300">
          <Icon size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
              {c.name}
            </span>
            {c.isPrivate && <Lock size={11} className="shrink-0 text-slate-400" />}
            {c.isArchived && <Badge tone="slate">archived</Badge>}
          </span>
          <span className="mt-0.5 block truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">
            {c.lastMessagePreview || c.topic || `${c.memberCount} members`}
          </span>
          <span className="mt-0.5 block text-[11px] text-text-secondary-light/80 dark:text-text-secondary-dark/70">
            {c.messageCount.toLocaleString()} msgs · {c.memberCount} members · {timeAgo(c.lastMessageAt)}
          </span>
        </span>
      </button>
    </li>
  );
};

/* ────────────────────────────────────────────────────────────────────────── *
 * Conversation viewer
 * ────────────────────────────────────────────────────────────────────────── */

const ConversationViewer: React.FC<{
  summary: OversightConversation;
  mayRedact: boolean;
  onRedacted: () => void;
}> = ({ summary, mayRedact, onRedacted }) => {
  const { user } = useAuth();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<WireMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<WireMessage | null>(null);
  const [attTarget, setAttTarget] = useState<{ message: WireMessage; attachment: WireAttachment } | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = (behavior: ScrollBehavior = 'auto') =>
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      apiGet<{ conversation: ConversationDetail }>(`/api/oversight/conversations/${summary.id}`),
      apiGet<{ messages: WireMessage[]; nextCursor: string | null }>(
        `/api/oversight/conversations/${summary.id}/messages?limit=40`,
      ),
    ])
      .then(([d, m]) => {
        if (cancelled) return;
        setDetail(d.data?.conversation ?? null);
        setMessages(m.data?.messages ?? []);
        setOlderCursor(m.data?.nextCursor ? Number(m.data.nextCursor) : null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Could not load this conversation.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [summary.id]);

  useEffect(() => {
    if (!loading) scrollToBottom();
  }, [loading]);

  const loadOlder = async () => {
    if (olderCursor == null) return;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    try {
      const m = await apiGet<{ messages: WireMessage[]; nextCursor: string | null }>(
        `/api/oversight/conversations/${summary.id}/messages?limit=40&before=${olderCursor}`,
      );
      setMessages((prev) => [...(m.data?.messages ?? []), ...prev]);
      setOlderCursor(m.data?.nextCursor ? Number(m.data.nextCursor) : null);
      // Keep the reader's eye on the same message rather than jumping to the top.
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight - before;
      });
    } finally {
      setLoadingOlder(false);
    }
  };

  const handleRedacted = (messageId: string) => {
    // Keep body/attachments — for oversight a removed message still shows its
    // preserved content (behind a reveal toggle), matching what a fresh load
    // would return.
    setMessages((prev) => prev.map((m) => (
      m.id === messageId
        ? { ...m, deletedAt: new Date().toISOString(), deletedBy: user?.id ?? null }
        : m
    )));
    setTarget(null);
    onRedacted();
  };

  const nameOf = (id: string | null): string => {
    if (!id) return 'someone';
    if (id === user?.id) return 'you';
    return detail?.members.find((m) => m.userId === id)?.name ?? 'a reviewer';
  };

  const handleAttachmentRemoved = (messageId: string, fileId: string) => {
    setMessages((prev) => prev.map((m) => (
      m.id === messageId
        ? { ...m, attachments: m.attachments.filter((a) => a.fileId !== fileId) }
        : m
    )));
    setAttTarget(null);
    onRedacted();
  };

  const Icon = TYPE_META[summary.type].icon;
  const rows = useMemo(() => buildRows(messages), [messages]);
  const deletedOnPage = useMemo(() => messages.filter((m) => m.deletedAt).length, [messages]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="border-b border-border-light px-4 py-3 dark:border-border-dark/50">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-500/5 text-blue-600 dark:text-blue-300">
            <Icon size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="truncate text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
                {detail?.name ?? summary.name}
              </h2>
              <Badge tone="blue">{TYPE_META[summary.type].label}</Badge>
              {summary.isPrivate && <Badge tone="amber">private</Badge>}
              {summary.isArchived && <Badge tone="slate">archived</Badge>}
            </div>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-text-secondary-light dark:text-text-secondary-dark">
              <span>{summary.messageCount.toLocaleString()} messages</span>
              <span aria-hidden>·</span>
              <button
                className="underline decoration-dotted underline-offset-2 hover:text-text-primary-light dark:hover:text-text-primary-dark"
                onClick={() => setShowMembers((v) => !v)}
              >
                {detail?.members.length ?? summary.memberCount} participants
              </button>
              {deletedOnPage > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span className="text-rose-500 dark:text-rose-400">{deletedOnPage} removed on this page</span>
                </>
              )}
              {detail?.createdByName && (
                <>
                  <span aria-hidden>·</span>
                  <span>started by {detail.createdByName}</span>
                </>
              )}
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-700/60 dark:text-slate-300">
            <Eye size={11} /> Read-only
          </span>
        </div>
      </div>

      {showMembers && detail && (
        <div className="max-h-40 overflow-y-auto border-b border-border-light bg-surface-light/60 px-4 py-3 dark:border-border-dark/50 dark:bg-elevated-dark/20">
          <div className="flex flex-wrap gap-1.5">
            {detail.members.map((m) => (
              <span key={m.userId} className="inline-flex items-center gap-1.5 rounded-full border border-border-light bg-white px-2 py-1 text-xs dark:border-border-dark/50 dark:bg-elevated-dark">
                <Avatar name={m.name} src={m.avatarUrl ?? undefined} size={18} tintKey={m.userId} />
                {m.name}
                {m.role !== 'member' && <Badge tone="slate">{m.role}</Badge>}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="relative min-h-0 flex-1 bg-surface-light/30 dark:bg-transparent">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
          }}
          className="h-full overflow-y-auto px-2 py-4 sm:px-3"
        >
          {loading ? (
            <MessageSkeleton />
          ) : error ? (
            <EmptyState title="Could not load messages" hint={error} />
          ) : messages.length === 0 ? (
            <EmptyState title="No messages in this conversation" icon={<MessageSquare size={20} />} />
          ) : (
            <>
              {olderCursor != null ? (
                <div className="mb-2 flex justify-center">
                  <button
                    onClick={loadOlder}
                    disabled={loadingOlder}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border-light bg-white px-3 py-1 text-xs font-medium text-text-secondary-light transition-colors hover:text-text-primary-light disabled:opacity-50 dark:border-border-dark/50 dark:bg-elevated-dark dark:text-text-secondary-dark"
                  >
                    {loadingOlder ? <Spinner className="h-3.5 w-3.5" /> : <><ChevronUp size={13} /> Load earlier messages</>}
                  </button>
                </div>
              ) : (
                <p className="mb-3 text-center text-[11px] text-text-secondary-light/70 dark:text-text-secondary-dark/60">
                  — beginning of the conversation —
                </p>
              )}

              <div>
                {rows.map((row) => (
                  row.kind === 'day'
                    ? <DayDivider key={row.id} label={row.label} />
                    : (
                      <MessageRow
                        key={row.id}
                        message={row.message}
                        grouped={row.grouped}
                        mayRedact={mayRedact}
                        deleterName={row.message.deletedBy ? nameOf(row.message.deletedBy) : null}
                        onRedactClick={() => setTarget(row.message)}
                        onAttachmentRemoveClick={(attachment) => setAttTarget({ message: row.message, attachment })}
                      />
                    )
                ))}
              </div>
              <div ref={bottomRef} />
            </>
          )}
        </div>

        {!atBottom && !loading && messages.length > 0 && (
          <button
            onClick={() => scrollToBottom('smooth')}
            className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-full bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg transition-colors hover:bg-blue-700"
          >
            <ChevronDown size={14} /> Latest
          </button>
        )}
      </div>

      {target && (
        <RemoveDialog
          title="Remove this message"
          consequence="The message is replaced with a “removed” placeholder for everyone. This is recorded in the audit log with your name, the reason, and the original text."
          confirmLabel="Remove message"
          endpoint={`/api/oversight/conversations/${summary.id}/messages/${target.id}/remove`}
          preview={(
            <>
              <span className="font-medium text-text-primary-light dark:text-text-primary-dark">{target.senderName}</span>
              <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap break-words text-text-secondary-light dark:text-text-secondary-dark">
                {renderBody(target) || '(no text)'}
              </p>
            </>
          )}
          onClose={() => setTarget(null)}
          onDone={() => handleRedacted(target.id)}
        />
      )}

      {attTarget && (
        <RemoveDialog
          title="Remove this attachment"
          consequence="The file is detached from the message and deleted, so no one can open it again. The message text stays. This is recorded in the audit log with your name, the reason, and the file name."
          confirmLabel="Remove attachment"
          endpoint={`/api/oversight/conversations/${summary.id}/messages/${attTarget.message.id}/attachments/${attTarget.attachment.fileId}/remove`}
          preview={(
            <span className="flex items-center gap-2">
              <FileText size={15} className="shrink-0 opacity-70" />
              <span className="min-w-0">
                <span className="block truncate font-medium text-text-primary-light dark:text-text-primary-dark">
                  {attTarget.attachment.name}
                </span>
                <span className="block text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
                  {attTarget.attachment.kind} · {formatBytes(attTarget.attachment.size)} · from {attTarget.message.senderName}
                </span>
              </span>
            </span>
          )}
          onClose={() => setAttTarget(null)}
          onDone={() => handleAttachmentRemoved(attTarget.message.id, attTarget.attachment.fileId)}
        />
      )}
    </div>
  );
};

const DayDivider: React.FC<{ label: string }> = ({ label }) => (
  <div className="sticky top-0 z-10 my-3 flex items-center justify-center">
    <span className="rounded-full border border-border-light bg-white/90 px-3 py-0.5 text-[11px] font-medium text-text-secondary-light shadow-sm backdrop-blur dark:border-border-dark/50 dark:bg-elevated-dark/90 dark:text-text-secondary-dark">
      {label}
    </span>
  </div>
);

const MessageSkeleton: React.FC = () => (
  <div className="space-y-4 px-2">
    {[70, 45, 88, 30, 60].map((w, i) => (
      <div key={i} className="flex gap-3">
        <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-slate-200 dark:bg-slate-700" />
        <div className="flex-1 space-y-1.5">
          <div className="h-2.5 w-24 animate-pulse rounded bg-slate-200 dark:bg-slate-700" />
          <div className="h-3 animate-pulse rounded bg-slate-200 dark:bg-slate-700" style={{ width: `${w}%` }} />
        </div>
      </div>
    ))}
  </div>
);

const MENTION_HL = /(@[\p{L}\p{N}._-]+)/u;

/** Body text with @mentions tinted — a light touch, no full rich-text parser. */
const BodyText: React.FC<{ text: string; muted?: boolean }> = ({ text, muted }) => (
  <p className={`whitespace-pre-wrap break-words text-sm leading-relaxed ${
    muted ? 'text-text-secondary-light dark:text-text-secondary-dark' : 'text-text-primary-light dark:text-text-primary-dark'
  }`}>
    {text.split(MENTION_HL).map((part, i) => (
      MENTION_HL.test(part)
        ? <span key={i} className="rounded bg-blue-500/10 px-1 font-medium text-blue-600 dark:text-blue-300">{part}</span>
        : <React.Fragment key={i}>{part}</React.Fragment>
    ))}
  </p>
);

const MessageRow: React.FC<{
  message: WireMessage;
  grouped: boolean;
  mayRedact: boolean;
  deleterName: string | null;
  onRedactClick: () => void;
  onAttachmentRemoveClick: (a: WireAttachment) => void;
}> = ({ message: m, grouped, mayRedact, deleterName, onRedactClick, onAttachmentRemoveClick }) => {
  const [revealed, setRevealed] = useState(false);

  if (m.type === 'system') {
    return (
      <div className="my-1.5 flex justify-center">
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] text-text-secondary-light dark:bg-slate-700/50 dark:text-text-secondary-dark">
          {renderBody(m) || 'system event'}
        </span>
      </div>
    );
  }

  const removed = Boolean(m.deletedAt);
  const text = renderBody(m);

  /* ── Removed message: a rose card with the original behind a reveal ── */
  if (removed) {
    return (
      <div className="group/msg my-1 rounded-lg border border-rose-200/70 bg-rose-50/50 px-3 py-2 dark:border-rose-900/40 dark:bg-rose-950/20">
        <div className="flex items-center gap-2">
          <Trash2 size={13} className="shrink-0 text-rose-500" />
          <span className="text-xs text-rose-700 dark:text-rose-300">
            <span className="font-semibold">{m.senderName}</span>’s message · removed
            {deleterName && <> by {deleterName}</>}
            {m.deletedAt && <> · {clock(m.deletedAt)}</>}
          </span>
          <button
            onClick={() => setRevealed((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-rose-600 hover:bg-rose-100 dark:text-rose-300 dark:hover:bg-rose-900/40"
          >
            {revealed ? <><EyeOff size={12} /> Hide</> : <><Eye size={12} /> Reveal original</>}
          </button>
        </div>
        {revealed && (
          <div className="mt-2 border-l-2 border-rose-300 pl-3 dark:border-rose-800">
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-rose-400">Original content — audit-logged</p>
            {text ? <BodyText text={text} muted /> : <p className="text-xs italic text-text-secondary-light">(no text)</p>}
            {m.attachments.length > 0 && (
              <OversightAttachments attachments={m.attachments} mayRedact={false} onRemove={() => {}} />
            )}
          </div>
        )}
      </div>
    );
  }

  /* ── Live message ── */
  return (
    <div className={`group/msg relative flex gap-3 rounded-lg px-2 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.03] ${grouped ? 'py-0.5' : 'mt-1.5 py-1'}`}>
      <div className="w-9 shrink-0">
        {grouped ? (
          <span className="mt-1 hidden w-9 text-center text-[10px] tabular-nums text-text-secondary-light/70 group-hover/msg:block dark:text-text-secondary-dark/60">
            {clock(m.createdAt)}
          </span>
        ) : (
          <Avatar name={m.senderName} src={m.senderAvatarUrl ?? undefined} size={36} tintKey={m.senderId ?? m.senderName} shape="rounded" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">{m.senderName}</span>
            {m.senderRole && (
              <span className="rounded bg-slate-100 px-1 text-[10px] font-medium uppercase text-slate-500 dark:bg-slate-700/60 dark:text-slate-300">
                {m.senderRole}
              </span>
            )}
            <span className="text-[11px] tabular-nums text-text-secondary-light dark:text-text-secondary-dark">
              {clock(m.createdAt)}
            </span>
          </div>
        )}

        {m.replyTo && (
          <div className="mb-1 flex items-center gap-1.5 border-l-2 border-border-light pl-2 text-xs text-text-secondary-light dark:border-border-dark/60 dark:text-text-secondary-dark">
            <CornerUpLeft size={11} className="shrink-0" />
            <span className="font-medium">{m.replyTo.senderName}</span>
            <span className="truncate opacity-80">{m.replyTo.deleted ? 'removed message' : (m.replyTo.body || 'attachment')}</span>
          </div>
        )}

        {m.forwardedFrom && (
          <p className="mb-0.5 flex items-center gap-1 text-[11px] italic text-text-secondary-light dark:text-text-secondary-dark">
            <Forward size={11} /> forwarded from {m.forwardedFrom.senderName}
          </p>
        )}

        {text && <BodyText text={text} />}
        {m.editedAt && <span className="ml-1 text-[10px] text-text-secondary-light/70">(edited)</span>}

        {m.attachments.length > 0 && (
          <OversightAttachments attachments={m.attachments} mayRedact={mayRedact} onRemove={onAttachmentRemoveClick} />
        )}

        {!!m.reactions?.length && (
          <div className="mt-1 flex flex-wrap gap-1">
            {m.reactions.map((r) => (
              <span key={r.emoji} className="inline-flex items-center gap-0.5 rounded-full border border-border-light bg-surface-light px-1.5 py-0.5 text-[11px] dark:border-border-dark/50 dark:bg-elevated-dark/50">
                {r.emoji} <span className="tabular-nums text-text-secondary-light dark:text-text-secondary-dark">{r.count}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {mayRedact && (
        <button
          onClick={onRedactClick}
          title="Remove this message for everyone"
          className="invisible absolute -top-2 right-2 inline-flex items-center gap-1 rounded-md border border-rose-200 bg-white px-2 py-1 text-[11px] font-medium text-rose-600 shadow-sm transition-opacity hover:bg-rose-50 group-hover/msg:visible dark:border-rose-900/50 dark:bg-elevated-dark dark:text-rose-400 dark:hover:bg-rose-950/40"
        >
          <Trash2 size={11} /> Remove
        </button>
      )}
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────────── *
 * Attachment preview + removal
 * ────────────────────────────────────────────────────────────────────────── */

const OversightAttachments: React.FC<{
  attachments: WireAttachment[];
  mayRedact: boolean;
  onRemove: (a: WireAttachment) => void;
}> = ({ attachments, mayRedact, onRemove }) => {
  const media = attachments.filter((a) => a.kind === 'image' || a.kind === 'video');
  const voice = attachments.filter((a) => a.kind === 'audio');
  const docs = attachments.filter((a) => a.kind === 'document' || a.kind === 'other');
  const [lightbox, setLightbox] = useState<number | null>(null);

  return (
    <div className="mt-1.5 space-y-1.5">
      {media.length > 0 && (
        <div className={`grid gap-1.5 ${media.length === 1 ? 'max-w-xs grid-cols-1' : 'max-w-md grid-cols-2'}`}>
          {media.map((a, i) => (
            <MediaTile
              key={a.fileId}
              attachment={a}
              mayRedact={mayRedact}
              onOpen={() => setLightbox(i)}
              onRemove={() => onRemove(a)}
            />
          ))}
        </div>
      )}

      {voice.map((a) => (
        <AttachmentShell key={a.fileId} mayRedact={mayRedact} onRemove={() => onRemove(a)}>
          <div className="min-w-[13rem] flex-1"><VoiceNote attachment={a} onDark={false} /></div>
        </AttachmentShell>
      ))}

      {docs.map((a) => (
        <AttachmentShell key={a.fileId} mayRedact={mayRedact} onRemove={() => onRemove(a)}>
          <FileText size={16} className="shrink-0 opacity-70" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-text-primary-light dark:text-text-primary-dark">{a.name}</span>
            <span className="block text-[11px] text-text-secondary-light dark:text-text-secondary-dark">{formatBytes(a.size)}</span>
          </span>
          <button
            onClick={() => void downloadFile(a.fileId, a.name)}
            title={`Download ${a.name}`}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-text-secondary-light hover:bg-black/5 dark:text-text-secondary-dark dark:hover:bg-white/10"
          >
            <Download size={14} />
          </button>
        </AttachmentShell>
      ))}

      {lightbox !== null && (
        <Lightbox
          items={media}
          index={lightbox}
          onIndex={setLightbox}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
};

/** The chrome around a non-media attachment: a rounded row with a hover "remove". */
const AttachmentShell: React.FC<{
  mayRedact: boolean;
  onRemove: () => void;
  children: React.ReactNode;
}> = ({ mayRedact, onRemove, children }) => (
  <div className="group/att flex max-w-md items-center gap-2.5 rounded-xl bg-surface-light px-2.5 py-2 dark:bg-card-dark/50">
    {children}
    {mayRedact && (
      <button
        onClick={onRemove}
        title="Remove this attachment"
        className="invisible inline-flex shrink-0 items-center gap-1 rounded-md border border-red-200 px-1.5 py-1 text-[11px] font-medium text-red-600 opacity-0 transition-opacity hover:bg-red-50 group-hover/att:visible group-hover/att:opacity-100 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-900/20"
      >
        <Trash2 size={11} />
      </button>
    )}
  </div>
);

const MediaTile: React.FC<{
  attachment: WireAttachment;
  mayRedact: boolean;
  onOpen: () => void;
  onRemove: () => void;
}> = ({ attachment: a, mayRedact, onOpen, onRemove }) => {
  const { url, failed } = useMediaUrl(a.fileId, true);
  const ratio = a.width && a.height ? Math.min(Math.max(a.width / a.height, 0.6), 2) : 4 / 3;

  return (
    <div className="group/tile relative overflow-hidden rounded-xl bg-slate-200 dark:bg-slate-700" style={{ aspectRatio: String(ratio) }}>
      <button onClick={onOpen} className="block h-full w-full" title={`Open ${a.name}`}>
        {failed ? (
          <span className="grid h-full w-full place-items-center text-slate-500"><ImageOff size={18} /></span>
        ) : url ? (
          <img src={url} alt={a.name} className="h-full w-full object-cover transition-transform duration-200 group-hover/tile:scale-[1.02]" />
        ) : (
          <span className="grid h-full w-full place-items-center"><Spinner className="h-4 w-4" /></span>
        )}
      </button>
      {a.kind === 'video' && (
        <span className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-black/55 text-white"><Play size={16} className="translate-x-px" /></span>
        </span>
      )}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-2 py-1 text-[10px] text-white">
        {a.name}
      </span>
      {mayRedact && (
        <button
          onClick={onRemove}
          title="Remove this attachment"
          className="invisible absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-lg bg-black/55 text-white opacity-0 transition-opacity hover:bg-red-600 group-hover/tile:visible group-hover/tile:opacity-100"
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────────── *
 * Removal dialog — shared by message and attachment removal
 * ────────────────────────────────────────────────────────────────────────── */

const REASONS = [
  'Bullying or harassment',
  'Hate speech or discrimination',
  'Sexual or inappropriate content',
  'Threats or violence',
  'Sharing personal data',
  'Spam or off-topic disruption',
  'Academic dishonesty',
  'Other policy violation',
];

const RemoveDialog: React.FC<{
  title: string;
  consequence: string;
  confirmLabel: string;
  endpoint: string;
  preview: React.ReactNode;
  onClose: () => void;
  onDone: () => void;
}> = ({ title, consequence, confirmLabel, endpoint, preview, onClose, onDone }) => {
  const [preset, setPreset] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reason = [preset, note.trim()].filter(Boolean).join(' — ');
  const valid = preset !== '' || note.trim().length >= 3;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiPost(endpoint, { reason });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not complete the removal.');
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <Card className="w-full max-w-md p-5 shadow-2xl">
        <div onClick={(e) => e.stopPropagation()}>
          <div className="flex items-start justify-between">
            <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
              <AlertTriangle size={16} className="text-red-500" /> {title}
            </h3>
            <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
          </div>

          <div className="mt-3 rounded-lg border border-border-light bg-surface-light p-2.5 text-xs dark:border-border-dark/50 dark:bg-elevated-dark/40">
            {preview}
          </div>

          <p className="mt-3 text-xs text-text-secondary-light dark:text-text-secondary-dark">{consequence}</p>

          <fieldset className="mt-3 space-y-1.5">
            <legend className="mb-1 text-[11px] font-medium uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">
              Reason
            </legend>
            {REASONS.map((r) => (
              <label key={r} className="flex cursor-pointer items-center gap-2 text-sm text-text-primary-light dark:text-text-primary-dark">
                <input type="radio" name="reason" checked={preset === r} onChange={() => setPreset(r)} />
                {r}
              </label>
            ))}
          </fieldset>

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note (optional if a reason is selected)…"
            rows={2}
            className="mt-3 w-full rounded-lg border border-border-light bg-surface-light p-2 text-sm dark:border-border-dark/50 dark:bg-elevated-dark/40"
          />

          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={submit} disabled={!valid || submitting}>
              {submitting ? <Spinner className="h-4 w-4" /> : confirmLabel}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
};
