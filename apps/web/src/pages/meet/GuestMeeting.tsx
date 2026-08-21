import React, { useCallback, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { MeetJoinTicket } from '@tupo/shared';
import { useMeetCall } from '../../context/MeetCallContext';
import { MEET_GUEST_KEY } from '../../lib/api';
import { GuestJoin } from './GuestJoin';
import { PreJoin } from './PreJoin';
import { GuestRoom } from './GuestRoom';
import type { PublicMeetingInfo } from './api';

/**
 * The whole guest experience, on a route outside `/app`.
 *
 * It deliberately does not use the app shell: a guest has no rail, no other
 * modules and nothing to navigate to, so the shell would be a frame around a
 * single door. That is also why guests never see the floating mini-call —
 * there is nowhere for them to float it over.
 *
 * Three steps: name → device check → room.
 */

type Step =
  | { at: 'name' }
  | { at: 'prejoin'; ticket: MeetJoinTicket; info: PublicMeetingInfo }
  | { at: 'room'; info: PublicMeetingInfo };

export const GuestMeeting: React.FC = () => {
  const { call, room, startCall, endCall } = useMeetCall();
  const [step, setStep] = useState<Step>({ at: 'name' });
  const [error, setError] = useState<string | null>(null);

  const onNamed = useCallback((p: { ticket: MeetJoinTicket; info: PublicMeetingInfo }) => {
    setStep({ at: 'prejoin', ticket: p.ticket, info: p.info });
  }, []);

  const onJoin = useCallback((opts: {
    stream: MediaStream | null; micEnabled: boolean; cameraEnabled: boolean; speakerId: string;
  }) => {
    if (step.at !== 'prejoin') return;
    for (const t of opts.stream?.getAudioTracks() ?? []) t.enabled = opts.micEnabled;
    for (const t of opts.stream?.getVideoTracks() ?? []) t.enabled = opts.cameraEnabled;

    startCall({
      ticket: step.ticket,
      stream: opts.stream,
      speakerId: opts.speakerId,
      title: step.info.title,
      joinCode: step.info.joinCode,
      isGuest: true,
    });
    setStep({ at: 'room', info: step.info });
  }, [step, startCall]);

  const leave = useCallback(async () => {
    await endCall();
    localStorage.removeItem(MEET_GUEST_KEY);
    setStep({ at: 'name' });
  }, [endCall]);

  if (step.at === 'name') {
    return <GuestJoin onReady={onNamed} />;
  }

  if (step.at === 'prejoin') {
    return (
      <div className="min-h-dvh bg-slate-950">
        <PreJoin
          title={step.info.title}
          hostName={step.info.hostName}
          // A guest always waits, whatever the lobby setting says.
          willKnock
          joinLabel="Ask to join"
          error={error}
          yourName={step.ticket.meeting.title}
          onJoin={onJoin}
          onCancel={() => { setError(null); setStep({ at: 'name' }); }}
        />
      </div>
    );
  }

  if (!call || !room) {
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-950">
        <Loader2 size={22} className="animate-spin text-white/30" />
      </div>
    );
  }

  if (room.phase === 'removed' || room.phase === 'ended') {
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-950 p-6 text-center">
        <div className="max-w-sm">
          <AlertTriangle size={26} className="mx-auto text-amber-400" />
          <h1 className="mt-4 text-base font-semibold text-white">
            {room.phase === 'ended' ? 'The meeting has ended' : 'You are no longer in this meeting'}
          </h1>
          <p className="mt-1.5 text-sm leading-relaxed text-white/50">
            {room.error ?? 'Thanks for joining.'}
          </p>
          <button
            onClick={() => void leave()}
            className="mt-5 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return <GuestRoom info={step.info} onLeave={() => void leave()} />;
};
