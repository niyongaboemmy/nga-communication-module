import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Loader2, LogIn, Video } from 'lucide-react';
import type { MeetJoinTicket } from '@tupo/shared';
import { MEET_GUEST_KEY, SESSION_KEY } from '../../lib/api';
import { Logo } from '../../components/Logo';
import * as meetApi from './api';
import type { PublicMeetingInfo } from './api';

/**
 * The public join screen — the one page in Tupo a stranger can reach.
 *
 * This does not weaken "Tupo has no login of its own". Nothing here creates an
 * account: typing a name mints a ticket bound to one participant row in one
 * meeting, and that ticket dies with the meeting. A guest still waits in the
 * lobby until a host lets them in, and holds exactly one permission.
 *
 * Anyone who already has a session is sent through the normal route instead —
 * a member of staff following a public link should join as themselves, not as
 * an anonymous attendee.
 */

export const GuestJoin: React.FC<{ onReady: (p: {
  ticket: MeetJoinTicket; info: PublicMeetingInfo;
}) => void }> = ({ onReady }) => {
  const { idOrCode = '' } = useParams();
  const navigate = useNavigate();

  const [info, setInfo] = useState<PublicMeetingInfo | null>(null);
  const [name, setName] = useState(() => localStorage.getItem('tupo_guest_name') ?? '');
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Already signed in? Then this is not a guest at all.
    if (localStorage.getItem(SESSION_KEY)) {
      navigate(`/app/meet/${idOrCode}`, { replace: true });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const found = await meetApi.getPublicMeeting(idOrCode);
        if (!cancelled) setInfo(found);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'That meeting is not available.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [idOrCode, navigate]);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const displayName = name.trim();
    if (displayName.length < 2 || !info) return;

    setJoining(true);
    setError(null);
    try {
      const ticket = await meetApi.joinAsGuest(idOrCode, displayName);
      // Stored so a reload during the meeting does not eject them.
      localStorage.setItem(MEET_GUEST_KEY, ticket.guestToken ?? '');
      localStorage.setItem('tupo_guest_name', displayName);
      onReady({ ticket, info });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join the meeting.');
      setJoining(false);
    }
  };

  if (loading) {
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-950">
        <Loader2 size={22} className="animate-spin text-white/30" />
      </div>
    );
  }

  if (!info) {
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-950 p-6 text-center">
        <div className="max-w-sm">
          <AlertTriangle size={26} className="mx-auto text-amber-400" />
          <h1 className="mt-4 text-base font-semibold text-white">This meeting is not open to guests</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-white/50">
            {error ?? 'Check the link, or sign in if you have an NGA account.'}
          </p>
          <a
            href="/"
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"
          >
            <LogIn size={15} /> Sign in with NGA MIS
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-slate-950 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Logo size={26} />
          <span className="text-base font-bold tracking-tight text-white">Tupo</span>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-900 p-5">
          <div className="mb-4 flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-600/20 text-blue-300">
              <Video size={19} />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-white">{info.title}</h1>
              <p className="mt-0.5 text-xs text-white/50">Hosted by {info.hostName}</p>
            </div>
          </div>

          <form onSubmit={join} className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-white/60">Your name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="How should people see you?"
                autoFocus
                maxLength={60}
                className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-blue-500 focus:outline-none"
              />
            </label>

            {error && (
              <p className="rounded-lg border border-red-500/25 bg-red-500/10 p-2.5 text-xs text-red-200">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={name.trim().length < 2 || joining}
              className="flex w-full items-center justify-center gap-2 rounded-full bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-blue-500 disabled:opacity-40"
            >
              {joining && <Loader2 size={15} className="animate-spin" />}
              Ask to join
            </button>

            <p className="text-center text-[11px] leading-relaxed text-white/40">
              {info.hostName} will be asked to let you in. You are joining as a guest —
              no account is created, and this link only works for this meeting.
            </p>
          </form>
        </div>

        <p className="mt-4 text-center text-xs text-white/30">
          Have an NGA account?{' '}
          <a href="/" className="text-blue-400 hover:text-blue-300">Sign in instead</a>
        </p>
      </div>
    </div>
  );
};
