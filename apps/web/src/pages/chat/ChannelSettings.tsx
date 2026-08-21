import React, { useEffect, useState } from 'react';
import {
  X, Settings, Archive, LogOut, Link2, Crown, Shield, UserMinus, Timer, Copy, Check,
} from 'lucide-react';
import { Avatar, Button, IconButton, Spinner } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { useNotify } from '../../context/NotificationContext';
import { useAuth } from '../../context/AuthContext';
import { useChat } from './ChatProvider';
import * as chatApi from './api';
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
 */

const RETENTION_CHOICES: Array<{ days: number | null; label: string }> = [
  { days: null, label: 'Keep everything' },
  { days: 1, label: '24 hours' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: 'A year' },
];

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

  const [topic, setTopic] = useState(c.topic ?? '');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<chatApi.InviteLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<'archive' | 'leave' | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const iAmOwner = c.myRole === 'owner';
  const iCanManage = iAmOwner || c.myRole === 'admin';

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

  const makeInvite = () => run(async () => {
    const link = await chatApi.createInvite(c.id, { expiresInHours: 24 * 7 });
    setInvite(link);
  });

  const copyInvite = async () => {
    if (!invite) return;
    const url = `${window.location.origin}/app/chat/invite/${invite.code}`;
    await navigator.clipboard?.writeText(url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <aside
      aria-label="Channel settings"
      className="flex h-full min-h-0 w-full flex-col border-l border-border-light bg-white dark:border-border-dark/30 dark:bg-chrome-dark"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-light px-3 dark:border-border-dark/30">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
          <Settings size={15} /> Channel settings
          {busy && <Spinner className="h-3 w-3" />}
        </h2>
        <IconButton label="Close channel settings" onClick={onClose}><X size={18} /></IconButton>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        {iCanManage && can('CHANNEL_MANAGE') && (
          <section>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
              Topic
            </h3>
            <textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onBlur={() => {
                if (topic !== (c.topic ?? '')) {
                  void run(() => chatApi.updateConversation(c.id, { topic: topic || null }));
                }
              }}
              rows={2}
              aria-label="Channel topic"
              placeholder="What is this channel for?"
              className="w-full resize-none rounded-lg border border-border-light bg-surface-light px-2.5 py-1.5 text-xs text-text-primary-light outline-none focus:border-blue-500 dark:border-border-dark/50 dark:bg-elevated-dark/60 dark:text-text-primary-dark"
            />
          </section>
        )}

        {/* ── Members ─────────────────────────────────────────────────── */}
        <section>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
            Members · {members.length}
          </h3>
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
                          `${m.name} now owns this channel`,
                        )}
                      >
                        <Crown size={13} />
                      </IconButton>
                    )}
                    {can('CHANNEL_MEMBERS_MANAGE') && (
                      <IconButton
                        label={`Remove ${m.name} from the channel`}
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
        {iCanManage && can('CHANNEL_MEMBERS_MANAGE') && (
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
                    ? 'Reopen this channel so people can post again?'
                    : 'Archive this channel? It stays readable and searchable, but nobody can post.'}
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
                        c.isArchived ? 'Channel reopened' : 'Channel archived');
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
                <Archive size={13} /> {c.isArchived ? 'Reopen this channel' : 'Archive this channel'}
              </button>
            )
          )}

          {confirming === 'leave' ? (
            <div className="rounded-lg border border-red-300 bg-red-50 p-2.5 dark:border-red-500/40 dark:bg-red-500/10">
              <p className="mb-2 text-xs text-red-900 dark:text-red-200">
                {iAmOwner
                  ? 'You own this channel. Make someone else the owner before you leave.'
                  : 'Leave this channel? You will stop receiving its messages.'}
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
                      }, 'You left the channel');
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
              <LogOut size={13} /> Leave this channel
            </button>
          )}
        </section>
      </div>
    </aside>
  );
};
