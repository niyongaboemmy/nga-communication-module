import React, { useState } from 'react';
import { CalendarDays, MapPin, Video, Check, BarChart3, Clock } from 'lucide-react';
import type { FeedEventView, FeedPollView } from '@tupo/shared';
import { useFeed } from './FeedProvider';
import { fullTime } from './lib';

export const PollBlock: React.FC<{ postId: string; poll: FeedPollView }> = ({ postId, poll }) => {
  const { vote } = useFeed();
  const [busy, setBusy] = useState(false);
  const voted = poll.myVotes.length > 0;
  const showResults = voted || poll.closed;
  const max = Math.max(1, ...poll.options.map((o) => o.votes));

  const choose = async (i: number) => {
    if (poll.closed || busy) return;
    const next = poll.multi
      ? (poll.myVotes.includes(i) ? poll.myVotes.filter((x) => x !== i) : [...poll.myVotes, i])
      : [i];
    // The server has no "clear my vote" — choices can't be empty. Unchecking
    // the last option in a multi-select poll must leave the vote as it is
    // rather than silently resending the option the click just tried to
    // remove, which looked like the click had done nothing at all.
    if (!next.length) return;
    setBusy(true);
    try { await vote(postId, next); } finally { setBusy(false); }
  };

  return (
    <div className="mt-3 rounded-xl border border-border-light p-3 dark:border-border-dark/50">
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
        <BarChart3 size={15} className="text-blue-600 dark:text-blue-400" /> {poll.question}
      </p>
      <div className="space-y-1.5">
        {poll.options.map((opt, i) => {
          const pct = poll.totalVoters ? Math.round((opt.votes / Math.max(1, poll.totalVoters)) * 100) : 0;
          const mine = poll.myVotes.includes(i);
          return (
            <button
              key={i}
              onClick={() => choose(i)}
              disabled={poll.closed}
              className={`relative w-full overflow-hidden rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                mine ? 'border-blue-500 bg-blue-50/60 dark:bg-blue-900/20' : 'border-border-light hover:border-blue-300 dark:border-border-dark/60'
              } ${poll.closed ? 'cursor-default' : ''}`}
            >
              {showResults && (
                <span
                  className="feed-bar-grow absolute inset-y-0 left-0 bg-blue-100/70 dark:bg-blue-800/30"
                  style={{ width: `${(opt.votes / max) * 100}%` }}
                  aria-hidden
                />
              )}
              <span className="relative flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-medium text-text-primary-light dark:text-text-primary-dark">
                  {mine && <Check size={14} className="text-blue-600 dark:text-blue-400" />}
                  {opt.text}
                </span>
                {showResults && <span className="tabular-nums text-xs text-text-secondary-light dark:text-text-secondary-dark">{pct}%</span>}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 flex items-center gap-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">
        <span>{poll.totalVoters} {poll.totalVoters === 1 ? 'vote' : 'votes'}</span>
        {poll.multi && <span>· Choose several</span>}
        {poll.closesAt && (
          <span className="flex items-center gap-1">
            · <Clock size={11} /> {poll.closed ? 'Closed' : `Closes ${fullTime(poll.closesAt)}`}
          </span>
        )}
      </p>
    </div>
  );
};

export const EventBlock: React.FC<{ postId: string; event: FeedEventView }> = ({ postId, event }) => {
  const { rsvp } = useFeed();
  const [busy, setBusy] = useState(false);
  const start = new Date(event.startsAt);
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try { await rsvp(postId, !event.going); } finally { setBusy(false); }
  };

  return (
    <div className="mt-3 flex gap-3 overflow-hidden rounded-xl border border-border-light dark:border-border-dark/50">
      <div className="flex w-16 shrink-0 flex-col items-center justify-center bg-blue-600 py-3 text-white">
        <span className="text-[10px] font-semibold uppercase tracking-wide">{start.toLocaleDateString(undefined, { month: 'short' })}</span>
        <span className="text-2xl font-bold leading-none">{start.getDate()}</span>
      </div>
      <div className="min-w-0 flex-1 py-2.5 pr-3">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
          <CalendarDays size={14} className="text-blue-600 dark:text-blue-400" /> {event.title}
        </p>
        <p className="mt-0.5 text-xs text-text-secondary-light dark:text-text-secondary-dark">
          {fullTime(event.startsAt)}{event.endsAt ? ` – ${new Date(event.endsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}
        </p>
        {event.location && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-text-secondary-light dark:text-text-secondary-dark">
            <MapPin size={11} /> {event.location}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            onClick={toggle}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
              event.going ? 'bg-blue-600 text-white' : 'border border-border-light text-text-primary-light hover:bg-surface-light dark:border-border-dark/60 dark:text-text-primary-dark'
            }`}
          >
            {event.going ? <><Check size={13} /> Going</> : 'Going'}
          </button>
          {event.meetingId && (
            <a href={`/app/meet/${event.meetingId}`} className="inline-flex items-center gap-1.5 rounded-full border border-border-light px-3 py-1 text-xs font-semibold text-text-primary-light hover:bg-surface-light dark:border-border-dark/60 dark:text-text-primary-dark">
              <Video size={13} /> Join
            </a>
          )}
          <a
            href={calendarLink(event)}
            download="event.ics"
            className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Add to calendar
          </a>
          <span className="text-xs text-text-secondary-light dark:text-text-secondary-dark">{event.goingCount} going</span>
        </div>
      </div>
    </div>
  );
};

function calendarLink(e: FeedEventView): string {
  const fmt = (d: string) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
    `SUMMARY:${e.title}`,
    `DTSTART:${fmt(e.startsAt)}`,
    e.endsAt ? `DTEND:${fmt(e.endsAt)}` : '',
    e.location ? `LOCATION:${e.location}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  return `data:text/calendar;charset=utf8,${encodeURIComponent(ics)}`;
}
