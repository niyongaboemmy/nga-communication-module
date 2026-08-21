import React, { useEffect, useState } from 'react';
import { Video, Calendar, Users, Radio, CalendarPlus, Copy, Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Spinner } from '../../components/ui';
import * as meetApi from '../meet/api';

/**
 * A meeting, as it appears in the message log.
 *
 * A `call_event` message carries the meeting id in its metadata rather than a
 * URL in its body, so the card can show *live* state — "3 people are in this
 * now" is the information that decides whether someone joins, and a link posted
 * an hour ago cannot tell them that.
 *
 * The body text is kept as a readable fallback. If this component ever fails to
 * load, the message still says what it is and when.
 */

export interface MeetMessageMetadata {
  meetingId: string;
  joinCode: string;
  title: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
}

const when = (iso: string): string => {
  const at = new Date(iso);
  const today = new Date();
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  if (at.toDateString() === today.toDateString()) return `Today at ${time}`;
  const tomorrow = new Date(today.getTime() + 86_400_000);
  if (at.toDateString() === tomorrow.toDateString()) return `Tomorrow at ${time}`;
  return `${at.toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
  })} at ${time}`;
};

export const MeetCard: React.FC<{
  meta: MeetMessageMetadata;
  onDark: boolean;
}> = ({ meta, onDark }) => {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<meetApi.MeetingDetail | null>(null);
  const [gone, setGone] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    meetApi.getMeeting(meta.meetingId)
      .then((r) => { if (!cancelled) setDetail(r); })
      // A cancelled or purged meeting is not an error worth shouting about;
      // the card just stops claiming the meeting is joinable.
      .catch(() => { if (!cancelled) setGone(true); });
    return () => { cancelled = true; };
  }, [meta.meetingId]);

  const status = detail?.status ?? (gone ? 'cancelled' : null);
  const live = status === 'live';
  const ended = status === 'ended' || status === 'cancelled';
  const startsAt = detail?.scheduled_start ?? meta.scheduledStart;

  const copyLink = async () => {
    const url = `${window.location.origin}/meet/${meta.joinCode}`;
    await navigator.clipboard?.writeText(url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={`mt-2 min-w-[15rem] max-w-sm overflow-hidden rounded-xl border ${
        onDark
          ? 'border-white/25 bg-white/10'
          : 'border-border-light bg-surface-light dark:border-border-dark/50 dark:bg-card-dark/40'
      }`}
    >
      <div className="flex items-start gap-2.5 p-2.5">
        <span
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
            live
              ? 'bg-red-500 text-white'
              : onDark ? 'bg-white/20' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
          }`}
        >
          {live ? <Radio size={16} /> : <Video size={16} />}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{detail?.title ?? meta.title}</p>

          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] opacity-80">
            {!detail && !gone ? (
              <span className="flex items-center gap-1"><Spinner className="h-2.5 w-2.5" /> Checking…</span>
            ) : live ? (
              <span className="font-semibold text-red-600 dark:text-red-400">Live now</span>
            ) : ended ? (
              <span>{status === 'cancelled' ? 'Cancelled' : 'Ended'}</span>
            ) : startsAt ? (
              <span className="flex items-center gap-1"><Calendar size={10} /> {when(startsAt)}</span>
            ) : (
              <span>Ready to join</span>
            )}

            {live && (detail?.active_count ?? 0) > 0 && (
              <span className="flex items-center gap-1">
                <Users size={10} /> {detail!.active_count} in the room
              </span>
            )}
          </p>
        </div>
      </div>

      <div
        className={`flex items-center gap-1 border-t px-2 py-1.5 ${
          onDark ? 'border-white/20' : 'border-border-light dark:border-border-dark/40'
        }`}
      >
        <button
          onClick={() => navigate(`/app/meet/${meta.meetingId}`)}
          disabled={ended}
          className={`flex-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            live
              ? 'bg-red-600 text-white hover:bg-red-700'
              : onDark
                ? 'bg-white/20 text-white hover:bg-white/30'
                : 'bg-blue-600 text-white hover:bg-blue-700'
          }`}
        >
          {live ? 'Join now' : ended ? 'Meeting over' : 'Join'}
        </button>

        {!ended && (
          <button
            onClick={() => void copyLink()}
            aria-label="Copy the meeting link"
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
              onDark ? 'hover:bg-white/20' : 'hover:bg-black/5 dark:hover:bg-white/10'
            }`}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        )}
      </div>
    </div>
  );
};

/** The icon used for the composer's "schedule a meeting" control. */
export const MeetScheduleIcon = CalendarPlus;
