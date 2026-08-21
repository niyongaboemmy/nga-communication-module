import type {
  ConnectionQuality, HostCommand, MeetChapter, MeetLayout, MeetNote, MeetParticipant,
  MeetReaction, MeetRole, MeetSettings, MeetTransport, MeetActionItem, MeetDecision,
  ParticipantState, VideoQuality,
} from './meet.js';

/**
 * The `/meet` socket namespace (SRS §9.2, §10.1).
 *
 * tupo-realtime owns everything in this file: the roster, the lobby, host
 * commands, hand-raise order, chat, captions, polls, breakouts — and, on the
 * mesh transport, the SDP/ICE relay. The media server (when there is one) owns
 * only the media. That split is what lets a media-server hiccup drop the video
 * without losing the meeting.
 */

/* ------------------------------------------------------------------ *
 * Sub-shapes
 * ------------------------------------------------------------------ */

export interface MeetChatMessage {
  id: string;
  meetingId: string;
  participantId: string;
  senderName: string;
  body: string;
  /** Set for a private in-meeting DM; absent means the whole room. */
  toParticipantId?: string | null;
  createdAt: string;
}

export interface MeetTranscriptSegment {
  id: string;
  meetingId: string;
  participantId: string;
  speakerName: string;
  text: string;
  lang: string;
  isFinal: boolean;
  confidence?: number;
  startedAt: string;
}

export interface MeetPollOption { index: number; text: string; votes: number }

export interface MeetPoll {
  id: string;
  meetingId: string;
  kind: 'poll' | 'quiz';
  question: string;
  options: MeetPollOption[];
  correctOptionIndex?: number | null;
  anonymous: boolean;
  multipleChoice: boolean;
  status: 'open' | 'closed';
  totalVotes: number;
  /** Present only for the current viewer. */
  myVote?: number[] | null;
  createdAt: string;
}

export interface MeetQuestion {
  id: string;
  meetingId: string;
  participantId: string;
  askedBy: string;
  text: string;
  upvotes: number;
  answered: boolean;
  answerText?: string | null;
  createdAt: string;
}

export interface MeetBreakoutRoom {
  id: string;
  meetingId: string;
  name: string;
  participantIds: string[];
  status: 'open' | 'closed';
  closesAt?: string | null;
}

export interface MeetAiArtifact {
  id: string;
  meetingId: string;
  kind: string;
  content: unknown;
  providerUsed?: string | null;
  createdAt: string;
}

export interface MeetNetworkStats {
  quality: ConnectionQuality;
  rttMs?: number;
  packetLoss?: number;
  outboundKbps?: number;
  inboundKbps?: number;
  /** The layer this client is currently sending as its top simulcast rung. */
  publishQuality?: VideoQuality;
}

/* ------------------------------------------------------------------ *
 * Server → client
 * ------------------------------------------------------------------ */

export interface MeetServerEvents {
  /** The full state a client needs on join. Sent once, then deltas only. */
  'meet:state': (p: {
    meetingId: string;
    transport: MeetTransport;
    you: MeetParticipant;
    participants: MeetParticipant[];
    lobby: MeetParticipant[];
    settings: MeetSettings;
    chat: MeetChatMessage[];
    polls: MeetPoll[];
    questions: MeetQuestion[];
    breakouts: MeetBreakoutRoom[];
    recording: boolean;
    transcribing: boolean;
    aiPresent: boolean;
    spotlightId: string | null;
    startedAt: string | null;
    serverTime: string;
  }) => void;

  'meet:participant_joined': (p: { participant: MeetParticipant }) => void;
  'meet:participant_left': (p: { participantId: string; reason: string }) => void;
  'meet:participant_updated': (p: { participantId: string; changes: Partial<MeetParticipant> }) => void;
  /** A participant's Cloudflare SFU session is live and publishing. Everyone
   *  needs this to subscribe to them. */
  'meet:sfu:published': (p: {
    participantId: string; sessionId: string;
  }) => void;

  /** Who is presenting, and (on mesh) which MediaStream carries it. */
  'meet:presenting': (p: {
    participantId: string; name: string; presenting: boolean; screenStreamId?: string | null;
  }) => void;
  'meet:roster': (p: { participants: MeetParticipant[] }) => void;

  /* Lobby — the host side and the waiting side of the same moment. */
  'meet:lobby_knock': (p: { participant: MeetParticipant }) => void;
  'meet:lobby_resolved': (p: { participantId: string; admitted: boolean; by: string }) => void;
  'meet:admitted': (p: { participantId: string }) => void;
  'meet:denied': (p: { reason: string }) => void;

  /* Host */
  'meet:host_command': (p: { command: HostCommand; by: string; byName: string }) => void;
  'meet:force_mute': (p: { by: string; byName: string }) => void;
  'meet:force_camera_off': (p: { by: string; byName: string }) => void;
  'meet:unmute_requested': (p: { by: string; byName: string }) => void;
  'meet:removed': (p: { by: string; reason?: string }) => void;
  'meet:role_changed': (p: { participantId: string; role: MeetRole }) => void;
  'meet:settings_updated': (p: { settings: MeetSettings; by: string }) => void;
  'meet:locked': (p: { locked: boolean; by: string }) => void;
  'meet:ended': (p: { by: string; at: string; summaryUrl?: string }) => void;

  /* Interaction */
  'meet:hand': (p: { participantId: string; raised: boolean; at: string; queuePosition: number }) => void;
  'meet:reaction': (p: { participantId: string; name: string; reaction: MeetReaction; at: string }) => void;
  'meet:chat': (p: { message: MeetChatMessage }) => void;
  'meet:chat_cleared': (p: { by: string }) => void;
  'meet:speaking': (p: { speaking: string[] }) => void;
  'meet:active_speaker': (p: { participantId: string | null; at: string }) => void;
  'meet:spotlight': (p: { participantId: string | null; by: string }) => void;

  /* Polls & Q&A */
  'meet:poll': (p: { poll: MeetPoll }) => void;
  'meet:poll_closed': (p: { poll: MeetPoll }) => void;
  'meet:question': (p: { question: MeetQuestion }) => void;
  'meet:question_updated': (p: { question: MeetQuestion }) => void;

  /* Breakouts */
  'meet:breakouts': (p: { rooms: MeetBreakoutRoom[] }) => void;
  'meet:breakout_assigned': (p: { roomId: string; roomName: string; closesAt: string | null }) => void;
  'meet:breakout_closing': (p: { inSeconds: number }) => void;
  'meet:breakout_broadcast': (p: { body: string; from: string }) => void;

  /* Recording & transcript */
  'meet:recording': (p: { active: boolean; by: string; startedAt: string | null }) => void;
  'meet:transcribing': (p: { active: boolean; by: string }) => void;
  'meet:caption': (p: { segment: MeetTranscriptSegment }) => void;
  'meet:caption_translated': (p: { segmentId: string; lang: string; text: string }) => void;

  /* Notes — only shared ones ever travel; a private note never leaves its author. */
  'meet:note_shared': (p: { note: MeetNote }) => void;
  'meet:note_unshared': (p: { noteId: string }) => void;

  /* AI */
  'meet:ai_presence': (p: { present: boolean; by: string; byName: string }) => void;
  'meet:ai_thinking': (p: { kind: string }) => void;
  'meet:ai_artifact': (p: { artifact: MeetAiArtifact }) => void;
  'meet:ai_error': (p: { kind: string; message: string }) => void;

  /* Mesh signalling — the proctoring module's handshake, renamed. */
  'meet:mesh:peer_joined': (p: { participantId: string; shouldOffer: boolean }) => void;
  'meet:mesh:peer_left': (p: { participantId: string }) => void;
  'meet:mesh:offer': (p: { from: string; sdp: string }) => void;
  'meet:mesh:answer': (p: { from: string; sdp: string }) => void;
  'meet:mesh:ice': (p: { from: string; candidate: unknown }) => void;
  'meet:mesh:renegotiate': (p: { from: string }) => void;

  /* Health */
  'meet:quality_advice': (p: { quality: VideoQuality; reason: string }) => void;
  'meet:error': (p: { code: string; message: string }) => void;
}

/* ------------------------------------------------------------------ *
 * Client → server
 * ------------------------------------------------------------------ */

export interface MeetClientEvents {
  'meet:join': (
    p: { meetingId: string; participantId: string; deviceLabel?: string },
    ack: (r: { ok: boolean; message?: string }) => void,
  ) => void;
  'meet:leave': (p: { meetingId: string }) => void;

  'meet:media_state': (p: {
    audioEnabled?: boolean; videoEnabled?: boolean; screenSharing?: boolean;
    /** Mesh only. A peer connection carries camera and screen as two video
     *  tracks; without the sharer naming the stream, the receiver has to guess
     *  from track order — which is wrong the moment anyone toggles a camera. */
    screenStreamId?: string | null;
  }) => void;
  'meet:speaking_state': (p: { speaking: boolean; level?: number }) => void;
  'meet:hand': (p: { raised: boolean }) => void;
  'meet:reaction': (p: { reaction: MeetReaction }) => void;
  'meet:chat': (p: { body: string; toParticipantId?: string }, ack?: (r: { ok: boolean }) => void) => void;

  'meet:host_command': (p: HostCommand, ack?: (r: { ok: boolean; message?: string }) => void) => void;
  'meet:settings': (p: Partial<MeetSettings>, ack?: (r: { ok: boolean; message?: string }) => void) => void;

  'meet:caption': (p: { text: string; lang: string; isFinal: boolean; confidence?: number }) => void;
  'meet:layout': (p: { layout: MeetLayout }) => void;
  'meet:stats': (p: MeetNetworkStats) => void;
  /** Which participants this client actually has on screen, and how big. Drives
   *  adaptive subscription — the single biggest downlink saving available. */
  'meet:subscriptions': (p: { visible: Array<{ participantId: string; quality: VideoQuality }> }) => void;

  'meet:poll_vote': (p: { pollId: string; optionIndexes: number[] }, ack?: (r: { ok: boolean }) => void) => void;
  'meet:question_ask': (p: { text: string }, ack?: (r: { ok: boolean }) => void) => void;
  'meet:question_upvote': (p: { questionId: string }) => void;

  'meet:breakout_broadcast': (p: { body: string }) => void;
  'meet:breakout_return': (p: Record<string, never>) => void;

  /** Announce this client's Cloudflare SFU session to the room. */
  'meet:sfu:publish': (p: { sessionId: string }) => void;

  /** Share a note with the room, or take it back. */
  'meet:note_share': (p: { note: MeetNote; shared: boolean }) => void;

  /* Mesh signalling */
  'meet:mesh:offer': (p: { to: string; sdp: string }) => void;
  'meet:mesh:answer': (p: { to: string; sdp: string }) => void;
  'meet:mesh:ice': (p: { to: string; candidate: unknown }) => void;
  'meet:mesh:renegotiate': (p: { to: string }) => void;
}

/** Server-side per-socket state for a meeting connection. */
export interface MeetSocketData {
  meetingId?: string;
  participantId?: string;
  role?: MeetRole;
  state?: ParticipantState;
  breakoutRoomId?: string | null;
}

export type { MeetActionItem, MeetDecision, MeetChapter, MeetNote };
