import React, { useEffect, useRef, useState } from 'react';
import { X, Video, CalendarPlus, ExternalLink } from 'lucide-react';
import { IconButton, Spinner } from '../../components/ui';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useNotify } from '../../context/NotificationContext';
import { QuickSchedule } from '../meet/QuickSchedule';
import * as meetApi from '../meet/api';
import type { Conversation } from './types';

/**
 * Schedule a meeting from inside a conversation.
 *
 * `QuickSchedule` is reused verbatim rather than reimplemented. It already
 * knows the things that are easy to get wrong — never proposing a time in the
 * past, clamping suggestions to hours a school actually meets in, offering
 * times as chips rather than a masked input — and a second copy of that
 * judgement in the chat module would drift from the Meet one within a month.
 *
 * Two things happen on submit, and the order matters:
 *
 *  1. The meeting is created **against this conversation**. `meetings` already
 *     carries `conversation_id`, and the Meet join path already treats
 *     membership of that conversation as a grant — so everyone in the channel
 *     can join without being individually invited.
 *  2. A `call_event` message is posted carrying the meeting id, which renders
 *     as a live card. Posting a bare URL instead would produce a link that
 *     cannot say whether the meeting has started, who is in it, or that it was
 *     cancelled an hour ago.
 */

export const MeetSchedulePopover: React.FC<{
  conversation: Conversation;
  onClose: () => void;
  /** Sends the announcement message. Returns once it is on the wire. */
  onAnnounce: (input: {
    body: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
}> = ({ conversation, onClose, onAnnounce }) => {
  const { can } = usePermissions();
  const { notify } = useNotify();
  const navigate = useNavigate();

  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    // Deferred a tick: the click that opened this is still propagating.
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  /** Post the card, whatever kind of meeting was made. */
  const announce = async (meeting: {
    id: string; join_code: string; title: string;
    scheduled_start: string | null; scheduled_end: string | null;
  }, live: boolean) => {
    const at = meeting.scheduled_start
      ? new Date(meeting.scheduled_start).toLocaleString(undefined, {
          weekday: 'short', hour: '2-digit', minute: '2-digit',
        })
      : null;

    await onAnnounce({
      // The body is the fallback: if the card ever fails to render, the message
      // still says what it is and when.
      body: live
        ? `📹 ${meeting.title} — started a meeting`
        : `📅 ${meeting.title}${at ? ` — ${at}` : ''}`,
      metadata: {
        meet: {
          meetingId: meeting.id,
          joinCode: meeting.join_code,
          title: meeting.title,
          scheduledStart: meeting.scheduled_start,
          scheduledEnd: meeting.scheduled_end,
        },
      },
    });
  };

  const schedule = async (input: {
    title: string; scheduledStart: string; scheduledEnd: string; category: string;
  }) => {
    setBusy(true);
    try {
      const created = await meetApi.createMeeting({
        title: input.title,
        scheduledStart: input.scheduledStart,
        scheduledEnd: input.scheduledEnd,
        // The grant. Everyone in the conversation can join without an invite.
        conversationId: conversation.id,
        settings: { category: input.category },
      });
      await announce(created, false);
      notify({ title: 'Meeting scheduled and posted', tone: 'success', confirmation: true });
      onClose();
    } catch (err) {
      notify({
        title: 'Could not schedule that meeting',
        body: err instanceof Error ? err.message : undefined,
        tone: 'error',
      });
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const startNow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await meetApi.startInstant({
        title: conversation.type === 'dm'
          ? `Call with ${conversation.name}`
          : `${conversation.name} call`,
        conversationId: conversation.id,
      });
      await announce(created, true);
      onClose();
      // Straight into the room. Starting a call and then having to find it in
      // your own message log would be absurd.
      navigate(`/app/meet/${created.id}`);
    } catch (err) {
      notify({
        title: 'Could not start the meeting',
        body: err instanceof Error ? err.message : undefined,
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Start or schedule a meeting"
      className="absolute bottom-full right-0 z-50 mb-2 w-80 overflow-hidden rounded-2xl border border-border-light bg-white shadow-2xl dark:border-border-dark/50 dark:bg-elevated-dark"
    >
      <header className="flex items-center justify-between border-b border-border-light px-3 py-2 dark:border-border-dark/40">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-text-primary-light dark:text-text-primary-dark">
          <CalendarPlus size={12} /> Meeting
        </h3>
        <IconButton label="Close" size="sm" onClick={onClose}><X size={13} /></IconButton>
      </header>

      {can('MEET_START') && (
        <button
          onClick={() => void startNow()}
          disabled={busy}
          className="flex w-full items-center gap-2 border-b border-border-light px-3 py-2.5 text-left hover:bg-surface-light disabled:opacity-50 dark:border-border-dark/40 dark:hover:bg-surface-dark"
        >
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-red-100 text-red-600 dark:bg-red-500/20 dark:text-red-400">
            {busy ? <Spinner className="h-3 w-3" /> : <Video size={14} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-text-primary-light dark:text-text-primary-dark">
              Start now
            </span>
            <span className="block text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
              Posts the link here and takes you in
            </span>
          </span>
        </button>
      )}

      {can('MEET_SCHEDULE') ? (
        <div className="p-2">
          {/* The Meet module's own quick-create. Same judgement about times,
              same defaults, one implementation. */}
          <QuickSchedule
            day={new Date()}
            busy={busy}
            onSchedule={schedule}
            onOpenFull={() => { onClose(); navigate('/app/meet/new'); }}
          />
          <button
            onClick={() => { onClose(); navigate('/app/meet/new'); }}
            className="mt-1 flex w-full items-center justify-center gap-1 py-1 text-[11px] font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            <ExternalLink size={10} /> More options in Meet
          </button>
        </div>
      ) : (
        <p className="p-3 text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
          You do not have permission to schedule meetings.
        </p>
      )}
    </div>
  );
};
