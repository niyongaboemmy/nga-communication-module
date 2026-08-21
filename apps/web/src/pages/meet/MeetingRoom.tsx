import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  Circle,
  Loader2,
  Pencil,
  Share2,
  Signal,
  SignalLow,
  SignalZero,
  Sparkles,
  Upload,
  Wifi,
  X,
} from 'lucide-react';
import type { MeetJoinTicket, MeetTransport } from '@tupo/shared';
import { isSfuTransport } from '@tupo/shared';
import { useAuth } from '../../context/AuthContext';
import { usePermissions } from '../../hooks/usePermissions';
import { PreJoin } from './PreJoin';
import { Stage } from './Stage';
import { ControlBar, type PanelKey } from './ControlBar';
import { ShareMeeting } from './ShareMeeting';
import { PresentingBar, PresenterBadge } from './PresentationBar';
import { CaptionsOverlay } from './Captions';
import { ParticipantsPanel } from './panels/Participants';
import { ChatPanel } from './panels/Chat';
import { AiPanel } from './panels/AiPanel';
import { PollsPanel } from './panels/Polls';
import { QandAPanel } from './panels/QandA';
import { BreakoutsPanel } from './panels/Breakouts';
import { HostConsole } from './panels/HostConsole';
import { NotesPanel } from './panels/Notes';
import { useMeetCall } from '../../context/MeetCallContext';
import { useNotify } from '../../context/NotificationContext';
import { useMeetNotifications } from './useMeetNotifications';
import { useMeetActionFeedback } from './useMeetActionFeedback';
import { useMeetRecorder } from './useMeetRecorder';
import { primeSounds } from '../../lib/sounds';
import { useSpeechCaptions, speechRecognitionSupported } from './useSpeechCaptions';
import * as meetApi from './api';

/**
 * The meeting room.
 *
 * Two screens in one route: the pre-join device check, and the room itself.
 * They share a route rather than being two pages so the camera stream opened in
 * the preview is the same stream that gets published — reopening it between the
 * two is a visible stall and, on some laptops, a second permission prompt.
 */

export const MeetingRoom: React.FC = () => {
  const { idOrCode = '' } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { can } = usePermissions();

  const [meeting, setMeeting] = useState<meetApi.MeetingDetail | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<meetApi.MeetCapabilities | null>(null);
  const [panel, setPanel] = useState<PanelKey | null>(null);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [readChatCount, setReadChatCount] = useState(0);

  /**
   * The call is owned by MeetCallProvider, above the router, so it survives
   * navigating away to another page. This screen is one of two views onto it —
   * the other is the floating mini-call.
   */
  const { call, room: rawRoom, startCall, endCall } = useMeetCall();
  // Wrapped so every deliberate action confirms itself. The wrapper is
  // transparent — same shape, same behaviour, plus an acknowledgement.
  const activeRoom = useMeetActionFeedback(rawRoom);
  // Matched against the URL as well as the loaded meeting: coming back from
  // another page, `meeting` is briefly null while it re-fetches, and keying
  // only off that would drop the user onto the pre-join screen — which would
  // then try to open the camera the call is already holding.
  const isThisMeeting =
    !!call &&
    (call.meetingId === idOrCode ||
      call.joinCode === idOrCode ||
      (!!meeting && call.meetingId === meeting.id));
  const room = isThisMeeting ? activeRoom : null;
  const ticket = isThisMeeting ? call!.ticket : null;

  const { notify } = useNotify();
  const isHost = room?.you?.role === 'host' || room?.you?.role === 'cohost';

  /* Before joining there is no room and no `you`, so the in-room check above is
     always false on the device-check screen. The meeting detail knows the role
     without anyone having joined, which is what the pre-join controls need. */
  const isHostByRecord = meeting?.yourRole === 'host' || meeting?.yourRole === 'cohost';
  const canRecord = can('MEET_RECORD');
  const canUseAi = can('MEET_AI_USE');
  const canTranscribe = can('MEET_TRANSCRIBE');

  /* ---------------- load ---------------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [detail, caps] = await Promise.all([meetApi.getMeeting(idOrCode), meetApi.getCapabilities()]);
        if (cancelled) return;
        setMeeting(detail);
        setCapabilities(caps);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Could not open this meeting.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [idOrCode]);

  /* ---------------- captions ---------------- */

  // The meeting-wide switch is the host's; this is the viewer's own. Both must
  // be on: a participant should be able to turn captions off for themselves
  // without turning off the transcript everyone else's notes depend on.
  const captionsActive = captionsOn && !!room?.transcribing;

  const speech = useSpeechCaptions({
    enabled: captionsActive,
    lang: room?.settings.primaryLanguage ?? 'en-US',
    micEnabled: !!room?.micEnabled,
    onSegment: room?.sendCaption ?? (() => {}),
  });

  useEffect(() => {
    if (room?.transcribing && room.settings.captionsDefaultOn) setCaptionsOn(true);
  }, [room?.transcribing, room?.settings.captionsDefaultOn]);

  /* ---------------- join ---------------- */

  const handleJoin = useCallback(
    async (opts: {
      stream: MediaStream | null;
      micEnabled: boolean;
      cameraEnabled: boolean;
      speakerId: string;
    }) => {
      setJoining(true);
      setJoinError(null);
      try {
        // Apply the pre-join choices to the tracks before they are published, so
        // "join muted" is true from the first frame rather than a beat later.
        for (const t of opts.stream?.getAudioTracks() ?? []) t.enabled = opts.micEnabled;
        for (const t of opts.stream?.getVideoTracks() ?? []) t.enabled = opts.cameraEnabled;

        const issued = await meetApi.joinMeeting(idOrCode, {
          capabilities: {
            video: opts.cameraEnabled,
            audio: opts.micEnabled,
            screenShare: typeof navigator.mediaDevices?.getDisplayMedia === 'function',
            speechRecognition: speechRecognitionSupported(),
          },
        });
        // Handed to the provider, not held here — that is what lets the call
        // outlive this route.
        // Joining is the last guaranteed gesture before the sound cues start
        // mattering, and an AudioContext created without one stays suspended.
        primeSounds();
        startCall({
          ticket: issued,
          stream: opts.stream,
          speakerId: opts.speakerId,
          title: meeting?.title ?? 'Meeting',
          joinCode: meeting?.join_code ?? '',
        });
      } catch (err) {
        for (const t of opts.stream?.getTracks() ?? []) t.stop();
        setJoinError(err instanceof Error ? err.message : 'Could not join the meeting.');
      } finally {
        setJoining(false);
      }
    },
    [idOrCode, meeting, startCall],
  );

  const leave = useCallback(async () => {
    await endCall();
    navigate('/app/meet');
  }, [endCall, navigate]);

  const endForAll = useCallback(async () => {
    if (!meeting || !room) return;
    await room.hostCommand({ action: 'end' });
    await meetApi.endMeeting(meeting.id).catch(() => {});
    await endCall();
    navigate(`/app/meet/${meeting.id}/summary`);
  }, [meeting, room, endCall, navigate]);

  /**
   * Recording.
   *
   * With a media server this is an Egress job; without one the host's browser
   * composites the stage and uploads the result. `useMeetRecorder` owns that
   * path — this only decides which to use and keeps the room's indicator in
   * step, since everyone else learns about it over the socket.
   */
  const recorder = useMeetRecorder({
    meetingId: meeting?.id ?? '',
    participants: room?.participants ?? [],
    media: room?.media ?? new Map(),
    localStream: room?.localStream ?? null,
    you: room?.you ?? null,
    presenterId: room?.presenterId ?? null,
    onStateChange: (active) => room?.setRecording(active),
  });

  const toggleRecording = useCallback(async () => {
    if (!meeting || !room) return;
    try {
      // Recording is always made here, in this browser. The SFU routes tracks
      // and does not composite them, so there is no server-side path — asking
      // for one used to be exactly what broke recording whenever the media
      // server was configured.
      if (recorder.state === 'recording') await recorder.stop();
      else await recorder.start();
    } catch (err) {
      notify({
        title: 'Could not change recording',
        body: err instanceof Error ? err.message : undefined,
        tone: 'error',
      });
    }
  }, [meeting, room, recorder, notify]);

  // Once the meeting ends, everyone lands on the summary rather than an empty
  // stage — which is also where the minutes will appear.
  useEffect(() => {
    if (room?.phase === 'ended' && meeting) {
      const t = setTimeout(() => {
        void endCall();
        navigate(`/app/meet/${meeting.id}/summary`);
      }, 1200);
      return () => clearTimeout(t);
    }
  }, [room?.phase, meeting, endCall, navigate]);

  useEffect(() => {
    if (panel === 'chat' && room) setReadChatCount(room.chat.length);
  }, [panel, room?.chat.length, room]);

  const unreadChat = panel === 'chat' ? 0 : Math.max(0, (room?.chat.length ?? 0) - readChatCount);

  /* Push the toast stack clear of an open side panel. Below `md` the panel
   * covers the whole screen, so there is nowhere to push it to and it stays
   * where it is — on top, which is correct when the panel is the whole view. */
  useEffect(() => {
    const root = document.documentElement;
    const wide = window.matchMedia('(min-width: 768px)').matches;
    if (panel && wide) {
      root.style.setProperty(
        '--tupo-toast-right',
        window.matchMedia('(min-width: 1024px)').matches ? '25rem' : '21rem',
      );
    } else {
      root.style.removeProperty('--tupo-toast-right');
    }
    // Braced: `removeProperty` returns a string, and an effect cleanup that
    // returns a value is a type error rather than a silent oddity.
    return () => {
      root.style.removeProperty('--tupo-toast-right');
    };
  }, [panel]);

  // Everything that deserves a person's attention, derived from state changes
  // rather than bolted onto the socket layer. See useMeetNotifications.
  useMeetNotifications({
    room,
    isOnCallRoute: true,
    openPanel: panel,
    isHost,
    onOpenPanel: setPanel,
    onGoToMeeting: meeting ? () => navigate(`/app/meet/${meeting.id}/summary`) : undefined,
  });

  const openPolls = useMemo(
    () => (room?.polls ?? []).filter((p) => p.status === 'open').length,
    [room?.polls],
  );

  /* ---------------- screens ---------------- */

  if (loadError) {
    return (
      <FullScreenMessage
        tone="error"
        title="This meeting is not available"
        body={loadError}
        action={{ label: 'Back to Meet', onClick: () => navigate('/app/meet') }}
      />
    );
  }

  if (!meeting || !capabilities) {
    return (
      <div className="grid min-h-full place-items-center bg-slate-950">
        <Loader2 size={24} className="animate-spin text-white/30" />
      </div>
    );
  }

  if (!ticket || !room) {
    return (
      <PreJoin
        title={meeting.title}
        hostName={meeting.host_name}
        participantCount={meeting.active_count}
        willKnock={meeting.settings.lobbyEnabled && meeting.yourRole === 'attendee'}
        busy={joining}
        error={joinError}
        yourName={user?.name ?? 'You'}
        yourAvatar={user?.avatarUrl}
        onJoin={handleJoin}
        onCancel={() => navigate('/app/meet')}
        meetingId={meeting.id}
        joinCode={meeting.join_code}
        admission={meeting.settings.admissionPolicy}
        canRename={isHostByRecord}
        canEnd={isHostByRecord}
        endLabel={meeting.status === 'live' ? 'end' : 'cancel'}
        onRename={async (next) => {
          const saved = await meetApi.renameMeeting(meeting.id, next);
          setMeeting((m) => (m ? { ...m, title: saved.title } : m));
        }}
        onEndMeeting={async () => {
          // A meeting that has started is ended; one that has not is cancelled.
          // They are different verbs because they are different events, and
          // the attendance record depends on the distinction.
          if (meeting.status === 'live') await meetApi.endMeeting(meeting.id);
          else await meetApi.cancelMeeting(meeting.id);
          navigate(`/app/meet/${meeting.id}/summary`);
        }}
      />
    );
  }

  if (room.phase === 'removed') {
    return (
      <FullScreenMessage
        tone="error"
        title="You are no longer in this meeting"
        body={room.error ?? 'The host removed you.'}
        action={{ label: 'Back to Meet', onClick: () => navigate('/app/meet') }}
      />
    );
  }

  if (room.phase === 'error') {
    return (
      <FullScreenMessage
        tone="error"
        title="Something went wrong"
        body={room.error ?? 'The meeting could not be joined.'}
        action={{ label: 'Try again', onClick: () => window.location.reload() }}
      />
    );
  }

  if (room.phase === 'lobby') {
    return (
      <FullScreenMessage
        tone="wait"
        title="Waiting to be let in"
        body={`${meeting.host_name} has been asked to admit you. You will join automatically.`}
        action={{ label: 'Leave', onClick: () => void leave() }}
      />
    );
  }

  if (room.phase === 'connecting') {
    return (
      <div className="grid min-h-full place-items-center bg-slate-950">
        <div className="text-center">
          <Loader2 size={24} className="mx-auto animate-spin text-white/30" />
          <p className="mt-3 text-sm text-white/50">Connecting to {meeting.title}…</p>
        </div>
      </div>
    );
  }

  /* ---------------- the room ---------------- */

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950">
      <RoomHeader
        title={meeting.title}
        meetingId={meeting.id}
        admission={meeting.settings.admissionPolicy}
        canRename={isHost}
        onRename={async (next) => {
          const saved = await meetApi.renameMeeting(meeting.id, next);
          setMeeting((m) => (m ? { ...m, title: saved.title } : m));
          notify({ title: 'Meeting renamed', tone: 'success', durationMs: 2500 });
        }}
        recorderState={recorder.state}
        recorderElapsed={recorder.elapsed}
        joinCode={meeting.join_code}
        transport={ticket.transport}
        quality={room.quality}
        recording={room.recording}
        aiPresent={room.aiPresent}
        dataSaver={room.dataSaver}
        startedAt={room.startedAt}
      />

      {room.error && (
        <div className="flex shrink-0 items-center gap-2 bg-amber-500/15 px-4 py-1.5 text-xs text-amber-100">
          <AlertTriangle size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{room.error}</span>
        </div>
      )}

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
          {room.screenSharing ? (
            <PresentingBar screenStream={room.screenStream} onStop={() => void room.stopScreenShare()} />
          ) : room.presenterId && room.presenterName ? (
            <PresenterBadge name={room.presenterName} />
          ) : null}

          {captionsActive && (
            <CaptionsOverlay
              meetingId={meeting.id}
              segments={room.captions}
              aiAvailable={capabilities.ai && room.settings.translationEnabled}
            />
          )}
        </main>

        {panel && (
          <div className="absolute inset-0 z-40 md:relative md:inset-auto md:z-auto">
            {panel === 'participants' && (
              <ParticipantsPanel
                participants={room.participants}
                lobby={room.lobby}
                you={room.you}
                speakingIds={room.speakingIds}
                isHost={isHost}
                spotlightId={room.spotlightId}
                onClose={() => setPanel(null)}
                onCommand={(c) => void room.hostCommand(c)}
              />
            )}
            {panel === 'chat' && (
              <ChatPanel
                messages={room.chat}
                participants={room.participants}
                you={room.you}
                allowed={room.settings.allowChat || isHost}
                onClose={() => setPanel(null)}
                onSend={room.sendChat}
              />
            )}
            {panel === 'ai' && (
              <AiPanel
                meetingId={meeting.id}
                aiEnabled={capabilities.ai}
                aiPresent={room.aiPresent}
                transcribing={room.transcribing}
                captionsSupported={speech.supported}
                captionCount={room.captions.filter((c) => c.isFinal).length}
                participants={room.participants}
                canUseAi={canUseAi}
                isHost={isHost}
                thinking={room.aiThinking}
                onClose={() => setPanel(null)}
                onEnableAi={(on) => room.patchSettings({ aiAssistantEnabled: on })}
                onEnableTranscription={(on) => room.patchSettings({ transcriptionEnabled: on })}
              />
            )}
            {panel === 'polls' && (
              <PollsPanel
                polls={room.polls}
                isHost={isHost}
                onClose={() => setPanel(null)}
                onCreate={room.createPoll}
                onVote={room.votePoll}
                onClosePoll={room.closePoll}
              />
            )}
            {panel === 'qa' && (
              <QandAPanel
                questions={room.questions}
                youParticipantId={room.you?.id ?? null}
                isHost={isHost}
                onClose={() => setPanel(null)}
                onAsk={room.askQuestion}
                onUpvote={room.upvoteQuestion}
                onAnswer={room.answerQuestion}
              />
            )}
            {panel === 'breakouts' && (
              <BreakoutsPanel
                breakouts={room.breakouts}
                participants={room.participants}
                isHost={isHost}
                onClose={() => setPanel(null)}
                onOpen={room.openBreakouts}
                onCloseAll={room.closeBreakouts}
                onBroadcast={room.broadcastToBreakouts}
              />
            )}
            {panel === 'notes' && (
              <NotesPanel
                meetingId={meeting.id}
                notes={room.notes}
                aiAvailable={capabilities.ai}
                transcribing={room.transcribing}
                offsetSeconds={
                  room.startedAt ? Math.round((Date.now() - Date.parse(room.startedAt)) / 1000) : null
                }
                onClose={() => setPanel(null)}
                onNotesChanged={room.setNotes}
                onShare={room.shareNote}
              />
            )}
            {panel === 'host' && (
              <HostConsole
                meetingId={meeting.id}
                settings={room.settings}
                canRecord={canRecord}
                canUseAi={canUseAi && capabilities.ai}
                canTranscribe={canTranscribe}
                onClose={() => setPanel(null)}
                onCommand={(c) => void room.hostCommand(c)}
                onPatchSettings={room.patchSettings}
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
        captionsOn={captionsActive}
        captionsSupported={speech.supported && (room.transcribing || isHost)}
        dataSaver={room.dataSaver}
        layout={room.layout}
        isHost={isHost}
        canShare={room.settings.allowScreenShare || isHost}
        // Client-side recording works without a media server, so this is no
        // longer gated on the SFU — only on the permission and the browser.
        canRecord={canRecord && recorder.supported}
        canUseAi={canUseAi && capabilities.ai}
        aiPresent={room.aiPresent}
        participantCount={room.participants.length}
        lobbyCount={isHost ? room.lobby.length : 0}
        unreadChat={unreadChat}
        openPanel={panel}
        onToggleMic={room.toggleMic}
        onToggleCamera={room.toggleCamera}
        onToggleShare={() => void room.toggleScreenShare()}
        onStartShare={(opts) => void room.startScreenShare(opts)}
        noteCount={room.notes.filter((n) => n.isMine !== false).length}
        onToggleHand={room.toggleHand}
        onReact={room.react}
        onToggleCaptions={() => {
          // A viewer turning captions on when nobody is transcribing has to
          // turn transcription on too — and only a host may.
          if (!room.transcribing && isHost) room.patchSettings({ transcriptionEnabled: true });
          setCaptionsOn((c) => !c);
        }}
        onToggleDataSaver={() => room.setDataSaver(!room.dataSaver)}
        onToggleRecording={() => void toggleRecording()}
        onSetLayout={room.setLayout}
        onOpenPanel={setPanel}
        onLeave={() => void leave()}
        onEndForAll={isHost ? () => void endForAll() : undefined}
      />

      {openPolls > 0 && panel !== 'polls' && (
        <button
          onClick={() => setPanel('polls')}
          // Nudged clear of the side panel when one is open: at `right-4` it
          // sat directly on top of the chat composer's send button.
          className={
            'absolute bottom-20 z-30 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium ' +
            'text-white transition-[right] duration-200 hover:bg-blue-500 ' +
            (panel ? 'right-4 md:right-[21rem] lg:right-[25rem]' : 'right-4')
          }
        >
          {openPolls} poll{openPolls === 1 ? '' : 's'} open — vote
        </button>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

const QUALITY_ICON = {
  excellent: <Signal size={13} className="text-emerald-400" />,
  good: <Signal size={13} className="text-emerald-400/70" />,
  poor: <SignalLow size={13} className="text-amber-400" />,
  lost: <SignalZero size={13} className="text-red-400" />,
};

const RoomHeader: React.FC<{
  title: string;
  joinCode: string;
  meetingId: string;
  admission: 'invited' | 'permission' | 'authenticated' | 'public';
  transport: MeetTransport;
  quality: 'excellent' | 'good' | 'poor' | 'lost';
  recording: boolean;
  aiPresent: boolean;
  dataSaver: boolean;
  startedAt: string | null;
  canRename: boolean;
  onRename: (title: string) => Promise<void>;
  recorderState: 'idle' | 'recording' | 'uploading' | 'error';
  recorderElapsed: number;
}> = ({
  title,
  joinCode,
  transport,
  quality,
  recording,
  aiPresent,
  dataSaver,
  startedAt,
  canRename,
  onRename,
  recorderState,
  recorderElapsed,
}) => {
  const [elapsed, setElapsed] = useState('');
  const [sharing, setSharing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(title);
  }, [title]);

  const commit = async () => {
    const next = draft.trim();
    if (!next || next === title) {
      setEditing(false);
      setDraft(title);
      return;
    }
    setSaving(true);
    try {
      await onRename(next);
      setEditing(false);
    } catch {
      setDraft(title);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!startedAt) return;
    const tick = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      setElapsed(
        h > 0
          ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
          : `${m}:${String(s).padStart(2, '0')}`,
      );
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-white/[0.07] bg-gradient-to-b from-slate-950 to-slate-950/60 px-4 py-2.5 backdrop-blur-md">
      {editing ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <input
            value={draft}
            autoFocus
            maxLength={200}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit();
              if (e.key === 'Escape') {
                setEditing(false);
                setDraft(title);
              }
            }}
            className="min-w-0 flex-1 rounded-lg border border-blue-500 bg-white/5 px-2 py-1 text-sm font-semibold text-white focus:outline-none"
          />
          <button
            onClick={() => void commit()}
            disabled={saving}
            aria-label="Save the name"
            className="grid h-6 w-6 place-items-center rounded text-emerald-400 hover:bg-white/10"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={13} />}
          </button>
          <button
            onClick={() => {
              setEditing(false);
              setDraft(title);
            }}
            aria-label="Cancel"
            className="grid h-6 w-6 place-items-center rounded text-white/40 hover:bg-white/10 hover:text-white"
          >
            <X size={13} />
          </button>
        </span>
      ) : (
        <span className="group flex min-w-0 items-center gap-1.5">
          <h1 className="min-w-0 truncate text-sm font-semibold text-white">{title}</h1>
          {canRename && (
            <button
              onClick={() => setEditing(true)}
              aria-label="Rename this meeting"
              className="grid h-6 w-6 shrink-0 place-items-center rounded text-white/30 opacity-0 transition-opacity duration-150 hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Pencil size={12} />
            </button>
          )}
        </span>
      )}
      <span className="hidden shrink-0 rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-white/45 sm:inline">
        {joinCode}
      </span>
      {elapsed && (
        <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-white/40">
          <span aria-hidden="true" className="h-3 w-px bg-white/10" />
          {elapsed}
        </span>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {recorderState === 'uploading' ? (
          <span className="flex items-center gap-1 rounded-full bg-blue-600/20 px-2 py-0.5 text-[11px] font-medium text-blue-200 ring-1 ring-blue-400/25">
            <Upload size={10} className="animate-pulse" /> Saving recording…
          </span>
        ) : (
          recording && (
            <span className="flex items-center gap-1 rounded-full bg-red-600/20 px-2 py-0.5 text-[11px] font-medium text-red-300 ring-1 ring-red-400/30">
              <Circle size={7} className="animate-rec-pulse fill-current" /> REC
              {recorderElapsed > 0 && (
                <span className="tabular-nums">
                  {String(Math.floor(recorderElapsed / 60)).padStart(2, '0')}:
                  {String(recorderElapsed % 60).padStart(2, '0')}
                </span>
              )}
            </span>
          )
        )}
        {aiPresent && (
          <span className="flex items-center gap-1 rounded-full bg-blue-600/20 px-2 py-0.5 text-[11px] font-medium text-blue-300 ring-1 ring-blue-400/25">
            <Sparkles size={10} /> AI notes
          </span>
        )}
        {dataSaver && (
          <span className="hidden rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/50 sm:inline">
            Data saver
          </span>
        )}
        {/* The transport is shown because it explains the participant cap and
 the latency, and because a support call goes very differently when
 you already know which one is in use. */}
        <span
          title={
            isSfuTransport(transport)
              ? 'Routed through a media server — every publisher uploads once, however large the meeting'
              : 'Peer-to-peer — lowest latency, limited to a small group'
          }
          className="hidden items-center gap-1.5 rounded-full bg-white/[0.07] px-2 py-0.5 text-[11px] text-white/55 ring-1 ring-white/10 md:flex"
        >
          <Wifi size={10} className={isSfuTransport(transport) ? 'text-emerald-400' : 'text-white/50'} />
          {transport === 'cloudflare' ? 'Cloudflare' : 'Peer-to-peer'}
        </span>
        <span title={`Connection: ${quality}`}>{QUALITY_ICON[quality]}</span>
      </div>
    </header>
  );
};

const FullScreenMessage: React.FC<{
  tone: 'error' | 'wait';
  title: string;
  body: string;
  action: { label: string; onClick: () => void };
}> = ({ tone, title, body, action }) => (
  <div className="tupo-aurora tupo-aurora-on-dark grid min-h-full place-items-center bg-slate-950 p-6 text-center">
    <div className="max-w-sm">
      {tone === 'wait' ? (
        <Loader2 size={26} className="mx-auto animate-spin text-blue-400" />
      ) : (
        <AlertTriangle size={26} className="mx-auto text-amber-400" />
      )}
      <h1 className="mt-4 text-base font-semibold text-white">{title}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-white/50">{body}</p>
      <button
        onClick={action.onClick}
        className="mt-5 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white transition-colors duration-150 hover:bg-white/20"
      >
        {action.label}
      </button>
    </div>
  </div>
);
