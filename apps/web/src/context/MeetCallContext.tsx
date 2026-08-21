import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { MeetJoinTicket } from '@tupo/shared';
import { useMeetRoom } from '../pages/meet/useMeetRoom';
import type { MeetRoomActions, MeetRoomDerived, MeetRoomState } from '../pages/meet/useMeetRoom';
import * as meetApi from '../pages/meet/api';
import { MeetAudioSink } from '../components/meet/MeetAudioSink';

/**
 * The active call, lifted above the router.
 *
 * This exists for one reason: a meeting must survive navigation. React Router
 * unmounts a route component when you leave it, and unmounting the meeting
 * would close the peer connections and drop the call — so someone who clicks
 * into Chat to look something up would come back to an empty room.
 *
 * Holding the call here instead means the socket, the transport and the media
 * all outlive the route. `/app/meet/:id` renders the full room from this
 * context; every other page renders the floating mini-call from the same state.
 * There is only ever one call, and only one `useMeetRoom` driving it.
 *
 * Guests are deliberately excluded from the mini-call: they have no app shell
 * to navigate around, so there is nothing for it to float over.
 */

export interface ActiveCall {
  ticket: MeetJoinTicket;
  meetingId: string;
  title: string;
  joinCode: string;
  speakerId: string;
  isGuest: boolean;
}

interface MeetCallValue {
  call: ActiveCall | null;
  room: (MeetRoomState & MeetRoomDerived & MeetRoomActions) | null;
  /** True while the user is on the meeting's own route. */
  isOnCallRoute: boolean;
  /** Show the floating window: in a call, but looking at something else. */
  shouldShowMini: boolean;
  startCall: (p: {
    ticket: MeetJoinTicket;
    stream: MediaStream | null;
    speakerId: string;
    title: string;
    joinCode: string;
    isGuest?: boolean;
  }) => void;
  /** Leave and tear down. Safe to call when there is no call. */
  endCall: () => Promise<void>;
}

const MeetCallContext = createContext<MeetCallValue | null>(null);

export const MeetCallProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  // Guards endCall against being run twice by a double click on Leave.
  const endingRef = useRef(false);

  // Always called — hooks cannot be conditional — but inert with a null ticket.
  const room = useMeetRoom(call?.ticket ?? null, stream);

  const startCall = useCallback((p: {
    ticket: MeetJoinTicket; stream: MediaStream | null; speakerId: string;
    title: string; joinCode: string; isGuest?: boolean;
  }) => {
    endingRef.current = false;
    setStream(p.stream);
    setCall({
      ticket: p.ticket,
      meetingId: p.ticket.meeting.meetingId,
      title: p.title,
      joinCode: p.joinCode,
      speakerId: p.speakerId,
      isGuest: !!p.isGuest,
    });
  }, []);

  const endCall = useCallback(async () => {
    if (!call || endingRef.current) return;
    endingRef.current = true;
    try {
      await room.leave();
    } finally {
      // Cleared regardless: a failed leave must not strand the UI in a call
      // the user has already walked away from.
      setCall(null);
      setStream(null);
    }
  }, [call, room]);

  const isOnCallRoute = !!call &&
    location.pathname.startsWith(`/app/meet/${call.meetingId}`) &&
    !location.pathname.endsWith('/summary');

  const value = useMemo<MeetCallValue>(() => ({
    call,
    room: call ? room : null,
    isOnCallRoute,
    // A guest has no other pages to be on, so they never see the mini-call.
    shouldShowMini: !!call && !isOnCallRoute && !call.isGuest &&
      room.phase !== 'ended' && room.phase !== 'removed',
    startCall,
    endCall,
  }), [call, room, isOnCallRoute, startCall, endCall]);

  return (
    <MeetCallContext.Provider value={value}>
      {children}
      {/* Audio is attached here, not in the tiles: tiles unmount when you
          navigate away, and a call you cannot hear is worse than one you
          cannot see. */}
      <MeetAudioSink />
    </MeetCallContext.Provider>
  );
};

export function useMeetCall(): MeetCallValue {
  const ctx = useContext(MeetCallContext);
  if (!ctx) throw new Error('useMeetCall must be used inside a MeetCallProvider');
  return ctx;
}

/** Fire-and-forget cleanup when a meeting ends underneath us. */
export async function releaseMeeting(meetingId: string): Promise<void> {
  await meetApi.leaveMeeting(meetingId).catch(() => {});
}
