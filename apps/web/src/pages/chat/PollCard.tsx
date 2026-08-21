import React, { useEffect, useState } from 'react';
import { BarChart3, Check, Lock, Users } from 'lucide-react';
import { Spinner } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { getSocket } from '../../lib/socket';
import * as chatApi from './api';

/**
 * A poll, rendered in the message log (FR-MSG-21).
 *
 * Results are live over the socket. A poll whose bars only move on reload is a
 * poll people vote in twice because they cannot tell the first one registered.
 *
 * Bars are shown before voting as well as after. Hiding results until you have
 * voted is a real design choice with a real cost — in a staff channel deciding
 * a date, being able to see that six people already chose Thursday is the point
 * of asking.
 */

export const PollCard: React.FC<{
  conversationId: string;
  messageId: string;
  onDark: boolean;
}> = ({ conversationId, messageId, onDark }) => {
  const { user } = useAuth();
  const [poll, setPoll] = useState<chatApi.WirePoll | null>(null);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    chatApi.getPollByMessage(conversationId, messageId)
      .then((p) => { if (!cancelled) setPoll(p); })
      .catch(() => { if (!cancelled) setMissing(true); });
    return () => { cancelled = true; };
  }, [conversationId, messageId]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onUpdate = (p: { conversationId: string; poll: unknown }) => {
      const incoming = p.poll as chatApi.WirePoll;
      // Only this poll. One channel can hold several, and every vote in any of
      // them arrives on the same event.
      if (incoming?.messageId === messageId) setPoll(incoming);
    };
    socket.on('poll:updated', onUpdate);
    return () => { socket.off('poll:updated', onUpdate); };
  }, [messageId]);

  if (missing) return null;
  if (!poll) {
    return (
      <div className="mt-1.5 flex items-center gap-2 text-xs opacity-70">
        <Spinner className="h-3 w-3" /> Loading poll…
      </div>
    );
  }

  const closed = Boolean(poll.closedAt)
    || (poll.closesAt !== null && new Date(poll.closesAt).getTime() < Date.now());
  const mine = new Set(poll.myVotes);

  const vote = async (optionId: string) => {
    if (closed || busy) return;
    setBusy(true);
    const next = poll.multiChoice
      ? (mine.has(optionId) ? poll.myVotes.filter((o) => o !== optionId) : [...poll.myVotes, optionId])
      // Single choice: clicking your own answer clears it, which is the only
      // way to un-vote without a separate control.
      : (mine.has(optionId) ? [] : [optionId]);
    try { setPoll(await chatApi.votePoll(poll.id, next)); }
    finally { setBusy(false); }
  };

  const close = async () => {
    setBusy(true);
    try { setPoll(await chatApi.closePoll(poll.id)); }
    finally { setBusy(false); }
  };

  const maxVotes = Math.max(...poll.options.map((o) => o.votes), 1);

  return (
    <div
      className={`mt-2 min-w-[16rem] max-w-sm rounded-xl border p-2.5 ${
        onDark ? 'border-white/25 bg-white/10' : 'border-border-light bg-surface-light dark:border-border-dark/50 dark:bg-card-dark/40'
      }`}
    >
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider opacity-70">
        <BarChart3 size={11} />
        Poll
        {poll.multiChoice && <span className="font-normal normal-case">· choose several</span>}
        {poll.anonymous && <span className="font-normal normal-case">· anonymous</span>}
        {closed && <span className="font-normal normal-case">· closed</span>}
      </p>

      <ul className="space-y-1.5">
        {poll.options.map((option) => {
          const chosen = mine.has(option.id);
          const share = poll.totalVoters > 0 ? option.votes / maxVotes : 0;
          return (
            <li key={option.id}>
              <button
                onClick={() => void vote(option.id)}
                disabled={closed || busy}
                aria-pressed={chosen}
                className={`relative w-full overflow-hidden rounded-lg border px-2.5 py-1.5 text-left transition-colors duration-150 disabled:cursor-default ${
                  chosen
                    ? 'border-blue-400 dark:border-blue-500'
                    : onDark ? 'border-white/25 hover:border-white/50' : 'border-border-light hover:border-blue-300 dark:border-border-dark'
                }`}
              >
                {/* The bar is a background layer, so the label stays readable at
                    every fill level rather than sitting on top of a colour that
                    changes under it. */}
                <span
                  className={`absolute inset-y-0 left-0 transition-[width] duration-300 ${
                    onDark ? 'bg-white/20' : 'bg-blue-100 dark:bg-blue-900/40'
                  }`}
                  style={{ width: `${Math.round(share * 100)}%` }}
                  aria-hidden="true"
                />
                <span className="relative flex items-center gap-2">
                  <span
                    className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
                      chosen
                        ? 'border-blue-600 bg-blue-600 text-white dark:border-blue-400 dark:bg-blue-500'
                        : onDark ? 'border-white/50' : 'border-slate-400'
                    }`}
                  >
                    {chosen && <Check size={10} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs">{option.text}</span>
                  <span className="shrink-0 text-[11px] font-semibold tabular-nums">
                    {option.votes}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-2 flex items-center gap-1.5 text-[11px] opacity-70">
        <Users size={10} />
        {poll.totalVoters} {poll.totalVoters === 1 ? 'person has' : 'people have'} voted
        {poll.createdBy === user?.id && !closed && (
          <button onClick={() => void close()} className="ml-auto flex items-center gap-1 font-medium underline">
            <Lock size={10} /> Close poll
          </button>
        )}
      </p>
    </div>
  );
};
