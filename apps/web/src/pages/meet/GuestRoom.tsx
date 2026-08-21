import React, { useState } from 'react';
import { Loader2, MessageSquare, Users } from 'lucide-react';
import { useMeetCall } from '../../context/MeetCallContext';
import { Stage } from './Stage';
import { ControlBar, type PanelKey } from './ControlBar';
import { ChatPanel } from './panels/Chat';
import { ParticipantsPanel } from './panels/Participants';
import { QandAPanel } from './panels/QandA';
import { PollsPanel } from './panels/Polls';
import { PresenterBadge } from './PresentationBar';
import type { PublicMeetingInfo } from './api';

/**
 * The room a guest sees.
 *
 * The same stage, tiles and control bar as everyone else — a guest is a real
 * participant, not a spectator. What is missing is everything that would imply
 * an account or authority: no host console, no notes, no AI panel, no
 * recording, no breakout management, no layout persistence across pages.
 *
 * Those omissions are cosmetic convenience only. Each one is independently
 * refused by the server for a guest ticket (`denyGuests` in the Meet router,
 * and the one-permission shim in `middleware/meetAuth.ts`), so hiding them here
 * is about not offering what will not work — never about keeping anyone out.
 */

export const GuestRoom: React.FC<{
  info: PublicMeetingInfo;
  onLeave: () => void;
}> = ({ info, onLeave }) => {
  const { call, room } = useMeetCall();
  const [panel, setPanel] = useState<PanelKey | null>(null);

  if (!call || !room) {
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-950">
        <Loader2 size={22} className="animate-spin text-white/30" />
      </div>
    );
  }

  if (room.phase === 'lobby' || room.phase === 'connecting') {
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-950 p-6 text-center">
        <div className="max-w-sm">
          <Loader2 size={26} className="mx-auto animate-spin text-blue-400" />
          <h1 className="mt-4 text-base font-semibold text-white">
            {room.phase === 'lobby' ? 'Waiting to be let in' : 'Connecting…'}
          </h1>
          <p className="mt-1.5 text-sm leading-relaxed text-white/50">
            {room.phase === 'lobby'
              ? `${info.hostName} has been asked to admit you. You will join automatically.`
              : `Joining ${info.title}.`}
          </p>
          <button
            onClick={onLeave}
            className="mt-5 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"
          >
            Leave
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-slate-950">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2.5">
        <h1 className="min-w-0 truncate text-sm font-semibold text-white">{info.title}</h1>
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/50">
          Guest
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-white/40">
          <Users size={12} /> {room.participants.length}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1 p-2">
          <Stage
            layout={room.layout}
            participants={room.participants}
            you={room.you}
            media={room.media}
            localStream={room.localStream}
            videoTileIds={room.videoTileIds}
            speakingIds={room.speakingIds}
            activeSpeakerId={room.activeSpeakerId}
            spotlightId={room.spotlightId}
            pinnedId={room.pinnedId}
            reactions={room.reactions}
            presenterId={room.presenterId}
            onPin={room.setPinned}
            onVisible={room.reportVisible}
          />
          {room.presenterId && room.presenterName && !room.screenSharing && (
            <PresenterBadge name={room.presenterName} />
          )}
        </main>

        {panel && (
          <div className="absolute inset-0 z-40 md:relative md:inset-auto md:z-auto">
            {panel === 'chat' && (
              <ChatPanel
                messages={room.chat}
                participants={room.participants}
                you={room.you}
                allowed={room.settings.allowChat}
                onClose={() => setPanel(null)}
                onSend={room.sendChat}
              />
            )}
            {panel === 'participants' && (
              <ParticipantsPanel
                participants={room.participants}
                lobby={[]}
                you={room.you}
                speakingIds={room.speakingIds}
                isHost={false}
                spotlightId={room.spotlightId}
                onClose={() => setPanel(null)}
                onCommand={() => {
                  /* a guest issues no host commands */
                }}
              />
            )}
            {panel === 'qa' && (
              <QandAPanel
                questions={room.questions}
                youParticipantId={room.you?.id ?? null}
                isHost={false}
                onClose={() => setPanel(null)}
                onAsk={room.askQuestion}
                onUpvote={room.upvoteQuestion}
                onAnswer={() => {
                  /* hosts answer */
                }}
              />
            )}
            {panel === 'polls' && (
              <PollsPanel
                polls={room.polls}
                isHost={false}
                onClose={() => setPanel(null)}
                onCreate={() => {
                  /* hosts create polls */
                }}
                onVote={room.votePoll}
                onClosePoll={() => {
                  /* hosts close polls */
                }}
              />
            )}
          </div>
        )}
      </div>

      <ControlBar
        micEnabled={room.micEnabled}
        cameraEnabled={room.cameraEnabled}
        screenSharing={room.screenSharing}
        handRaised={room.handRaised}
        recording={room.recording}
        captionsOn={false}
        captionsSupported={false}
        dataSaver={room.dataSaver}
        layout={room.layout}
        isHost={false}
        canShare={room.settings.allowScreenShare}
        canRecord={false}
        canUseAi={false}
        aiPresent={room.aiPresent}
        participantCount={room.participants.length}
        lobbyCount={0}
        unreadChat={0}
        noteCount={0}
        openPanel={panel}
        onToggleMic={room.toggleMic}
        onToggleCamera={room.toggleCamera}
        onToggleShare={() => void room.toggleScreenShare()}
        onStartShare={(opts) => void room.startScreenShare(opts)}
        onToggleHand={room.toggleHand}
        onReact={room.react}
        onToggleCaptions={() => {
          /* captions are the host's to enable */
        }}
        onToggleDataSaver={() => room.setDataSaver(!room.dataSaver)}
        onToggleRecording={() => {
          /* guests never record */
        }}
        onSetLayout={room.setLayout}
        onOpenPanel={setPanel}
        onLeave={onLeave}
      />

      {room.recording && (
        <div className="pointer-events-none absolute left-1/2 top-14 z-30 -translate-x-1/2">
          <span className="flex items-center gap-1.5 rounded-full bg-red-600/25 px-3 py-1.5 text-xs font-medium text-red-100 backdrop-blur-sm">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
            This meeting is being recorded
          </span>
        </div>
      )}

      {room.settings.allowChat && panel !== 'chat' && room.chat.length > 0 && (
        <button
          onClick={() => setPanel('chat')}
          className="absolute bottom-20 right-4 z-30 flex items-center gap-1.5 rounded-full bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500"
        >
          <MessageSquare size={14} /> Chat
        </button>
      )}
    </div>
  );
};
