import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ShieldCheck, Search, Lock, Hash, Users as UsersIcon, MessageSquare, Megaphone,
  AlertTriangle, ChevronDown, Archive, RefreshCw, X,
} from 'lucide-react';
import { apiGet, apiPost, ApiError } from '../../lib/api';
import { usePermissions } from '../../hooks/usePermissions';
import {
  Card, PageHeader, Spinner, EmptyState, Badge, Button, Avatar, SearchInput,
} from '../../components/ui';

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
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  attachments: { name?: string; kind?: string }[];
  mentionNames?: Record<string, string>;
}

interface Stats {
  conversations: number;
  dms: number;
  groups: number;
  channels: number;
  messages: number;
  redactions: number;
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
    <div className="flex h-full flex-col p-4 sm:p-6">
      <PageHeader
        title="Communication oversight"
        subtitle="Read any group, channel or direct message for academic-conduct review, and remove content that breaks the rules. Every conversation opened and every removal is written to the audit log."
      />

      <StatsRow stats={stats} onRefresh={refreshStats} />

      <div className="mt-4 grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        {/* ── Conversation list ─────────────────────────────────────────── */}
        <Card className="flex min-h-0 flex-col overflow-hidden">
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
        <Card className="flex min-h-0 flex-col overflow-hidden">
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
        <Chip label="Removed by oversight" value={stats.redactions} tone={stats.redactions > 0 ? 'amber' : 'slate'} />
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
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<WireMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<WireMessage | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

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
    if (!loading) bottomRef.current?.scrollIntoView();
  }, [loading]);

  const loadOlder = async () => {
    if (olderCursor == null) return;
    setLoadingOlder(true);
    try {
      const m = await apiGet<{ messages: WireMessage[]; nextCursor: string | null }>(
        `/api/oversight/conversations/${summary.id}/messages?limit=40&before=${olderCursor}`,
      );
      setMessages((prev) => [...(m.data?.messages ?? []), ...prev]);
      setOlderCursor(m.data?.nextCursor ? Number(m.data.nextCursor) : null);
    } finally {
      setLoadingOlder(false);
    }
  };

  const handleRedacted = (messageId: string) => {
    setMessages((prev) => prev.map((m) => (
      m.id === messageId ? { ...m, body: null, deletedAt: new Date().toISOString(), attachments: [] } : m
    )));
    setTarget(null);
    onRedacted();
  };

  const Icon = TYPE_META[summary.type].icon;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-border-light p-3 dark:border-border-dark/50">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-700/60 dark:text-slate-300">
          <Icon size={16} />
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
          <p className="mt-0.5 text-xs text-text-secondary-light dark:text-text-secondary-dark">
            {summary.messageCount.toLocaleString()} messages ·{' '}
            <button className="underline hover:text-text-primary-light dark:hover:text-text-primary-dark" onClick={() => setShowMembers((v) => !v)}>
              {detail?.members.length ?? summary.memberCount} participants
            </button>
            {detail?.createdByName && <> · created by {detail.createdByName}</>}
          </p>
        </div>
      </div>

      {showMembers && detail && (
        <div className="max-h-40 overflow-y-auto border-b border-border-light bg-surface-light/50 p-3 dark:border-border-dark/50 dark:bg-elevated-dark/20">
          <div className="flex flex-wrap gap-2">
            {detail.members.map((m) => (
              <span key={m.userId} className="inline-flex items-center gap-1.5 rounded-full bg-white px-2 py-1 text-xs shadow-sm dark:bg-elevated-dark">
                <Avatar name={m.name} src={m.avatarUrl ?? undefined} size={18} tintKey={m.userId} />
                {m.name}
                {m.role !== 'member' && <Badge tone="slate">{m.role}</Badge>}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="grid place-items-center py-16"><Spinner /></div>
        ) : error ? (
          <EmptyState title="Could not load messages" hint={error} />
        ) : messages.length === 0 ? (
          <EmptyState title="No messages in this conversation" />
        ) : (
          <>
            {olderCursor != null && (
              <div className="mb-3 text-center">
                <Button variant="ghost" size="sm" onClick={loadOlder} disabled={loadingOlder}>
                  {loadingOlder ? <Spinner className="h-4 w-4" /> : 'Load older messages'}
                </Button>
              </div>
            )}
            <ul className="space-y-1">
              {messages.map((m) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  mayRedact={mayRedact}
                  onRedactClick={() => setTarget(m)}
                />
              ))}
            </ul>
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {target && (
        <RedactDialog
          conversationId={summary.id}
          message={target}
          onClose={() => setTarget(null)}
          onDone={() => handleRedacted(target.id)}
        />
      )}
    </div>
  );
};

const MessageRow: React.FC<{
  message: WireMessage;
  mayRedact: boolean;
  onRedactClick: () => void;
}> = ({ message: m, mayRedact, onRedactClick }) => {
  if (m.type === 'system') {
    return (
      <li className="py-1 text-center text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
        {renderBody(m) || 'system event'}
      </li>
    );
  }

  const removed = Boolean(m.deletedAt);

  return (
    <li className="group flex gap-2.5 rounded-lg px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-card-dark/40">
      <Avatar name={m.senderName} src={m.senderAvatarUrl ?? undefined} size={28} tintKey={m.senderId ?? m.senderName} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold text-text-primary-light dark:text-text-primary-dark">
            {m.senderName}
          </span>
          <span className="text-[11px] text-text-secondary-light dark:text-text-secondary-dark tabular-nums">
            {new Date(m.createdAt).toLocaleString()}
          </span>
          {m.editedAt && !removed && (
            <span className="text-[11px] text-text-secondary-light/70">(edited)</span>
          )}
        </div>
        {removed ? (
          <p className="mt-0.5 inline-flex items-center gap-1.5 text-xs italic text-text-secondary-light dark:text-text-secondary-dark">
            <AlertTriangle size={12} className="text-amber-500" /> Message removed
          </p>
        ) : (
          <>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-text-primary-light dark:text-text-primary-dark">
              {renderBody(m)}
            </p>
            {m.attachments.length > 0 && (
              <p className="mt-1 text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
                📎 {m.attachments.map((a) => a.name || a.kind || 'attachment').join(', ')}
              </p>
            )}
          </>
        )}
      </div>
      {mayRedact && !removed && (
        <button
          onClick={onRedactClick}
          className="invisible mt-0.5 h-fit shrink-0 self-start rounded-md border border-red-200 px-2 py-1 text-[11px] font-medium text-red-600 opacity-0 transition-opacity hover:bg-red-50 group-hover:visible group-hover:opacity-100 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-900/20"
        >
          Remove
        </button>
      )}
    </li>
  );
};

/* ────────────────────────────────────────────────────────────────────────── *
 * Redaction dialog
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

const RedactDialog: React.FC<{
  conversationId: string;
  message: WireMessage;
  onClose: () => void;
  onDone: () => void;
}> = ({ conversationId, message, onClose, onDone }) => {
  const [preset, setPreset] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reason = [preset, note.trim()].filter(Boolean).join(' — ');
  const valid = preset !== '' || note.trim().length >= 3;

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiPost(`/api/oversight/conversations/${conversationId}/messages/${message.id}/remove`, { reason });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove the message.');
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-md p-5" >
        <div onClick={(e) => e.stopPropagation()}>
          <div className="flex items-start justify-between">
            <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
              <AlertTriangle size={16} className="text-red-500" /> Remove this message
            </h3>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
          </div>

          <div className="mt-3 rounded-lg border border-border-light bg-surface-light p-2.5 text-xs dark:border-border-dark/50 dark:bg-elevated-dark/40">
            <span className="font-medium text-text-primary-light dark:text-text-primary-dark">{message.senderName}</span>
            <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap break-words text-text-secondary-light dark:text-text-secondary-dark">
              {renderBody(message) || '(no text)'}
            </p>
          </div>

          <p className="mt-3 text-xs text-text-secondary-light dark:text-text-secondary-dark">
            The message is replaced with a “removed” placeholder for everyone. This is recorded
            in the audit log with your name, the reason, and the original text.
          </p>

          <div className="mt-3 space-y-1.5">
            {REASONS.map((r) => (
              <label key={r} className="flex cursor-pointer items-center gap-2 text-sm text-text-primary-light dark:text-text-primary-dark">
                <input type="radio" name="reason" checked={preset === r} onChange={() => setPreset(r)} />
                {r}
              </label>
            ))}
          </div>

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
              {submitting ? <Spinner className="h-4 w-4" /> : 'Remove message'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
};
