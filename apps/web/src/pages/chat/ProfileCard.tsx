import React, { useEffect, useRef, useState } from 'react';
import { X, MessageSquare, Clock, Briefcase } from 'lucide-react';
import { Avatar, IconButton, Spinner } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { useNotify } from '../../context/NotificationContext';
import { useChat } from './ChatProvider';
import * as chatApi from './api';
import { toPresence } from './types';

/**
 * The card behind every avatar (FR-USR-2).
 *
 * The point of it is the one action at the bottom: seeing who someone is is
 * usually a prelude to messaging them, and making that a separate journey
 * through a directory is the friction that stops people asking a colleague a
 * question.
 *
 * Their local time is shown when it differs from yours. In a school with staff
 * on different sites — and, for the MIS's overseas parents, different
 * countries — "it is 04:00 for them" is the difference between a reasonable
 * message and a bad one.
 */

const PRESENCE_LABEL: Record<string, string> = {
  online: 'Online',
  away: 'Away',
  busy: 'Busy',
  'in-a-meeting': 'In a meeting',
  dnd: 'Do not disturb',
  offline: 'Offline',
};

export const ProfileCard: React.FC<{
  userId: string;
  onClose: () => void;
  /** Anchored beside the avatar that opened it. */
  anchor?: 'left' | 'right';
}> = ({ userId, onClose, anchor = 'left' }) => {
  const { can } = usePermissions();
  const { notify } = useNotify();
  const { setActiveId, refresh } = useChat();

  const [profile, setProfile] = useState<chatApi.UserProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    chatApi.getProfile(userId)
      .then((p) => { if (!cancelled) setProfile(p); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const message = async () => {
    if (!profile || opening) return;
    setOpening(true);
    try {
      const conversation = await chatApi.openDirect(profile.id);
      await refresh();
      setActiveId(conversation.id);
      onClose();
    } catch (err) {
      notify({
        title: 'Could not open that conversation',
        body: err instanceof Error ? err.message : undefined,
        tone: 'error',
      });
    } finally {
      setOpening(false);
    }
  };

  /** Their wall-clock time, only when it is not also yours. */
  const theirTime = (() => {
    if (!profile?.timezone) return null;
    try {
      const mine = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const theirs = new Date().toLocaleTimeString(undefined, {
        hour: '2-digit', minute: '2-digit', timeZone: profile.timezone,
      });
      return theirs === mine ? null : theirs;
    } catch {
      // An unknown zone string must not take the card down with it.
      return null;
    }
  })();

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={profile ? `${profile.name}, profile` : 'Profile'}
      className={`absolute top-0 z-60 w-64 overflow-hidden rounded-2xl border border-border-light bg-white shadow-2xl dark:border-border-dark/50 dark:bg-elevated-dark ${
        anchor === 'left' ? 'left-10' : 'right-10'
      }`}
    >
      {failed ? (
        <p className="p-4 text-xs text-text-secondary-light dark:text-text-secondary-dark">
          That profile could not be loaded.
        </p>
      ) : !profile ? (
        <div className="grid h-32 place-items-center"><Spinner /></div>
      ) : (
        <>
          <div className="flex items-start gap-3 p-3.5">
            <Avatar
              name={profile.name}
              src={profile.avatarUrl ?? undefined}
              size={48}
              presence={toPresence(profile.presence)}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
                {profile.name}
                {profile.pronouns && (
                  <span className="ml-1.5 font-normal text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
                    ({profile.pronouns})
                  </span>
                )}
              </p>
              <p className="truncate text-[11px] capitalize text-text-secondary-light dark:text-text-secondary-dark">
                {profile.title || profile.role}
              </p>
              <p className="mt-0.5 text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
                {PRESENCE_LABEL[profile.presence] ?? 'Offline'}
              </p>
            </div>
            <IconButton label="Close profile" size="sm" onClick={onClose}><X size={14} /></IconButton>
          </div>

          {profile.statusText && (
            <p className="mx-3.5 mb-2 rounded-lg bg-surface-light px-2.5 py-1.5 text-xs text-text-primary-light dark:bg-card-dark/60 dark:text-text-primary-dark">
              {profile.statusEmoji && <span className="mr-1.5">{profile.statusEmoji}</span>}
              {profile.statusText}
            </p>
          )}

          <dl className="mx-3.5 mb-3 space-y-1 text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
            {theirTime && (
              <div className="flex items-center gap-1.5">
                <Clock size={11} /> <span>{theirTime} their time</span>
              </div>
            )}
            {profile.title && (
              <div className="flex items-center gap-1.5">
                <Briefcase size={11} /> <span className="truncate">{profile.title}</span>
              </div>
            )}
          </dl>

          {/* The reason the card exists. Hidden rather than shown-and-403 for
              someone without DM_START and no existing conversation. */}
          {(profile.directConversationId || can('DM_START')) && (
            <button
              onClick={() => void message()}
              disabled={opening}
              className="flex w-full items-center justify-center gap-1.5 border-t border-border-light py-2.5 text-xs font-medium text-blue-600 hover:bg-surface-light disabled:opacity-50 dark:border-border-dark/40 dark:text-blue-400 dark:hover:bg-surface-dark"
            >
              {opening ? <Spinner className="h-3 w-3" /> : <MessageSquare size={13} />}
              Message {profile.name.split(' ')[0]}
            </button>
          )}
        </>
      )}
    </div>
  );
};
