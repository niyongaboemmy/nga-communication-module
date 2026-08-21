import React, { useState } from 'react';
import { Megaphone, Shuffle, Timer, Users, X } from 'lucide-react';
import type { MeetBreakoutRoom, MeetParticipant } from '@tupo/shared';
import { PanelShell, PanelButton, PanelEmpty, PanelInput } from './Shell';

/**
 * Breakout rooms (FR-MEET-16).
 *
 * The plan is composed here and applied in one call, rather than moving people
 * one at a time: a class of thirty split into six groups is one decision, and
 * making it thirty decisions guarantees somebody is left behind in the main
 * room while everyone else is already talking.
 */

export interface BreakoutsPanelProps {
  breakouts: MeetBreakoutRoom[];
  participants: MeetParticipant[];
  isHost: boolean;
  onClose: () => void;
  onOpen: (p: {
    rooms: Array<{ name: string; participantIds: string[] }>;
    durationMinutes?: number; autoAssign?: boolean;
  }) => void;
  onCloseAll: () => void;
  onBroadcast: (body: string) => void;
}

export const BreakoutsPanel: React.FC<BreakoutsPanelProps> = ({
  breakouts, participants, isHost, onClose, onOpen, onCloseAll, onBroadcast,
}) => {
  const [roomCount, setRoomCount] = useState(2);
  const [duration, setDuration] = useState(10);
  const [broadcast, setBroadcast] = useState('');

  const active = breakouts.filter((b) => b.status === 'open');
  const assignable = participants.filter((p) => p.role !== 'host' && p.role !== 'cohost');

  if (!isHost) {
    const mine = active.find((b) => b.participantIds.includes(''));
    return (
      <PanelShell title="Breakout rooms" onClose={onClose}>
        {active.length === 0
          ? <PanelEmpty title="No breakout rooms are open." hint="The host has not opened any." />
          : (
            <div className="p-4">
              <p className="text-sm text-white/80">
                {mine ? `You are in ${mine.name}.` : 'Breakout rooms are open.'}
              </p>
              <p className="mt-1 text-xs text-white/50">
                You will return to the main room automatically when they close.
              </p>
            </div>
          )}
      </PanelShell>
    );
  }

  return (
    <PanelShell
      title="Breakout rooms"
      subtitle={active.length ? `${active.length} open` : `${assignable.length} people to split`}
      onClose={onClose}
      footer={active.length > 0 ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <PanelInput
              value={broadcast}
              onChange={(e) => setBroadcast(e.target.value)}
              placeholder="Message every room…"
            />
            <PanelButton
              disabled={!broadcast.trim()}
              onClick={() => { onBroadcast(broadcast.trim()); setBroadcast(''); }}
            >
              <Megaphone size={13} />
            </PanelButton>
          </div>
          <PanelButton variant="danger" className="w-full" onClick={onCloseAll}>
            <X size={13} /> Close all and bring everyone back
          </PanelButton>
        </div>
      ) : (
        <PanelButton
          className="w-full"
          disabled={assignable.length < 2}
          onClick={() => onOpen({
            rooms: Array.from({ length: roomCount }, (_, i) => ({
              name: `Room ${i + 1}`, participantIds: [],
            })),
            durationMinutes: duration,
            autoAssign: true,
          })}
        >
          <Shuffle size={13} /> Split into {roomCount} rooms
        </PanelButton>
      )}
    >
      {active.length > 0 ? (
        <ul className="space-y-2 p-4">
          {active.map((room) => (
            <li key={room.id} className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="flex items-center gap-2">
                <Users size={14} className="shrink-0 text-blue-400" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">{room.name}</span>
                <span className="shrink-0 text-[11px] text-white/40">
                  {room.participantIds.length}
                </span>
              </div>
              {room.participantIds.length > 0 && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-white/50">
                  {room.participantIds
                    .map((id) => participants.find((p) => p.id === id)?.name ?? 'Someone')
                    .join(', ')}
                </p>
              )}
              {room.closesAt && (
                <p className="mt-1.5 flex items-center gap-1 text-[11px] text-amber-300/80">
                  <Timer size={11} /> closes at{' '}
                  {new Date(room.closesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : assignable.length < 2 ? (
        <PanelEmpty
          title="Not enough people to split."
          hint="You need at least two attendees besides the hosts."
        />
      ) : (
        <div className="space-y-4 p-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-white/70">Number of rooms</span>
            <input
              type="range"
              min={2}
              max={Math.min(10, Math.max(2, assignable.length))}
              value={roomCount}
              onChange={(e) => setRoomCount(Number(e.target.value))}
              className="w-full accent-blue-600"
            />
            <span className="mt-1 block text-xs text-white/50">
              {roomCount} rooms · about {Math.ceil(assignable.length / roomCount)} people each
            </span>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-white/70">Time limit</span>
            <select
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
            >
              {[5, 10, 15, 20, 30, 45].map((m) => (
                <option key={m} value={m}>{m} minutes</option>
              ))}
            </select>
          </label>

          <p className="text-[11px] leading-relaxed text-white/40">
            Hosts and co-hosts stay in the main room and can message every group at once.
            Everyone returns automatically when the time is up.
          </p>
        </div>
      )}
    </PanelShell>
  );
};
