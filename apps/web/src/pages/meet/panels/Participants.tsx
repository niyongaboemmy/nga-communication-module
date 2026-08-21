import React, { useMemo, useState } from 'react';
import {
  Check,
  Hand,
  MicOff,
  MonitorUp,
  MoreVertical,
  ShieldCheck,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react';
import type { HostCommand, MeetParticipant } from '@tupo/shared';
import { Avatar } from '../../../components/ui';
import { PanelShell, PanelButton, PanelEmpty } from './Shell';

/**
 * The participant list, and the lobby above it.
 *
 * The lobby is at the top and visually separated because it is the one thing in
 * this panel that is *waiting on the host*. Buried below a roster of thirty, a
 * knock goes unanswered — which in a lesson means a pupil sitting outside for
 * twenty minutes.
 */

export interface ParticipantsPanelProps {
  participants: MeetParticipant[];
  lobby: MeetParticipant[];
  you: MeetParticipant | null;
  speakingIds: string[];
  isHost: boolean;
  spotlightId: string | null;
  onClose: () => void;
  onCommand: (command: HostCommand) => void;
}

export const ParticipantsPanel: React.FC<ParticipantsPanelProps> = ({
  participants,
  lobby,
  you,
  speakingIds,
  isHost,
  spotlightId,
  onClose,
  onCommand,
}) => {
  const [menuFor, setMenuFor] = useState<string | null>(null);

  /**
   * Hands first, in the order they went up — the queue is the point. Then
   * whoever is speaking, then everyone else alphabetically so the list is
   * stable enough to scan.
   */
  const ordered = useMemo(() => {
    const raised = participants
      .filter((p) => p.handRaised)
      .sort((a, b) => (a.handRaisedAt ?? '').localeCompare(b.handRaisedAt ?? ''));
    const rest = participants
      .filter((p) => !p.handRaised)
      .sort((a, b) => {
        const speakingDelta = Number(speakingIds.includes(b.id)) - Number(speakingIds.includes(a.id));
        return speakingDelta !== 0 ? speakingDelta : a.name.localeCompare(b.name);
      });
    return [...raised, ...rest];
  }, [participants, speakingIds]);

  const handIndex = (p: MeetParticipant) =>
    p.handRaised ? ordered.filter((x) => x.handRaised).findIndex((x) => x.id === p.id) + 1 : 0;

  return (
    <PanelShell
      title="Participants"
      subtitle={`${participants.length} in the meeting${lobby.length ? ` · ${lobby.length} waiting` : ''}`}
      onClose={onClose}
      footer={
        isHost ? (
          <div className="flex gap-2">
            <PanelButton variant="ghost" className="flex-1" onClick={() => onCommand({ action: 'mute_all' })}>
              <MicOff size={13} /> Mute everyone
            </PanelButton>
            {lobby.length > 0 && (
              <PanelButton className="flex-1" onClick={() => onCommand({ action: 'admit_all' })}>
                <Check size={13} /> Admit all
              </PanelButton>
            )}
          </div>
        ) : undefined
      }
    >
      {lobby.length > 0 && isHost && (
        <section className="border-b border-white/10 bg-amber-500/5 py-2">
          <h3 className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-300">
            Waiting to be let in
          </h3>
          {lobby.map((p) => (
            <div key={p.id} className="flex items-center gap-2.5 px-4 py-2">
              <Avatar name={p.name} src={p.avatarUrl ?? undefined} size={30} />
              <span className="min-w-0 flex-1 truncate text-sm text-white/90">
                {p.name}
                {p.isGuest && <span className="ml-1.5 text-[10px] uppercase text-amber-300/70">Guest</span>}
              </span>
              <button
                onClick={() => onCommand({ action: 'admit', targetId: p.id })}
                aria-label={`Admit ${p.name}`}
                className="grid h-7 w-7 place-items-center rounded-full bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600 hover:text-white"
              >
                <Check size={14} />
              </button>
              <button
                onClick={() => onCommand({ action: 'deny', targetId: p.id })}
                aria-label={`Deny ${p.name}`}
                className="grid h-7 w-7 place-items-center rounded-full bg-red-600/20 text-red-300 hover:bg-red-600 hover:text-white"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </section>
      )}

      {ordered.length === 0 ? (
        <PanelEmpty title="Nobody else is here yet." />
      ) : (
        <ul className="py-1">
          {ordered.map((p) => {
            const position = handIndex(p);
            const isYou = p.id === you?.id;
            return (
              <li key={p.id} className="relative flex items-center gap-2.5 px-4 py-2 hover:bg-white/5">
                <span className="relative shrink-0">
                  <Avatar name={p.name} src={p.avatarUrl ?? undefined} size={30} />
                  {speakingIds.includes(p.id) && (
                    <span className="absolute -inset-0.5 rounded-full ring-2 ring-emerald-400" />
                  )}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm text-white/90">
                      {p.name}
                      {isYou ? ' (you)' : ''}
                    </span>
                    {(p.role === 'host' || p.role === 'cohost') && (
                      <ShieldCheck size={12} className="shrink-0 text-blue-400" />
                    )}
                  </span>
                  {position > 0 && (
                    <span className="block text-[11px] text-amber-300">
                      Hand raised · #{position} in the queue
                    </span>
                  )}
                </span>

                <span className="flex shrink-0 items-center gap-1.5 text-white/40">
                  {p.screenSharing && <MonitorUp size={13} className="text-blue-400" />}
                  {p.handRaised && <Hand size={13} className="text-amber-400" />}
                  {!p.audioEnabled && <MicOff size={13} />}
                </span>

                {isHost && !isYou && (
                  <button
                    onClick={() => setMenuFor(menuFor === p.id ? null : p.id)}
                    aria-label={`Manage ${p.name}`}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/50 hover:bg-white/10 hover:text-white"
                  >
                    <MoreVertical size={14} />
                  </button>
                )}

                {menuFor === p.id && (
                  <div className="absolute right-3 top-10 z-20 w-52 rounded-xl border border-white/10 bg-slate-800 p-1">
                    <MenuItem
                      Icon={MicOff}
                      label={p.audioEnabled ? 'Mute' : 'Ask to unmute'}
                      onClick={() => {
                        // A host can silence a microphone but cannot switch one
                        // on — that stays the participant's decision.
                        onCommand({
                          action: p.audioEnabled ? 'mute' : 'unmute_request',
                          targetId: p.id,
                        });
                        setMenuFor(null);
                      }}
                    />
                    <MenuItem
                      Icon={MonitorUp}
                      label={spotlightId === p.id ? 'Remove spotlight' : 'Spotlight for everyone'}
                      onClick={() => {
                        onCommand({
                          action: spotlightId === p.id ? 'unspotlight' : 'spotlight',
                          targetId: p.id,
                        });
                        setMenuFor(null);
                      }}
                    />
                    <MenuItem
                      Icon={p.role === 'cohost' ? UserMinus : UserPlus}
                      label={p.role === 'cohost' ? 'Remove co-host' : 'Make co-host'}
                      onClick={() => {
                        onCommand({
                          action: p.role === 'cohost' ? 'demote' : 'promote',
                          targetId: p.id,
                        });
                        setMenuFor(null);
                      }}
                    />
                    <div className="my-1 h-px bg-white/10" />
                    <MenuItem
                      Icon={UserMinus}
                      label="Remove from meeting"
                      danger
                      onClick={() => {
                        onCommand({ action: 'remove', targetId: p.id });
                        setMenuFor(null);
                      }}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </PanelShell>
  );
};

const MenuItem: React.FC<{
  Icon: typeof MicOff;
  label: string;
  danger?: boolean;
  onClick: () => void;
}> = ({ Icon, label, danger, onClick }) => (
  <button
    onClick={onClick}
    className={
      'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors duration-150 ' +
      (danger ? 'text-red-300 hover:bg-red-600/20' : 'text-white/80 hover:bg-white/10')
    }
  >
    <Icon size={13} /> {label}
  </button>
);
