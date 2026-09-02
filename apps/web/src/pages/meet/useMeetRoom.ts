import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  DEFAULT_MEET_SETTINGS, MAX_VIDEO_TILES, REACTION_TTL_MS, parseMeetSettings,
} from '@tupo/shared';
import type {
  ConnectionQuality, HostCommand, MeetBreakoutRoom, MeetChatMessage, MeetJoinTicket,
  MeetLayout, MeetNote, MeetParticipant, MeetPoll, MeetQuestion, MeetReaction,
  MeetSettings, MeetTranscriptSegment, VideoQuality,
} from '@tupo/shared';
import { SESSION_KEY, MEET_GUEST_KEY } from '../../lib/api';
import { socketUrl } from '../../lib/socket';
import { MeshTransport } from './transport/mesh';
import { CloudflareTransport } from './transport/cloudflare';
import type { MediaTransport, RemoteMedia } from './transport/types';
import { qualityForWidth } from './transport/types';
import * as meetApi from './api';

/**
 * The meeting room's state machine and wiring.
 *
 * One hook because these three things are inseparable in practice: the socket
 * carries the roster, the roster decides what the transport should subscribe
 * to, and the transport's health decides what the socket reports. Splitting
 * them into three hooks would mean three copies of the same synchronisation.
 */

export type RoomPhase = 'connecting' | 'lobby' | 'active' | 'ended' | 'removed' | 'error';

export interface FloatingReaction {
  key: string;
  participantId: string;
  name: string;
  reaction: MeetReaction;
}

export interface MeetRoomState {
  phase: RoomPhase;
  error: string | null;
  settings: MeetSettings;
  you: MeetParticipant | null;
  participants: MeetParticipant[];
  lobby: MeetParticipant[];
  chat: MeetChatMessage[];
  captions: MeetTranscriptSegment[];
  polls: MeetPoll[];
  questions: MeetQuestion[];
  breakouts: MeetBreakoutRoom[];
  reactions: FloatingReaction[];
  speakingIds: string[];
  activeSpeakerId: string | null;
  spotlightId: string | null;
  pinnedId: string | null;
  recording: boolean;
  transcribing: boolean;
  aiPresent: boolean;
  aiThinking: string | null;
  media: Map<string, RemoteMedia>;
  localStream: MediaStream | null;
  micEnabled: boolean;
  cameraEnabled: boolean;
  screenSharing: boolean;
  /** The local screen stream, so the presenter sees what they are presenting. */
  screenStream: MediaStream | null;
  /** Whoever is presenting right now — theirs is the tile that fills the stage. */
  presenterId: string | null;
  presenterName: string | null;
  notes: MeetNote[];
  handRaised: boolean;
  layout: MeetLayout;
  /** Set when the user picked a layout by hand, so auto-switching stops
   *  overriding them the moment someone shares. */
  layoutPinned: boolean;
  quality: ConnectionQuality;
  /** Set by the host's data-saver, by a poor connection, or by the user. */
  publishQuality: VideoQuality;
  dataSaver: boolean;
  startedAt: string | null;
}

/** Computed by the hook, not stored: derived purely from the roster. */
export interface MeetRoomDerived {
  /** The participants whose tiles actually carry video, in render order. */
  videoTileIds: string[];
}

export interface MeetRoomActions {
  toggleMic: () => void;
  toggleCamera: () => void;
  toggleScreenShare: () => Promise<void>;
  startScreenShare: (opts?: {
    preferSurface?: 'monitor' | 'window' | 'browser'; withAudio?: boolean;
  }) => Promise<void>;
  stopScreenShare: () => Promise<void>;
  toggleHand: () => void;
  react: (reaction: MeetReaction) => void;
  sendChat: (body: string, toParticipantId?: string) => void;
  sendCaption: (s: { text: string; lang: string; isFinal: boolean; confidence?: number }) => void;
  hostCommand: (command: HostCommand) => Promise<{ ok: boolean; message?: string }>;
  patchSettings: (patch: Partial<MeetSettings>) => void;
  setLayout: (layout: MeetLayout) => void;
  setNotes: (notes: MeetNote[]) => void;
  shareNote: (note: MeetNote, shared: boolean) => void;
  setPinned: (participantId: string | null) => void;
  setDataSaver: (on: boolean) => void;
  createPoll: (p: {
    question: string; options: string[]; kind: 'poll' | 'quiz';
    correctOptionIndex?: number; anonymous: boolean; multipleChoice: boolean;
  }) => void;
  votePoll: (pollId: string, optionIndexes: number[]) => void;
  closePoll: (pollId: string) => void;
  askQuestion: (text: string) => void;
  upvoteQuestion: (questionId: string) => void;
  answerQuestion: (questionId: string, answerText: string) => void;
  openBreakouts: (p: {
    rooms: Array<{ name: string; participantIds: string[] }>;
    durationMinutes?: number; autoAssign?: boolean;
  }) => void;
  closeBreakouts: () => void;
  broadcastToBreakouts: (body: string) => void;
  setRecording: (active: boolean) => void;
  /** Report which tiles are on screen. Drives adaptive subscription. */
  reportVisible: (visible: Array<{ participantId: string; width: number }>) => void;
  leave: () => Promise<void>;
}

const CAPTION_WINDOW = 60;
const CHAT_WINDOW = 500;

export function useMeetRoom(
  ticket: MeetJoinTicket | null,
  initialStream: MediaStream | null,
): MeetRoomState & MeetRoomDerived & MeetRoomActions {
  const [state, setState] = useState<MeetRoomState>(() => ({
    phase: 'connecting',
    error: null,
    settings: ticket ? ticket.meeting.settings : DEFAULT_MEET_SETTINGS,
    you: null,
    participants: [],
    lobby: [],
    chat: [],
    captions: [],
    polls: [],
    questions: [],
    breakouts: [],
    reactions: [],
    speakingIds: [],
    activeSpeakerId: null,
    spotlightId: null,
    pinnedId: null,
    recording: false,
    transcribing: false,
    aiPresent: false,
    aiThinking: null,
    media: new Map(),
    localStream: initialStream,
    micEnabled: !!initialStream?.getAudioTracks().some((t) => t.enabled),
    cameraEnabled: !!initialStream?.getVideoTracks().some((t) => t.enabled),
    screenSharing: false,
    screenStream: null,
    presenterId: null,
    presenterName: null,
    notes: [],
    handRaised: false,
    layout: 'grid',
    layoutPinned: false,
    quality: 'good',
    publishQuality: 'high',
    dataSaver: false,
    startedAt: null,
  }));

  const socketRef = useRef<Socket | null>(null);
  const transportRef = useRef<MediaTransport | null>(null);
  const localStreamRef = useRef<MediaStream | null>(initialStream);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const vadCleanupRef = useRef<(() => void) | null>(null);
  /**
   * The last set of visible tiles.
   *
   * Tiles report their size as they mount, which is *before* the transport has
   * finished connecting — opening a media session takes several round trips.
   * Those early reports reach a null transport and are lost, and nothing
   * reports again because nothing about the layout has changed. On an SFU that
   * means never subscribing to anybody: the connection is up, the roster is
   * right, and no video ever arrives.
   */
  const lastVisibleRef = useRef<Array<{ participantId: string; quality: VideoQuality }>>([]);
  /** Latest state, readable from callbacks without re-creating them. */
  const stateRef = useRef<MeetRoomState | null>(null);
  /** The camera the user chose, remembered across a release/re-acquire cycle. */
  const cameraDeviceId = useRef<string | undefined>(undefined);
  const cameraBusy = useRef(false);

  const meetingId = ticket?.meeting.meetingId ?? '';

  const patch = useCallback((fn: (s: MeetRoomState) => Partial<MeetRoomState>) => {
    setState((s) => {
      const next = { ...s, ...fn(s) };
      stateRef.current = next;
      return next;
    });
  }, []);
  stateRef.current = state;

  /**
   * Adopt the stream the pre-join screen opened.
   *
   * It arrives on a *later* render than the one that initialises this hook —
   * the join request is in flight while the first render happens — so reading
   * it only from the lazy initial state leaves the ref null forever, and a
   * transport that connects with no tracks publishes nothing at all. That
   * failure is silent: the call connects, the roster is right, and every tile
   * is an avatar.
   */
  useEffect(() => {
    if (!initialStream || localStreamRef.current === initialStream) return;
    localStreamRef.current = initialStream;
    // Remember which camera this is, so releasing and re-acquiring the device
    // comes back to the one the user picked in the device check.
    cameraDeviceId.current =
      initialStream.getVideoTracks()[0]?.getSettings().deviceId ?? cameraDeviceId.current;
    setState((s) => ({
      ...s,
      localStream: initialStream,
      micEnabled: initialStream.getAudioTracks().some((t) => t.enabled),
      cameraEnabled: initialStream.getVideoTracks().some((t) => t.enabled),
    }));
    // Already connected (a stream swapped mid-call from the device picker) —
    // republish rather than waiting for a reconnect.
    if (transportRef.current) void transportRef.current.publish(initialStream);
  }, [initialStream]);

  /* ---------------- socket ---------------- */

  useEffect(() => {
    if (!ticket) return;

    const socket = io(socketUrl('/meet'), {
      auth: {
        token: localStorage.getItem(SESSION_KEY) ?? localStorage.getItem(MEET_GUEST_KEY),
      },
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('meet:join', {
        meetingId: ticket.meeting.meetingId,
        participantId: ticket.participantId,
      }, (res: { ok: boolean; message?: string }) => {
        if (!res?.ok) patch(() => ({ phase: 'error', error: res?.message ?? 'Could not join.' }));
      });
    });

    socket.on('connect_error', (err: Error) => {
      patch(() => ({ phase: 'error', error: err.message || 'Could not reach the meeting server.' }));
    });

    socket.on('meet:state', (p: {
      you: MeetParticipant; participants: MeetParticipant[]; lobby: MeetParticipant[];
      settings: MeetSettings; chat: MeetChatMessage[]; polls: MeetPoll[];
      questions: MeetQuestion[]; breakouts: MeetBreakoutRoom[];
      recording: boolean; transcribing: boolean; aiPresent: boolean;
      spotlightId: string | null; startedAt: string | null;
    }) => {
      // Someone may already be presenting when we arrive — `meet:presenting` is
      // only emitted on the change, so a late joiner has to read it off the
      // roster or the stage stays empty until the presenter toggles again.
      const presenter = p.participants.find((x) => x.screenSharing) ?? null;
      patch(() => ({
        phase: p.you.state === 'active' ? 'active' : 'lobby',
        you: p.you,
        participants: p.participants,
        presenterId: presenter?.id ?? null,
        presenterName: presenter?.name ?? null,
        lobby: p.lobby,
        settings: parseMeetSettings(p.settings),
        chat: p.chat,
        polls: p.polls,
        questions: p.questions,
        breakouts: p.breakouts,
        recording: p.recording,
        transcribing: p.transcribing,
        aiPresent: p.aiPresent,
        spotlightId: p.spotlightId,
        startedAt: p.startedAt,
        handRaised: p.you.handRaised,
      }));
    });

    socket.on('meet:participant_joined', (p: { participant: MeetParticipant }) => {
      patch((s) => ({
        participants: s.participants.some((x) => x.id === p.participant.id)
          ? s.participants
          : [...s.participants, p.participant],
        lobby: s.lobby.filter((x) => x.id !== p.participant.id),
      }));
    });

    socket.on('meet:participant_left', (p: { participantId: string }) => {
      patch((s) => {
        const media = new Map(s.media);
        media.delete(p.participantId);
        return {
          participants: s.participants.filter((x) => x.id !== p.participantId),
          media,
          pinnedId: s.pinnedId === p.participantId ? null : s.pinnedId,
        };
      });
    });

    socket.on('meet:participant_updated', (p: {
      participantId: string; changes: Partial<MeetParticipant>;
    }) => {
      patch((s) => ({
        participants: s.participants.map((x) =>
          x.id === p.participantId ? { ...x, ...p.changes } : x),
        you: s.you?.id === p.participantId ? { ...s.you, ...p.changes } : s.you,
      }));
    });

    socket.on('meet:lobby_knock', (p: { participant: MeetParticipant }) => {
      patch((s) => ({
        lobby: s.lobby.some((x) => x.id === p.participant.id)
          ? s.lobby : [...s.lobby, p.participant],
      }));
    });

    socket.on('meet:lobby_resolved', (p: { participantId: string }) => {
      patch((s) => ({ lobby: s.lobby.filter((x) => x.id !== p.participantId) }));
    });

    // Admission is the moment a lobby participant becomes a real one — and, on
    // the SFU, the moment they are finally entitled to a media token.
    socket.on('meet:admitted', () => {
      patch((s) => ({ phase: 'active', you: s.you ? { ...s.you, state: 'active' } : s.you }));
    });

    socket.on('meet:denied', (p: { reason: string }) => {
      patch(() => ({ phase: 'removed', error: p.reason }));
    });

    socket.on('meet:removed', () => {
      patch(() => ({ phase: 'removed', error: 'You were removed from this meeting.' }));
    });

    socket.on('meet:ended', () => {
      patch(() => ({ phase: 'ended' }));
    });

    socket.on('meet:chat', (p: { message: MeetChatMessage }) => {
      patch((s) => ({ chat: [...s.chat, p.message].slice(-CHAT_WINDOW) }));
    });

    socket.on('meet:caption', (p: { segment: MeetTranscriptSegment }) => {
      patch((s) => {
        // An interim segment replaces this speaker's previous interim rather
        // than stacking, or the caption bar fills with half-sentences.
        const withoutInterim = s.captions.filter(
          (c) => c.isFinal || c.participantId !== p.segment.participantId);
        return { captions: [...withoutInterim, p.segment].slice(-CAPTION_WINDOW) };
      });
    });

    socket.on('meet:reaction', (p: {
      participantId: string; name: string; reaction: MeetReaction;
    }) => {
      const key = `${p.participantId}-${Date.now()}-${Math.random()}`;
      patch((s) => ({ reactions: [...s.reactions, { key, ...p }] }));
      setTimeout(() => {
        patch((s) => ({ reactions: s.reactions.filter((r) => r.key !== key) }));
      }, REACTION_TTL_MS);
    });

    socket.on('meet:hand', (p: { participantId: string; raised: boolean; at: string }) => {
      patch((s) => ({
        participants: s.participants.map((x) =>
          x.id === p.participantId
            ? { ...x, handRaised: p.raised, handRaisedAt: p.raised ? p.at : null }
            : x),
        handRaised: s.you?.id === p.participantId ? p.raised : s.handRaised,
      }));
    });

    socket.on('meet:speaking', (p: { speaking: string[] }) => {
      patch(() => ({ speakingIds: p.speaking }));
    });

    socket.on('meet:active_speaker', (p: { participantId: string | null }) => {
      patch(() => ({ activeSpeakerId: p.participantId }));
    });

    socket.on('meet:spotlight', (p: { participantId: string | null }) => {
      patch(() => ({ spotlightId: p.participantId }));
    });

    /**
     * Someone started or stopped presenting.
     *
     * The layout switches itself, the way Meet and Zoom do — a share nobody can
     * see is the single most common way a presentation goes wrong. It does not
     * override a layout the user chose by hand.
     */
    socket.on('meet:presenting', (p: {
      participantId: string; name: string; presenting: boolean; screenStreamId?: string | null;
    }) => {
      const transport = transportRef.current;
      if (transport instanceof MeshTransport) {
        transport.setScreenStreamId(p.participantId, p.presenting ? p.screenStreamId ?? null : null);
      } else if (transport instanceof CloudflareTransport) {
        // The SFU only forwards a track when asked, and a screen share has no
        // tile of its own to ask on its behalf — so the transport is told here.
        transport.setPresenting(p.participantId, p.presenting);
      }
      patch((s) => {
        if (p.presenting) {
          return {
            presenterId: p.participantId,
            presenterName: p.name,
            layout: s.layoutPinned ? s.layout : 'sidebar',
          };
        }
        // Only clear if this is the presenter we were tracking — a second
        // sharer stopping must not blank the first one's stage.
        if (s.presenterId !== p.participantId) return {};
        return {
          presenterId: null,
          presenterName: null,
          layout: s.layoutPinned ? s.layout : 'grid',
        };
      });
    });

    socket.on('meet:sfu:published', (p: { participantId: string; sessionId: string }) => {
      patch((s) => ({
        participants: s.participants.map((x) =>
          x.id === p.participantId ? { ...x, sfuSessionId: p.sessionId } : x),
      }));
    });

    socket.on('meet:note_shared', (p: { note: MeetNote }) => {
      patch((s) => ({
        notes: s.notes.some((n) => n.id === p.note.id)
          ? s.notes.map((n) => (n.id === p.note.id ? { ...p.note, isMine: n.isMine } : n))
          : [...s.notes, { ...p.note, isMine: false }],
      }));
    });

    socket.on('meet:note_unshared', (p: { noteId: string }) => {
      // Drop it unless it is ours — un-sharing removes it from everyone else.
      patch((s) => ({ notes: s.notes.filter((n) => n.id !== p.noteId || n.isMine) }));
    });

    socket.on('meet:settings_updated', (p: { settings: MeetSettings }) => {
      patch(() => ({ settings: parseMeetSettings(p.settings) }));
    });

    socket.on('meet:locked', (p: { locked: boolean }) => {
      patch((s) => ({ settings: { ...s.settings, locked: p.locked } }));
    });

    socket.on('meet:recording', (p: { active: boolean }) => {
      patch(() => ({ recording: p.active }));
    });

    socket.on('meet:transcribing', (p: { active: boolean }) => {
      patch(() => ({ transcribing: p.active }));
    });

    socket.on('meet:ai_presence', (p: { present: boolean }) => {
      patch(() => ({ aiPresent: p.present }));
    });

    socket.on('meet:ai_thinking', (p: { kind: string }) => {
      patch(() => ({ aiThinking: p.kind }));
    });

    socket.on('meet:poll', (p: { poll: MeetPoll }) => {
      patch((s) => ({
        polls: s.polls.some((x) => x.id === p.poll.id)
          ? s.polls.map((x) => (x.id === p.poll.id ? p.poll : x))
          : [...s.polls, p.poll],
      }));
    });

    socket.on('meet:poll_closed', (p: { poll: MeetPoll }) => {
      patch((s) => ({ polls: s.polls.map((x) => (x.id === p.poll.id ? p.poll : x)) }));
    });

    socket.on('meet:question', (p: { question: MeetQuestion }) => {
      patch((s) => ({ questions: [...s.questions, p.question] }));
    });

    socket.on('meet:question_updated', (p: { question: MeetQuestion }) => {
      patch((s) => ({
        questions: s.questions.map((x) => (x.id === p.question.id ? p.question : x)),
      }));
    });

    socket.on('meet:breakouts', (p: { rooms: MeetBreakoutRoom[] }) => {
      patch(() => ({ breakouts: p.rooms }));
    });

    // A host command a participant cannot refuse: the track is switched off
    // locally, which is the only place it can actually be switched off.
    socket.on('meet:force_mute', () => {
      for (const t of localStreamRef.current?.getAudioTracks() ?? []) t.enabled = false;
      patch(() => ({ micEnabled: false }));
    });

    socket.on('meet:force_camera_off', () => {
      for (const t of localStreamRef.current?.getVideoTracks() ?? []) t.enabled = false;
      patch(() => ({ cameraEnabled: false }));
    });

    socket.on('meet:quality_advice', (p: { quality: VideoQuality }) => {
      patch(() => ({ publishQuality: p.quality }));
      void transportRef.current?.setPublishQuality(p.quality);
    });

    socket.on('meet:error', (p: { message: string }) => {
      patch(() => ({ error: p.message }));
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [ticket, patch]);

  /* ---------------- transport ---------------- */

  useEffect(() => {
    const socket = socketRef.current;
    // The transport is only opened once admitted. Someone in the lobby has a
    // socket and a roster but no business publishing media into the room.
    if (!ticket || !socket || state.phase !== 'active' || transportRef.current) return;
    // Wait for the local stream to have been adopted. Connecting first and
    // publishing later would work, but it costs a renegotiation on every
    // peer — and on mesh that is one per participant.
    if (initialStream && !localStreamRef.current) return;

    let cancelled = false;

    const events = {
      onRemoteMedia: (media: RemoteMedia) => {
        patch((s) => {
          const next = new Map(s.media);
          next.set(media.participantId, media);
          return { media: next };
        });
      },
      onRemoteGone: (participantId: string) => {
        patch((s) => {
          const next = new Map(s.media);
          next.delete(participantId);
          return { media: next };
        });
      },
      onQuality: (q: { quality: ConnectionQuality; packetLoss: number; rttMs: number }) => {
        patch(() => ({ quality: q.quality }));
        socket.emit('meet:stats', q);
      },
      onError: (message: string) => patch(() => ({ error: message })),
    };

    void (async () => {
      try {
        // The token in the original ticket may predate admission, so it is
        // refreshed here rather than reused.
        const fresh = ticket.state === 'active'
          ? ticket
          : { ...ticket, ...(await meetApi.refreshToken(ticket.meeting.meetingId)) };
        if (cancelled) return;

        const transport: MediaTransport = fresh.transport === 'cloudflare'
          ? new CloudflareTransport(socket, {
              meetingId: ticket.meeting.meetingId,
              participantId: ticket.participantId,
              iceServers: fresh.iceServers,
              sfuEndpoint: fresh.sfuEndpoint,
              events,
            })
          : new MeshTransport(socket, {
              meetingId: ticket.meeting.meetingId,
              participantId: ticket.participantId,
              iceServers: fresh.iceServers,
              events,
            });

        // Anyone already publishing when we arrive is on the roster, so the
        // SFU transport is told about them before it connects — otherwise a
        // late joiner would see nobody until each of them happened to
        // re-announce.
        if (transport instanceof CloudflareTransport) {
          transport.setKnownSessions(
            (stateRef.current?.participants ?? [])
              .filter((p) => p.sfuSessionId && p.id !== ticket.participantId)
              .map((p) => ({ participantId: p.id, sessionId: p.sfuSessionId! })),
          );
        }

        await transport.connect(localStreamRef.current);
        if (cancelled) { void transport.disconnect(); return; }
        transportRef.current = transport;

        // Replay what the tiles reported while this was still connecting.
        // Without it the first view of a meeting subscribes to nothing.
        if (lastVisibleRef.current.length) {
          void transport.setSubscriptions(lastVisibleRef.current);
        }

        // Tell the fresh transport about a share that was already running when
        // we joined — the socket announced it before the transport existed.
        for (const p of stateRef.current?.participants ?? []) {
          if (!p.screenSharing || p.id === ticket.participantId) continue;
          if (transport instanceof MeshTransport) {
            transport.setScreenStreamId(p.id, p.screenStreamId ?? null);
          } else if (transport instanceof CloudflareTransport) {
            transport.setPresenting(p.id, true);
          }
        }

        // Tell the room what we arrived with, so the roster is not showing
        // everyone as muted until their first toggle.
        socket.emit('meet:media_state', {
          audioEnabled: !!localStreamRef.current?.getAudioTracks().some((t) => t.enabled),
          videoEnabled: !!localStreamRef.current?.getVideoTracks().some((t) => t.enabled),
        });
      } catch (err) {
        if (!cancelled) {
          patch(() => ({
            error: err instanceof Error ? err.message : 'Could not connect media.',
          }));
        }
      }
    })();

    return () => { cancelled = true; };
  }, [ticket, state.phase, initialStream, patch]);

  // Torn down separately from setup so a phase flap does not close the media.
  useEffect(() => () => {
    void transportRef.current?.disconnect();
    transportRef.current = null;
    vadCleanupRef.current?.();
    for (const t of screenStreamRef.current?.getTracks() ?? []) t.stop();
  }, []);

  /* ---------------- voice activity detection ---------------- */

  /**
   * Speaking state is computed here rather than on the server. Analysing every
   * stream server-side would mean decoding media the SFU is otherwise only
   * forwarding, and the worst a client can achieve by lying is a highlighted
   * tile.
   */
  useEffect(() => {
    const socket = socketRef.current;
    const stream = state.localStream;
    if (!socket || !stream || !state.micEnabled) {
      vadCleanupRef.current?.();
      vadCleanupRef.current = null;
      return;
    }
    if (!stream.getAudioTracks().length) return;

    let ctx: AudioContext | null = null;
    let raf: number | null = null;
    let speaking = false;
    let quietSince = 0;

    try {
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (const v of buffer) {
          const centred = (v - 128) / 128;
          sum += centred * centred;
        }
        const rms = Math.sqrt(sum / buffer.length);
        const now = Date.now();

        if (rms > 0.045) {
          quietSince = 0;
          if (!speaking) { speaking = true; socket.emit('meet:speaking_state', { speaking: true, level: rms }); }
        } else {
          // A hold-off before declaring silence — without it the tile border
          // strobes on every pause between words.
          if (speaking) {
            if (!quietSince) quietSince = now;
            else if (now - quietSince > 800) {
              speaking = false; quietSince = 0;
              socket.emit('meet:speaking_state', { speaking: false });
            }
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } catch { /* no AudioContext available */ }

    const cleanup = () => {
      if (raf !== null) cancelAnimationFrame(raf);
      void ctx?.close().catch(() => {});
      if (speaking) socket.emit('meet:speaking_state', { speaking: false });
    };
    vadCleanupRef.current = cleanup;
    return cleanup;
  }, [state.localStream, state.micEnabled]);

  /* ---------------- actions ---------------- */

  const toggleMic = useCallback(() => {
    setState((s) => {
      const next = !s.micEnabled;
      // An attendee the host has locked down cannot switch their own mic back
      // on — the server would not honour it, so the UI must not pretend.
      if (next && !s.settings.allowAttendeeUnmute &&
          s.you && s.you.role !== 'host' && s.you.role !== 'cohost') {
        return { ...s, error: 'The host has muted attendees for this meeting.' };
      }
      for (const t of localStreamRef.current?.getAudioTracks() ?? []) t.enabled = next;
      void transportRef.current?.setMicEnabled(next);
      socketRef.current?.emit('meet:media_state', { audioEnabled: next });
      return { ...s, micEnabled: next, error: null };
    });
  }, []);

  /**
   * Turn the camera off, and mean it.
   *
   * Flipping `track.enabled` stops the frames but leaves the *device* open —
   * the capture keeps running and the hardware light stays on. People read
   * that light as "it is still watching me", and they are not wrong to. So
   * "off" stops the track and releases the device; "on" acquires a fresh one
   * and hands it to the peer connection with `replaceTrack`, which needs no
   * renegotiation.
   *
   * The device id is remembered across the cycle so turning the camera back on
   * returns to the camera you had chosen, not whichever one the browser
   * happens to consider default.
   */

  const toggleCamera = useCallback(() => {
    if (cameraBusy.current) return;      // double-tap would race the acquire
    cameraBusy.current = true;

    void (async () => {
      const turningOn = !stateRef.current?.cameraEnabled;
      try {
        if (turningOn) {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: cameraDeviceId.current
              ? { deviceId: { exact: cameraDeviceId.current } }
              : true,
          });
          const track = stream.getVideoTracks()[0] ?? null;
          if (track) {
            // Keep one MediaStream identity for the local preview: the tile
            // holds a reference to it, so swapping the object would blank it.
            const local = localStreamRef.current;
            if (local) {
              for (const old of local.getVideoTracks()) { old.stop(); local.removeTrack(old); }
              local.addTrack(track);
            } else {
              localStreamRef.current = stream;
            }
            await transportRef.current?.replaceVideoTrack(track);
          }
        } else {
          for (const t of localStreamRef.current?.getVideoTracks() ?? []) {
            t.stop();                                  // releases the device
            localStreamRef.current?.removeTrack(t);
          }
          await transportRef.current?.replaceVideoTrack(null);
        }

        await transportRef.current?.setCameraEnabled(turningOn);
        socketRef.current?.emit('meet:media_state', { videoEnabled: turningOn });
        setState((s) => ({ ...s, cameraEnabled: turningOn, error: null }));
      } catch (err) {
        setState((s) => ({
          ...s,
          error: err instanceof Error && err.name === 'NotAllowedError'
            ? 'The camera is blocked for this site. Allow it in the browser address bar.'
            : 'Could not turn the camera back on.',
        }));
      } finally {
        cameraBusy.current = false;
      }
    })();
  }, []);

  const stopScreenShare = useCallback(async () => {
    const transport = transportRef.current;
    for (const t of screenStreamRef.current?.getTracks() ?? []) t.stop();
    screenStreamRef.current = null;
    await transport?.stopScreenShare();
    socketRef.current?.emit('meet:media_state', {
      screenSharing: false, screenStreamId: null,
    });
    patch(() => ({ screenSharing: false, screenStream: null }));
  }, [patch]);

  /**
   * Start presenting.
   *
   * `getDisplayMedia` is the only way to reach the browser's own source picker,
   * and it must be called straight off the click — a picker opened after an
   * await is blocked as a non-gesture in Safari and Firefox. So the options are
   * assembled first and the call is the first thing that happens.
   */
  const startScreenShare = useCallback(async (opts?: {
    /** Ask the picker to preselect a surface — 'monitor', 'window' or 'browser'. */
    preferSurface?: 'monitor' | 'window' | 'browser';
    /** Include the tab's or system's audio, for a video or a slide with sound. */
    withAudio?: boolean;
  }) => {
    if (screenStreamRef.current) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          // A slide deck is mostly static, so frames are worth less than
          // legibility. 'text' tells the encoder to protect detail over motion.
          frameRate: { ideal: 15, max: 30 },
          ...(opts?.preferSurface ? { displaySurface: opts.preferSurface } : {}),
        } as MediaTrackConstraints,
        audio: opts?.withAudio ?? false,
        // Chromium: keep the picker on this tab rather than switching to the
        // shared surface, so the presenter can still see the room.
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: opts?.withAudio ? 'include' : 'exclude',
      } as DisplayMediaStreamOptions);
    } catch {
      // Dismissing the picker is a choice, not an error worth reporting.
      return;
    }

    const transport = transportRef.current;
    if (!transport) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }

    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack) {
      try {
        await videoTrack.applyConstraints({ frameRate: { ideal: 15, max: 30 } });
      } catch { /* constraint unsupported; the default is acceptable */ }
      // The browser's own "Stop sharing" bar lives outside the page, so the
      // track ending is the only signal that the user used it.
      videoTrack.onended = () => { void stopScreenShare(); };
    }

    screenStreamRef.current = stream;
    const streamId = await transport.startScreenShare(stream);
    socketRef.current?.emit('meet:media_state', {
      screenSharing: true, screenStreamId: streamId,
    });
    patch(() => ({ screenSharing: true, screenStream: stream }));
  }, [patch, stopScreenShare]);

  const toggleScreenShare = useCallback(async () => {
    if (screenStreamRef.current) await stopScreenShare();
    else await startScreenShare();
  }, [startScreenShare, stopScreenShare]);

  const toggleHand = useCallback(() => {
    setState((s) => {
      socketRef.current?.emit('meet:hand', { raised: !s.handRaised });
      return { ...s, handRaised: !s.handRaised };
    });
  }, []);

  const react = useCallback((reaction: MeetReaction) => {
    socketRef.current?.emit('meet:reaction', { reaction });
  }, []);

  const sendChat = useCallback((body: string, toParticipantId?: string) => {
    socketRef.current?.emit('meet:chat', { body, toParticipantId });
  }, []);

  const sendCaption = useCallback((
    s: { text: string; lang: string; isFinal: boolean; confidence?: number },
  ) => {
    socketRef.current?.emit('meet:caption', s);
  }, []);

  const hostCommand = useCallback((command: HostCommand) =>
    new Promise<{ ok: boolean; message?: string }>((resolve) => {
      const socket = socketRef.current;
      if (!socket) return resolve({ ok: false, message: 'Not connected.' });
      socket.emit('meet:host_command', command, (res: { ok: boolean; message?: string }) =>
        resolve(res ?? { ok: false }));
    }), []);

  const patchSettings = useCallback((p: Partial<MeetSettings>) => {
    socketRef.current?.emit('meet:settings', p);
  }, []);

  const setLayout = useCallback((layout: MeetLayout) => {
    // Choosing a layout by hand pins it: auto-switching on a share is a helpful
    // default exactly once, and an infuriating override every time after.
    patch(() => ({ layout, layoutPinned: true }));
    socketRef.current?.emit('meet:layout', { layout });
  }, [patch]);

  const setNotes = useCallback((notes: MeetNote[]) => patch(() => ({ notes })), [patch]);

  const shareNote = useCallback((note: MeetNote, shared: boolean) => {
    socketRef.current?.emit('meet:note_share', { note, shared });
    patch((s) => ({
      notes: s.notes.map((n) => (n.id === note.id ? { ...n, isShared: shared } : n)),
    }));
  }, [patch]);

  const setPinned = useCallback((participantId: string | null) => {
    patch((s) => ({ pinnedId: s.pinnedId === participantId ? null : participantId }));
  }, [patch]);

  /**
   * Data saver. Caps what we send *and* what we ask for — a school connection
   * that is struggling is usually struggling in both directions.
   */
  const setDataSaver = useCallback((on: boolean) => {
    patch(() => ({ dataSaver: on, publishQuality: on ? 'low' : 'high' }));
    void transportRef.current?.setPublishQuality(on ? 'low' : 'high');
  }, [patch]);

  const createPoll = useCallback((p: {
    question: string; options: string[]; kind: 'poll' | 'quiz';
    correctOptionIndex?: number; anonymous: boolean; multipleChoice: boolean;
  }) => { socketRef.current?.emit('meet:poll_create', p); }, []);

  const votePoll = useCallback((pollId: string, optionIndexes: number[]) => {
    socketRef.current?.emit('meet:poll_vote', { pollId, optionIndexes });
  }, []);

  const closePoll = useCallback((pollId: string) => {
    socketRef.current?.emit('meet:poll_close', { pollId });
  }, []);

  const askQuestion = useCallback((text: string) => {
    socketRef.current?.emit('meet:question_ask', { text });
  }, []);

  const upvoteQuestion = useCallback((questionId: string) => {
    socketRef.current?.emit('meet:question_upvote', { questionId });
  }, []);

  const answerQuestion = useCallback((questionId: string, answerText: string) => {
    socketRef.current?.emit('meet:question_answer', { questionId, answerText });
  }, []);

  const openBreakouts = useCallback((p: {
    rooms: Array<{ name: string; participantIds: string[] }>;
    durationMinutes?: number; autoAssign?: boolean;
  }) => { socketRef.current?.emit('meet:breakout_open', p); }, []);

  const closeBreakouts = useCallback(() => {
    socketRef.current?.emit('meet:breakout_close', {});
  }, []);

  const broadcastToBreakouts = useCallback((body: string) => {
    socketRef.current?.emit('meet:breakout_broadcast', { body });
  }, []);

  const setRecording = useCallback((active: boolean) => {
    socketRef.current?.emit('meet:recording', { active });
  }, []);

  /**
   * Report what is on screen so the transport can subscribe accordingly.
   *
   * This is where the downlink saving actually happens: a 160px thumbnail is
   * served the 180p rung, an off-screen tile is not served at all, and a room
   * of a hundred people costs a handful of streams instead of ninety-nine.
   */
  const reportVisible = useCallback((visible: Array<{ participantId: string; width: number }>) => {
    // The rung each tile already holds, so a tile resting on a boundary keeps
    // what it has instead of thrashing between two layers.
    const held = new Map(lastVisibleRef.current.map((v) => [v.participantId, v.quality]));
    const mapped = visible.map((v) => ({
      participantId: v.participantId,
      quality: qualityForWidth(v.width, held.get(v.participantId)),
    }));
    lastVisibleRef.current = mapped;
    void transportRef.current?.setSubscriptions(mapped);
    socketRef.current?.emit('meet:subscriptions', { visible: mapped });
  }, []);

  const leave = useCallback(async () => {
    socketRef.current?.emit('meet:leave', { meetingId });
    await transportRef.current?.disconnect();
    transportRef.current = null;
    for (const t of localStreamRef.current?.getTracks() ?? []) t.stop();
    for (const t of screenStreamRef.current?.getTracks() ?? []) t.stop();
    localStreamRef.current = null;
    screenStreamRef.current = null;
    if (meetingId) await meetApi.leaveMeeting(meetingId).catch(() => {});
  }, [meetingId]);

  /* ---------------- derived ---------------- */

  /**
   * Which tiles get video.
   *
   * Capped at MAX_VIDEO_TILES and ordered so the cap never hides someone who
   * matters: spotlight and pin first (an explicit choice), then whoever is
   * sharing a screen, then the active speaker, then anyone speaking, then
   * hands up, then the rest. Everyone past the cap is an avatar with audio —
   * which is what keeps a hundred-person assembly inside a school's bandwidth.
   */
  const videoTileIds = useMemo(() => {
    const rank = (p: MeetParticipant): number => {
      if (p.id === state.spotlightId) return 0;
      if (p.id === state.pinnedId) return 1;
      if (p.screenSharing || p.id === state.presenterId) return 2;
      if (p.id === state.activeSpeakerId) return 3;
      if (state.speakingIds.includes(p.id)) return 4;
      if (p.handRaised) return 5;
      if (p.videoEnabled) return 6;
      return 7;
    };
    return [...state.participants]
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, state.dataSaver ? 4 : MAX_VIDEO_TILES)
      .map((p) => p.id);
  }, [state.participants, state.spotlightId, state.pinnedId, state.activeSpeakerId,
    state.presenterId, state.speakingIds, state.dataSaver]);

  return {
    ...state,
    videoTileIds,
    toggleMic, toggleCamera, toggleScreenShare, startScreenShare, stopScreenShare,
    toggleHand, react, sendChat, sendCaption,
    hostCommand, patchSettings, setLayout, setNotes, shareNote, setPinned, setDataSaver,
    createPoll, votePoll, closePoll, askQuestion, upvoteQuestion, answerQuestion,
    openBreakouts, closeBreakouts, broadcastToBreakouts, setRecording,
    reportVisible, leave,
  };
}
