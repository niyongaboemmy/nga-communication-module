import React, { useEffect, useState } from 'react';
import {
  X, Users, FileText, Info, Bell, BellOff, Star, LogOut, AtSign, Download, Image as ImageIcon,
  UserPlus,
} from 'lucide-react';
import { Avatar, IconButton, EmptyState, Skeleton } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../context/AuthContext';
import { useNotify } from '../../context/NotificationContext';
import { listConversationFiles, downloadFile } from './uploads';
import type { ConversationFile } from './uploads';
import * as chatApi from './api';
import { formatBytes, shortStamp } from './data';
import { useChat } from './ChatProvider';
import { ConversationAvatar } from './ConversationAvatar';
import { toPresence } from './types';
import type { Conversation, Member } from './types';

/**
 * The right-hand context panel (§15.1) — thread, members, files and details for
 * whatever is open in the main pane.
 *
 * It is inline from `xl` up, where there is width for three panes, and an
 * overlay below that. Same component either way: only the wrapper in
 * ChatLayout differs, so the two never drift apart.
 */

type Tab = 'about' | 'members' | 'files';

const TABS: { id: Tab; label: string; icon: typeof Info }[] = [
  { id: 'about', label: 'About', icon: Info },
  { id: 'members', label: 'Members', icon: Users },
  { id: 'files', label: 'Files', icon: FileText },
];

export const ContextPanel: React.FC<{
  conversation: Conversation;
  members: Member[];
  onClose: () => void;
  /** Opens the settings panel — where members are added and details edited. */
  onOpenSettings?: () => void;
}> = ({ conversation: c, members, onClose, onOpenSettings }) => {
  const [tab, setTab] = useState<Tab>('about');
  const { toggleStar, setNotificationLevel, jumpTo, setActiveId, refresh } = useChat();
  const { can } = usePermissions();
  const { user } = useAuth();
  const { notify } = useNotify();
  const muted = c.notification === 'none';
  const [leaving, setLeaving] = useState(false);

  const kind = c.type === 'group' ? 'group' : 'channel';
  // Same two-layer rule the settings panel uses: a conversation role of
  // owner/admin *and* the platform permission.
  const canManageMembers =
    c.type !== 'dm' && (c.myRole === 'owner' || c.myRole === 'admin') && can('CHANNEL_MEMBERS_MANAGE');

  const leave = async () => {
    if (!user) return;
    try {
      await chatApi.removeMember(c.id, user.id);
      await refresh();
      setActiveId(null);
      onClose();
      notify({ title: `You left the ${kind}`, tone: 'success', confirmation: true });
    } catch (err) {
      notify({
        title: 'Could not leave',
        body: err instanceof Error ? err.message : undefined,
        tone: 'error',
      });
    } finally {
      setLeaving(false);
    }
  };

  const [files, setFiles] = useState<ConversationFile[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'image' | 'document'>('all');

  // Fetched when the tab is opened, not on mount: a channel's file history can
  // be long, and most people never open this tab at all.
  useEffect(() => {
    if (tab !== 'files') return;
    let cancelled = false;
    setFiles(null);
    listConversationFiles(c.id, filter === 'all' ? undefined : filter)
      .then((rows) => { if (!cancelled) setFiles(rows); })
      .catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [tab, c.id, filter]);

  return (
    <aside
      aria-label="Conversation details"
      className="flex h-full min-h-0 w-full flex-col border-l border-border-light bg-white dark:border-border-dark/30 dark:bg-chrome-dark"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-light px-3 dark:border-border-dark/30">
        <h2 className="truncate text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">Details</h2>
        <IconButton label="Close details" onClick={onClose}><X size={18} /></IconButton>
      </header>

      <div className="shrink-0 border-b border-border-light px-2 pt-2 dark:border-border-dark/30" role="tablist">
        <div className="flex gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-t-xl border-b-2 px-2 py-2 text-xs font-medium transition-colors duration-150 ${
                tab === id
                  ? 'border-blue-600 text-blue-600 dark:border-blue-500 dark:text-blue-400'
                  : 'border-transparent text-text-secondary-light hover:text-text-primary-light dark:text-text-secondary-dark dark:hover:text-text-primary-dark'
              }`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4" role="tabpanel">
        {tab === 'about' && (
          <div className="space-y-5">
            <div className="text-center">
              <ConversationAvatar
                conversation={c}
                size={72}
                radius="rounded-2xl"
                className="mx-auto"
                fallback={<span className="text-2xl font-bold">#</span>}
              />
              <p className="mt-3 text-base font-semibold text-text-primary-light dark:text-text-primary-dark">{c.name}</p>
              {c.topic && (
                <p className="mt-1 text-sm leading-relaxed text-text-secondary-light dark:text-text-secondary-dark">{c.topic}</p>
              )}
              {c.description && (
                <p className="mt-2 text-xs leading-relaxed text-text-secondary-light dark:text-text-secondary-dark">{c.description}</p>
              )}
            </div>

            {/* Two tiles for a DM: "Block" used to sit here doing nothing at
                all, and there is no block endpoint to wire it to. */}
            <div className={`grid gap-2 ${c.type === 'dm' ? 'grid-cols-2' : 'grid-cols-3'}`}>
              <button
                onClick={() => setNotificationLevel(c.id, muted ? 'all' : 'none')}
                aria-pressed={muted}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-border-light bg-white px-2 py-3 text-[11px] font-medium text-text-secondary-light transition-colors duration-150 hover:bg-surface-light hover:text-text-primary-light dark:border-border-dark/50 dark:bg-elevated-dark/50 dark:text-text-secondary-dark dark:hover:bg-card-dark/50"
              >
                {muted ? <BellOff size={16} /> : <Bell size={16} />} {muted ? 'Unmute' : 'Mute'}
              </button>
              <button
                onClick={() => toggleStar(c.id)}
                aria-pressed={c.isStarred}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-border-light bg-white px-2 py-3 text-[11px] font-medium text-text-secondary-light transition-colors duration-150 hover:bg-surface-light hover:text-text-primary-light dark:border-border-dark/50 dark:bg-elevated-dark/50 dark:text-text-secondary-dark dark:hover:bg-card-dark/50"
              >
                <Star size={16} className={c.isStarred ? 'fill-amber-400 text-amber-400' : ''} />
                {c.isStarred ? 'Unstar' : 'Star'}
              </button>
              {c.type !== 'dm' && (
                <button
                  onClick={() => setLeaving(true)}
                  className="flex flex-col items-center gap-1.5 rounded-xl border border-border-light bg-white px-2 py-3 text-[11px] font-medium text-text-secondary-light transition-colors duration-150 hover:bg-surface-light hover:text-text-primary-light dark:border-border-dark/50 dark:bg-elevated-dark/50 dark:text-text-secondary-dark dark:hover:bg-card-dark/50"
                >
                  <LogOut size={16} /> Leave
                </button>
              )}
            </div>

            {leaving && (
              <div className="rounded-xl border border-red-300 bg-red-50 p-2.5 dark:border-red-500/40 dark:bg-red-500/10">
                <p className="mb-2 text-xs text-red-900 dark:text-red-200">
                  {c.myRole === 'owner'
                    ? `You own this ${kind}. Make someone else the owner before you leave.`
                    : `Leave this ${kind}? You will stop receiving its messages.`}
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setLeaving(false)}
                    className="rounded-lg px-2 py-1 text-xs text-text-secondary-light dark:text-text-secondary-dark"
                  >
                    Cancel
                  </button>
                  {c.myRole !== 'owner' && (
                    <button
                      onClick={() => void leave()}
                      className="rounded-lg bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700"
                    >
                      Leave
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Three levels rather than a mute toggle. "Mentions only" is the
                setting that keeps people in a busy class channel instead of
                leaving it — the binary version does not have that middle. */}
            {c.type !== 'dm' && (
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
                  Notify me about
                </p>
                <div className="flex gap-1 rounded-xl border border-border-light p-1 dark:border-border-dark/50">
                  {([
                    { id: 'all', label: 'All', icon: Bell },
                    { id: 'mentions', label: 'Mentions', icon: AtSign },
                    { id: 'none', label: 'Nothing', icon: BellOff },
                  ] as const).map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      onClick={() => setNotificationLevel(c.id, id)}
                      aria-pressed={c.notification === id}
                      className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors duration-150 ${
                        c.notification === id
                          ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                          : 'text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-surface-dark'
                      }`}
                    >
                      <Icon size={12} /> {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'members' && (
          <>
            {/* The Members tab is where people look for this, not the gear. */}
            {canManageMembers && onOpenSettings && (
              <button
                onClick={onOpenSettings}
                className="mb-2 flex w-full items-center gap-2.5 rounded-xl border border-dashed border-border-light px-2 py-2 text-left text-sm font-medium text-blue-600 transition-colors hover:border-blue-400 hover:bg-blue-50/50 dark:border-border-dark/50 dark:text-blue-400 dark:hover:bg-blue-900/20"
              >
                <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full bg-blue-50 dark:bg-blue-900/30">
                  <UserPlus size={16} />
                </span>
                Add people
              </button>
            )}
            {members.length === 0 ? (
              <EmptyState icon={<Users size={22} />} title="Loading members" hint="One moment." />
            ) : (
          <ul className="space-y-0.5">
            {members.map((m) => (
              <li key={m.userId}>
                <button className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors duration-150 hover:bg-surface-light dark:hover:bg-surface-dark">
                  <Avatar
                    name={m.name}
                    src={m.avatarUrl ?? undefined}
                    size={34}
                    presence={toPresence(m.presence)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
                      {m.name}
                    </span>
                    <span className="block truncate text-xs capitalize text-text-secondary-light dark:text-text-secondary-dark">
                      {m.role === 'member' ? (m.platformRole ?? 'Member') : m.role}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
            )}
          </>
        )}

        {tab === 'files' && (
          <div>
            <div className="mb-2 flex gap-1 rounded-lg border border-border-light p-1 dark:border-border-dark/50">
              {([
                { id: 'all', label: 'All' },
                { id: 'image', label: 'Media' },
                { id: 'document', label: 'Documents' },
              ] as const).map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => setFilter(id)}
                  aria-pressed={filter === id}
                  className={`flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors duration-150 ${
                    filter === id
                      ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                      : 'text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-surface-dark'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {files === null ? (
              <div className="space-y-2" aria-busy="true">
                {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}
              </div>
            ) : files.length === 0 ? (
              <EmptyState
                icon={<FileText size={22} />}
                title="No files shared yet"
                hint="Files attached to messages in this conversation will collect here."
              />
            ) : (
              <ul className="space-y-1">
                {files.map((f) => (
                  <li
                    key={f.id}
                    className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-light dark:hover:bg-surface-dark"
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500 dark:bg-card-dark/60 dark:text-slate-300">
                      {f.kind === 'image' || f.kind === 'video'
                        ? <ImageIcon size={15} /> : <FileText size={15} />}
                    </span>
                    {/* Clicking a file goes to the message it was shared in.
                        A file torn out of its conversation loses the sentence
                        that explains what it is. */}
                    <button
                      onClick={() => void jumpTo(f.messageId)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block truncate text-xs font-medium text-text-primary-light dark:text-text-primary-dark">
                        {f.name}
                      </span>
                      <span className="block truncate text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
                        {f.senderName} · {formatBytes(f.size)} · {shortStamp(f.createdAt)}
                      </span>
                    </button>
                    <IconButton
                      label={`Download ${f.name}`}
                      size="sm"
                      onClick={() => void downloadFile(f.id, f.name)}
                    >
                      <Download size={14} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
