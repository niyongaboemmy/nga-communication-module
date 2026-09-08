import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Settings, Archive, LogOut, Link2, Crown, Shield, UserMinus, Timer, Copy, Check,
  Camera, Trash2, UserPlus, Search, Loader2,
} from 'lucide-react';
import { Avatar, Button, IconButton, Spinner } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { useNotify } from '../../context/NotificationContext';
import { useAuth } from '../../context/AuthContext';
import { apiGet } from '../../lib/api';
import { useChat } from './ChatProvider';
import * as chatApi from './api';
import { uploadFile, validateFile, useMediaUrl } from './uploads';
import { toPresence } from './types';
import type { Conversation, Member } from './types';

/**
 * Channel administration (FR-CHN-3, 4, 6, 7 and FR-MSG-19).
 *
 * Everything destructive states its consequence before it happens rather than
 * after: archiving says the channel becomes read-only, retention says how much
 * history will be deleted *and* that it applies to what is already there. In a
 * school the person doing this is a teacher between lessons, not an
 * administrator who will read a manual.
 *
 * Text fields save on blur rather than behind a Save button. There is no
 * half-applied state to protect — every field is independent — and a settings
 * panel with a Save button is a settings panel people leave without pressing
 * it.
 */

const RETENTION_CHOICES: Array<{ days: number | null; label: string }> = [
  { days: null, label: 'Keep everything' },
  { days: 1, label: '24 hours' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: 'A year' },
];

interface Person {
  id: string;
  name: string;
  avatarUrl: string | null;
  role: string;
  email: string;
  presence: string;
}

/** The logo well: shows the current picture, or the emoji/colour tile it falls
 *  back to, and takes a new one on click. */
const LogoPicker: React.FC<{
  conversation: Conversation;
  url: string | null;
  editable: boolean;
  busy: boolean;
  onPick: (file: File) => void;
  onClear: () => void;
}> = ({ conversation: c, url, editable, busy, onPick, onClear }) => {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-3">
      <div className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-2xl">
        {url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <span
            className="grid h-full w-full place-items-center bg-slate-100 text-2xl font-bold text-slate-500 dark:bg-card-dark/60 dark:text-slate-300"
            style={c.avatarColor ? { background: c.avatarColor } : undefined}
          >
            {c.iconEmoji ?? '#'}
          </span>
        )}
        {editable && (
          <button
            type="button"
            aria-label="Upload a logo"
            title="Upload a logo"
            disabled={busy}
            onClick={() => input.current?.click()}
            className="absolute inset-0 grid place-items-center rounded-2xl bg-black/0 text-white opacity-0 transition-all duration-150 hover:bg-black/45 hover:opacity-100 focus-visible:bg-black/45 focus-visible:opacity-100 group-hover:opacity-100"
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Camera size={18} />}
          </button>
        )}
        {editable && (
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPick(f);
              e.target.value = '';
            }}
          />
        )}
      </div>
      {editable && (
        <div className="min-w-0">
          <p className="text-xs font-medium text-text-primary-light dark:text-text-primary-dark">Logo</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-text-secondary-light dark:text-text-secondary-dark">
            Shown everywhere this {c.type === 'group' ? 'group' : 'channel'} appears.
          </p>
          {c.avatarFileId && (
            <button
              onClick={onClear}
              disabled={busy}
              className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-red-600 hover:underline disabled:opacity-40 dark:text-red-400"
            >
              <Trash2 size={11} /> Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export const ChannelSettings: React.FC<{
  conversation: Conversation;
  members: Member[];
  /** Called after anything that changes the membership, so the list reloads. */
  onMembersChanged: () => void;
  onClose: () => void;
}> = ({ conversation: c, members, onMembersChanged, onClose }) => {
  const { can } = usePermissions();
  const { user } = useAuth();
  const { notify } = useNotify();
  const { refresh, setActiveId } = useChat();

  const [name, setName] = useState(c.name);
  const [topic, setTopic] = useState(c.topic ?? '');
  const [description, setDescription] = useState(c.description ?? '');
  const [busy, setBusy] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [invite, setInvite] = useState<chatApi.InviteLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<'archive' | 'leave' | null>(null);

  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<Person[]>([]);
  const [searching, setSearching] = useState(false);

  const { url: logoUrl } = useMediaUrl(c.avatarFileId);
  const kind = c.type === 'group' ? 'group' : 'channel';

  // The panel stays mounted across a switch of conversation, so re-seed the
  // fields or they keep showing the previous one's name.
  useEffect(() => {
    setName(c.name);
    setTopic(c.topic ?? '');
    setDescription(c.description ?? '');
  }, [c.id, c.name, c.topic, c.description]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Debounced directory search, same shape as the new-conversation picker —
  // a request per keystroke would be a request per keystroke.
  useEffect(() => {
    if (!adding) return;
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      apiGet<{ people: Person[] }>(`/api/chat/directory?q=${encodeURIComponent(query)}`)
        .then((r) => { if (!cancelled) setPeople(r.data!.people); })
        .catch(() => { if (!cancelled) setPeople([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, adding]);

  const iAmOwner = c.myRole === 'owner';
  const iCanManage = iAmOwner || c.myRole === 'admin';
  const canEditDetails = iCanManage && can('CHANNEL_MANAGE');
  const canManageMembers = iCanManage && can('CHANNEL_MEMBERS_MANAGE');

  // Somebody already in the room is not a search result — offering them again
  // and failing silently on click is worse than not offering them.
  const memberIds = useMemo(() => new Set(members.map((m) => m.userId)), [members]);
  const candidates = useMemo(
    () => people.filter((p) => !memberIds.has(p.id)),
    [people, memberIds],
  );

  const run = async (what: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await what();
      await refresh();
      onMembersChanged();
      if (success) notify({ title: success, tone: 'success', confirmation: true });
    } catch (err) {
      notify({
        title: 'That did not work',
        body: err instanceof Error ? err.message : undefined,
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  const saveLogo = async (file: File) => {
    const invalid = validateFile(file);
    if (invalid) { notify({ title: invalid, tone: 'error' }); return; }
    setLogoBusy(true);
    try {
      const fileId = await uploadFile(file, () => {}).promise;
      await chatApi.updateConversation(c.id, { avatarFileId: fileId });
      await refresh();
      notify({ title: 'Logo updated', tone: 'success', confirmation: true });
    } catch (err) {
      notify({
        title: 'The logo could not be saved',
        body: err instanceof Error ? err.message : undefined,
        tone: 'error',
      });
    } finally {
      setLogoBusy(false);
    }
  };

  const makeInvite = () => run(async () => {
    const link = await chatApi.createInvite(c.id, { expiresInHours: 24 * 7 });
    setInvite(link);
  });

  const copyInvite = async () => {
    if (!invite) return;
    const url = `${window.location.origin}/app/chat/invite/${invite.code}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify({ title: 'Could not copy the link', tone: 'error' });
    }
  };

  return (
    <aside
      aria-label={`${kind === 'group' ? 'Group' : 'Channel'} settings`}
      className="flex h-full min-h-0 w-full flex-col border-l border-border-light bg-white dark:border-border-dark/30 dark:bg-chrome-dark"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-light px-3 dark:border-border-dark/30">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
          <Settings size={15} /> {kind === 'group' ? 'Group' : 'Channel'} settings
          {busy && <Spinner className="h-3 w-3" />}
        </h2>
        <IconButton label={`Close ${kind} settings`} onClick={onClose}><X size={18} /></IconButton>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        {/* ── Identity: logo, name, topic, description ───────────────────── */}
        {canEditDetails ? (
          <section className="space-y-3">
            <LogoPicker
              conversation={c}
              url={logoUrl}
              editable
              busy={logoBusy}
              onPick={(f) => void saveLogo(f)}
              onClear={() => void run(
                () => chatApi.updateConversation(c.id, { avatarFileId: null }),
                'Logo removed',
              )}
            />

            <div>
              <label
                htmlFor="channel-name"
                className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70"
              >
                Name
              </label>
              <input
                id="channel-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => {
                  const next = name.trim();
                  // The server rejects an empty name; snapping back is kinder
                  // than an error toast for what is almost always a mid-edit
                  // click somewhere else.
                  if (!next) { setName(c.name); return; }
                  if (next !== c.name) {
                    void run(() => chatApi.updateConversation(c.id, { name: next }), 'Name updated');
                  }
                }}
                maxLength={80}
                className="w-full rounded-lg border border-border-light bg-surface-light px-2.5 py-1.5 text-xs text-text-primary-light outline-none focus:border-blue-500 dark:border-border-dark/50 dark:bg-elevated-dark/60 dark:text-text-primary-dark"
              />
            </div>

            <div>
              <label
                htmlFor="channel-topic"
                className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70"
              >
                Topic
              </label>
              <textarea
                id="channel-topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                onBlur={() => {
                  if (topic !== (c.topic ?? '')) {
                    void run(() => chatApi.updateConversation(c.id, { topic: topic || null }));
                  }
                }}
                rows={2}
                maxLength={200}
                placeholder={`What is this ${kind} for?`}
                className="w-full resize-none rounded-lg border border-border-light bg-surface-light px-2.5 py-1.5 text-xs text-text-primary-light outline-none focus:border-blue-500 dark:border-border-dark/50 dark:bg-elevated-dark/60 dark:text-text-primary-dark"
              />
            </div>

            <div>
              <label
                htmlFor="channel-description"
                className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70"
              >
                Description
              </label>
              <textarea
                id="channel-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => {
                  if (description !== (c.description ?? '')) {
                    void run(
                      () => chatApi.updateConversation(c.id, { description: description || null }),
                      'Description updated',
                    );
                  }
                }}
                rows={3}
                maxLength={1000}
                placeholder="The longer version — who belongs here, and what gets posted."
                className="w-full resize-none rounded-lg border border-border-light bg-surface-light px-2.5 py-1.5 text-xs text-text-primary-light outline-none focus:border-blue-500 dark:border-border-dark/50 dark:bg-elevated-dark/60 dark:text-text-primary-dark"
              />
            </div>
          </section>
        ) : (
          /* Read-only identity, so a plain member still sees what they are in. */
          <section>
            <LogoPicker
              conversation={c}
              url={logoUrl}
              editable={false}
              busy={false}
              onPick={() => {}}
              onClear={() => {}}
            />
          </section>
        )}

        {/* ── Members ─────────────────────────────────────────────────── */}
        <section>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
              Members · {members.length}
            </h3>
            {canManageMembers && (
              <button
                onClick={() => { setAdding((v) => !v); setQuery(''); }}
                aria-expanded={adding}
                className="inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/20"
              >
                <UserPlus size={12} /> {adding ? 'Done' : 'Add people'}
              </button>
            )}
          </div>

          {adding && canManageMembers && (
            <div className="mb-2 rounded-lg border border-border-light bg-surface-light p-2 dark:border-border-dark/50 dark:bg-elevated-dark/60">
              <div className="relative">
                <Search
                  size={13}
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary-light dark:text-text-secondary-dark"
                />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search people by name or email"
                  aria-label="Search people to add"
                  className="w-full rounded-md border border-border-light bg-white py-1.5 pl-7 pr-2 text-xs text-text-primary-light outline-none focus:border-blue-500 dark:border-border-dark/50 dark:bg-card-dark/60 dark:text-text-primary-dark"
                />
              </div>

              <div className="mt-1.5 max-h-56 overflow-y-auto">
                {searching && candidates.length === 0 ? (
                  <p className="px-1 py-2 text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
                    Searching…
                  </p>
                ) : candidates.length === 0 ? (
                  <p className="px-1 py-2 text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
                    {query.trim()
                      ? 'Nobody matches — or everyone who does is already here.'
                      : 'Everyone found is already in this ' + kind + '.'}
                  </p>
                ) : (
                  <ul className="space-y-0.5">
                    {candidates.map((p) => (
                      <li key={p.id}>
                        <button
                          disabled={busy}
                          onClick={() => void run(
                            () => chatApi.addMembers(c.id, [p.id]),
                            `${p.name} was added`,
                          )}
                          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-white disabled:opacity-40 dark:hover:bg-card-dark/60"
                        >
                          <Avatar name={p.name} src={p.avatarUrl ?? undefined} size={24} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium text-text-primary-light dark:text-text-primary-dark">
                              {p.name}
                            </span>
                            <span className="block truncate text-[10px] text-text-secondary-light dark:text-text-secondary-dark">
                              {p.email}
                            </span>
                          </span>
                          <UserPlus size={13} className="shrink-0 text-blue-600 dark:text-blue-400" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          <ul className="space-y-0.5">
            {members.map((m) => (
              <li
                key={m.userId}
                className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-light dark:hover:bg-surface-dark"
              >
                <Avatar
                  name={m.name}
                  src={m.avatarUrl ?? undefined}
                  size={28}
                  presence={toPresence(m.presence)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-text-primary-light dark:text-text-primary-dark">
                    {m.name}{m.userId === user?.id && ' (you)'}
                  </span>
                  <span className="flex items-center gap-1 text-[11px] capitalize text-text-secondary-light dark:text-text-secondary-dark">
                    {m.role === 'owner' && <Crown size={9} className="text-amber-500" />}
                    {m.role === 'admin' && <Shield size={9} className="text-blue-500" />}
                    {m.role === 'member' ? (m.platformRole ?? 'Member') : m.role}
                  </span>
                </span>

                {iCanManage && m.userId !== user?.id && m.role !== 'owner' && (
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    {can('CHANNEL_MEMBERS_MANAGE') && (
                      <IconButton
                        label={m.role === 'admin' ? `Demote ${m.name} to member` : `Make ${m.name} an admin`}
                        size="sm"
                        onClick={() => void run(
                          () => chatApi.setMemberRole(c.id, m.userId, m.role === 'admin' ? 'member' : 'admin'),
                          m.role === 'admin' ? `${m.name} is now a member` : `${m.name} is now an admin`,
                        )}
                      >
                        <Shield size={13} />
                      </IconButton>
                    )}
                    {iAmOwner && (
                      <IconButton
                        label={`Make ${m.name} the owner`}
                        size="sm"
                        onClick={() => void run(
                          () => chatApi.transferOwnership(c.id, m.userId),
                          `${m.name} now owns this ${kind}`,
                        )}
                      >
                        <Crown size={13} />
                      </IconButton>
                    )}
                    {can('CHANNEL_MEMBERS_MANAGE') && (
                      <IconButton
                        label={`Remove ${m.name} from the ${kind}`}
                        size="sm"
                        onClick={() => void run(
                          () => chatApi.removeMember(c.id, m.userId), `${m.name} was removed`)}
                      >
                        <UserMinus size={13} />
                      </IconButton>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>

        {/* ── Invite link ─────────────────────────────────────────────── */}
        {canManageMembers && (
          <section>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
              <Link2 size={11} /> Invite link
            </h3>
            {invite ? (
              <div className="rounded-lg border border-border-light bg-surface-light p-2 dark:border-border-dark/50 dark:bg-elevated-dark/60">
                <p className="mb-1.5 break-all font-mono text-[10px] text-text-secondary-light dark:text-text-secondary-dark">
                  /app/chat/invite/{invite.code}
                </p>
                <div className="flex items-center gap-2">
                  <Button onClick={() => void copyInvite()} className="text-xs">
                    {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy link</>}
                  </Button>
                  <span className="text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
                    Expires in 7 days
                  </span>
                </div>
              </div>
            ) : (
              <Button variant="ghost" onClick={makeInvite} className="text-xs">
                Create an invite link
              </Button>
            )}
          </section>
        )}

        {/* ── Disappearing messages ───────────────────────────────────── */}
        {iCanManage && (can('CHANNEL_MANAGE') || can('RETENTION_MANAGE')) && (
          <section>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
              <Timer size={11} /> Disappearing messages
            </h3>
            <div className="flex flex-wrap gap-1">
              {RETENTION_CHOICES.map(({ days, label }) => (
                <button
                  key={label}
                  onClick={() => void run(
                    () => chatApi.setRetention(c.id, days),
                    days === null ? 'Messages will be kept' : `Messages will disappear after ${label}`,
                  )}
                  className="rounded-full border border-border-light px-2 py-0.5 text-[11px] font-medium text-text-secondary-light transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-border-dark dark:text-text-secondary-dark"
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-text-secondary-light dark:text-text-secondary-dark">
              Applies to messages already sent as well as new ones. Deleted permanently — no
              record is left that a message was here.
            </p>
          </section>
        )}

        {/* ── Dangerous things, stated plainly ────────────────────────── */}
        <section className="border-t border-border-light pt-3 dark:border-border-dark/40">
          {iCanManage && can('CHANNEL_ARCHIVE') && (
            confirming === 'archive' ? (
              <div className="mb-2 rounded-lg border border-amber-300 bg-amber-50 p-2.5 dark:border-amber-500/40 dark:bg-amber-500/10">
                <p className="mb-2 text-xs text-amber-900 dark:text-amber-200">
                  {c.isArchived
                    ? `Reopen this ${kind} so people can post again?`
                    : `Archive this ${kind}? It stays readable and searchable, but nobody can post.`}
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setConfirming(null)}
                    className="rounded-lg px-2 py-1 text-xs text-text-secondary-light dark:text-text-secondary-dark"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      setConfirming(null);
                      void run(() => chatApi.setArchived(c.id, !c.isArchived),
                        c.isArchived ? 'Reopened' : 'Archived');
                    }}
                    className="rounded-lg bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700"
                  >
                    {c.isArchived ? 'Reopen' : 'Archive'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirming('archive')}
                className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-surface-dark"
              >
                <Archive size={13} /> {c.isArchived ? `Reopen this ${kind}` : `Archive this ${kind}`}
              </button>
            )
          )}

          {confirming === 'leave' ? (
            <div className="rounded-lg border border-red-300 bg-red-50 p-2.5 dark:border-red-500/40 dark:bg-red-500/10">
              <p className="mb-2 text-xs text-red-900 dark:text-red-200">
                {iAmOwner
                  ? `You own this ${kind}. Make someone else the owner before you leave.`
                  : `Leave this ${kind}? You will stop receiving its messages.`}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setConfirming(null)}
                  className="rounded-lg px-2 py-1 text-xs text-text-secondary-light dark:text-text-secondary-dark"
                >
                  Cancel
                </button>
                {!iAmOwner && (
                  <button
                    onClick={() => {
                      setConfirming(null);
                      void run(async () => {
                        await chatApi.removeMember(c.id, user!.id);
                        setActiveId(null);
                        onClose();
                      }, `You left the ${kind}`);
                    }}
                    className="rounded-lg bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700"
                  >
                    Leave
                  </button>
                )}
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirming('leave')}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
            >
              <LogOut size={13} /> Leave this {kind}
            </button>
          )}
        </section>
      </div>
    </aside>
  );
};
