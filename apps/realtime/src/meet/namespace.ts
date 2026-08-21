import type { Namespace, Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import {
  parseMeetSettings, severityFor, meetRoleAtLeast, MEET_REACTIONS,
  MAX_CONCURRENT_SHARES, AI_SUMMARY_INTERVAL_MS, AI_MIN_SEGMENTS_FOR_SUMMARY,
} from '@tupo/shared';
import type {
  ConnectionQuality, HostCommand, MeetChatMessage, MeetLayout, MeetParticipant,
  MeetPoll, MeetQuestion, MeetRole, MeetSettings, MeetTranscriptSegment,
  SessionClaims, VideoQuality,
} from '@tupo/shared';
import { config } from '../config.js';
import * as db from './db.js';
import { MeetRoom, canHost, getRoom, dropRoomIfEmpty, roomKey, rooms } from './state.js';
import type { LiveParticipant } from './state.js';

/**
 * The `/meet` namespace.
 *
 * This owns *application* state for a meeting: the roster, the lobby, host
 * commands, the hand-raise queue, chat, captions, polls, Q&A, breakouts — and,
 * on the mesh transport, relaying SDP and ICE between peers.
 *
 * It does NOT own media. On the SFU transport Cloudflare carries the tracks; on
 * mesh the browsers talk directly. That separation (SRS §10.1) is why
 * restarting this process interrupts nobody's video.
 *
 * Authorization is not inherited from the API. The handshake verifies the same
 * session JWT, and `meet:join` then verifies that the `participantId` the
 * client claims actually belongs to that user in that meeting — otherwise
 * knowing a meeting id would be enough to sit in someone else's lesson.
 */

type MeetSocket = Socket & {
  data: {
    user: SessionClaims;
    meetingId?: string;
    participantId?: string;
    role?: MeetRole;
    /** Set when this socket authenticated with a guest ticket. */
    guest?: { participantId: string; meetingId: string };
    /** Set while the participant is inside a breakout, so main-room traffic
     *  does not leak into a small-group discussion. */
    breakoutRoomId?: string | null;
    layout?: MeetLayout;
  };
};

/** Speaking time is flushed to the database on this cadence, not per event. */
const SPEAKING_FLUSH_MS = 30_000;
/** Interim captions are dropped above this rate per participant. */
const CAPTION_MIN_INTERVAL_MS = 250;

export function registerMeetNamespace(io: Server): Namespace {
  const nsp = io.of('/meet');

  /* ---------------- handshake ---------------- */

  nsp.use((socket, next) => {
    const token =
      (socket.handshake.auth as { token?: string })?.token ??
      socket.handshake.headers.authorization?.replace(/^Bearer /, '');
    if (!token) return next(new Error('unauthorized: no session token'));
    try {
      const claims = jwt.verify(token, config.jwtSecret) as SessionClaims & {
        guest?: true; participantId?: string; meetingId?: string; name?: string;
      };

      // A guest holds a ticket bound to one participant row in one meeting, not
      // an identity. It is given a synthetic id so the rest of the namespace —
      // which only ever uses `user.id` for event attribution — works unchanged,
      // and `meet:join` below still verifies the binding against the database.
      if (claims.guest === true) {
        if (!claims.participantId || !claims.meetingId) {
          return next(new Error('unauthorized: malformed guest ticket'));
        }
        socket.data.user = {
          id: `guest:${claims.participantId}`,
          misUserId: `guest:${claims.participantId}`,
          name: claims.name ?? 'Guest',
          email: '',
          role: 'unassigned',
        } as SessionClaims;
        socket.data.guest = {
          participantId: claims.participantId,
          meetingId: claims.meetingId,
        };
      } else {
        socket.data.user = claims;
      }
      next();
    } catch {
      next(new Error('unauthorized: invalid or expired session token'));
    }
  });

  /* ---------------- helpers ---------------- */

  const emitToRoom = (meetingId: string, event: string, payload: unknown) =>
    nsp.to(roomKey(meetingId)).emit(event, payload);

  const emitToHosts = (room: MeetRoom, event: string, payload: unknown) => {
    for (const host of room.hosts()) {
      for (const sid of host.socketIds) nsp.to(sid).emit(event, payload);
    }
  };

  const emitToParticipant = (room: MeetRoom, participantId: string, event: string, payload: unknown) => {
    const p = room.find(participantId);
    if (!p) return;
    for (const sid of p.socketIds) nsp.to(sid).emit(event, payload);
  };

  const broadcastUpdate = (
    meetingId: string, participantId: string, changes: Partial<MeetParticipant>,
  ) => emitToRoom(meetingId, 'meet:participant_updated', { participantId, changes });

  const toLive = (r: db.ParticipantRecord, socketId: string): LiveParticipant => ({
    id: r.id,
    userId: r.user_id,
    name: r.display_name,
    avatarUrl: r.avatar_url,
    role: r.role as MeetRole,
    state: r.state as MeetParticipant['state'],
    isGuest: r.is_guest,
    audioEnabled: r.audio_enabled,
    videoEnabled: r.video_enabled,
    screenSharing: r.screen_sharing,
    handRaised: !!r.hand_raised_at,
    handRaisedAt: r.hand_raised_at ? r.hand_raised_at.toISOString() : null,
    speaking: false,
    connectionQuality: (r.connection_quality as ConnectionQuality) ?? 'good',
    joinedAt: (r.joined_at ?? new Date()).toISOString(),
    sfuSessionId: r.sfu_session_id,
    socketIds: new Set([socketId]),
    lastSpokeAt: 0,
    speakingMs: 0,
    speakingSince: null,
    breakoutRoomId: null,
  });

  /** Seconds since the meeting started, for transcript offsets and chapters. */
  const offsetSeconds = (room: MeetRoom): number | null =>
    room.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(room.startedAt)) / 1000)) : null;

  /**
   * Poll rows carry a raw vote tally; the wire shape carries per-option counts.
   * Folding happens here so the client never has to know how votes are stored.
   */
  const toWirePoll = (row: Record<string, unknown>): MeetPoll => {
    const options = (row.options as string[]) ?? [];
    const tally = (row.tally as number[][] | null) ?? [];
    const counts = options.map(() => 0);
    for (const vote of tally) {
      for (const idx of vote) if (counts[idx] !== undefined) counts[idx]! += 1;
    }
    return {
      id: String(row.id),
      meetingId: String(row.meeting_id),
      kind: (row.kind as 'poll' | 'quiz') ?? 'poll',
      question: String(row.question),
      options: options.map((text, index) => ({ index, text, votes: counts[index] ?? 0 })),
      correctOptionIndex: (row.correct_option_index as number | null) ?? null,
      anonymous: !!row.anonymous,
      multipleChoice: !!row.multiple_choice,
      status: (row.status as 'open' | 'closed') ?? 'open',
      totalVotes: tally.length,
      myVote: (row.my_vote as number[] | null) ?? null,
      createdAt: new Date(row.created_at as string).toISOString(),
    };
  };

  const toWireQuestion = (row: Record<string, unknown>): MeetQuestion => ({
    id: String(row.id),
    meetingId: String(row.meeting_id),
    participantId: String(row.participant_id),
    askedBy: String(row.asked_by),
    text: String(row.text),
    upvotes: Number(row.upvotes ?? 0),
    answered: !!row.answered,
    answerText: (row.answer_text as string | null) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
  });

  /* ---------------- connection ---------------- */

  nsp.on('connection', (raw) => {
    const socket = raw as MeetSocket;
    const user = socket.data.user;

    /* -------- join -------- */

    socket.on('meet:join', async (payload: { meetingId?: string; participantId?: string }, ack) => {
      const reply = (ok: boolean, message?: string) => {
        if (typeof ack === 'function') ack({ ok, ...(message ? { message } : {}) });
      };

      const meetingId = String(payload?.meetingId ?? '');
      const participantId = String(payload?.participantId ?? '');
      if (!meetingId || !participantId) return reply(false, 'meetingId and participantId are required.');

      const meeting = await db.loadMeeting(meetingId);
      if (!meeting) return reply(false, 'Meeting not found.');
      if (meeting.status === 'ended' || meeting.status === 'cancelled') {
        return reply(false, 'This meeting has ended.');
      }

      // The authorization boundary. For a signed-in user the row must be theirs;
      // for a guest the ticket must name this exact row in this exact meeting,
      // so a guest cannot hop into another participant — or another meeting —
      // by editing the payload.
      const guest = socket.data.guest;
      const record = guest
        ? (guest.meetingId === meetingId && guest.participantId === participantId
            ? await db.loadGuestParticipant(meetingId, participantId)
            : null)
        : await db.loadParticipant(meetingId, participantId, user.id);
      if (!record) return reply(false, 'You are not a participant in this meeting.');

      const settings = parseMeetSettings(meeting.settings);
      const room = getRoom(meetingId);
      room.startedAt ??= meeting.started_at ? meeting.started_at.toISOString() : null;
      // First socket into a room seeds the live settings from the row; later
      // joiners must not clobber a change a host has since made in-meeting.
      if (room.isEmpty) {
        room.settings = settings;
        room.transcribing = settings.transcriptionEnabled;
        room.aiPresent = settings.aiAssistantEnabled;
      }

      socket.data.meetingId = meetingId;
      socket.data.participantId = participantId;
      socket.data.role = record.role as MeetRole;
      socket.data.breakoutRoomId = null;
      await socket.join(roomKey(meetingId));

      // A second tab is another socket for the same participant, not a second
      // participant — otherwise a reload shows the room a phantom attendee.
      const existing = room.find(participantId);
      let participant: LiveParticipant;
      if (existing) {
        existing.socketIds.add(socket.id);
        existing.state = record.state as MeetParticipant['state'];
        participant = existing;
      } else {
        participant = toLive(record, socket.id);
        if (participant.state === 'knocking' || participant.state === 'lobby') {
          room.waiting.set(participantId, participant);
        } else {
          room.participants.set(participantId, participant);
        }
      }

      // Full state once, deltas thereafter.
      const [chat, polls, questions, breakouts] = await Promise.all([
        db.recentChat(meetingId, participantId),
        db.loadPolls(meetingId, participantId),
        db.loadQuestions(meetingId),
        db.loadBreakouts(meetingId),
      ]);

      socket.emit('meet:state', {
        meetingId,
        transport: meeting.transport ?? 'mesh',
        you: stripLive(participant),
        participants: room.roster(),
        // Only a host has any business seeing who is waiting outside.
        lobby: canHost(participant.role) ? room.lobby() : [],
        settings,
        chat: chat.map(toWireChat),
        polls: polls.map(toWirePoll),
        questions: questions.map(toWireQuestion),
        breakouts: breakouts.map((b) => ({
          id: String(b.id), meetingId, name: String(b.name),
          participantIds: (b.participant_ids as string[]) ?? [],
          status: b.status as 'open' | 'closed',
          closesAt: b.closes_at ? new Date(b.closes_at as string).toISOString() : null,
        })),
        recording: room.recording,
        transcribing: room.transcribing,
        aiPresent: room.aiPresent,
        spotlightId: room.spotlightId,
        startedAt: room.startedAt,
        serverTime: new Date().toISOString(),
      });

      if (participant.state === 'knocking' || participant.state === 'lobby') {
        emitToHosts(room, 'meet:lobby_knock', { participant: stripLive(participant) });
        db.logEvent(meetingId, 'participant.knocked', severityFor('participant.knocked'),
          { participantId, actorId: user.id });
        return reply(true);
      }

      if (!existing) {
        socket.to(roomKey(meetingId)).emit('meet:participant_joined', {
          participant: stripLive(participant),
        });
        // Mesh needs a deterministic offerer, or two peers both offer and
        // glare. The existing participant offers to the newcomer.
        if ((meeting.transport ?? 'mesh') === 'mesh') {
          for (const peer of room.participants.values()) {
            if (peer.id === participantId) continue;
            for (const sid of peer.socketIds) {
              nsp.to(sid).emit('meet:mesh:peer_joined', {
                participantId, shouldOffer: true,
              });
            }
          }
          socket.emit('meet:mesh:peer_joined', {
            participantId: '', shouldOffer: false,
          });
        }
        db.logEvent(meetingId, 'participant.joined', severityFor('participant.joined'),
          { participantId, actorId: user.id });
      }

      if (meeting.status === 'scheduled' && canHost(participant.role)) {
        db.startMeeting(meetingId);
        room.startedAt ??= new Date().toISOString();
      }

      reply(true);
    });

    /* -------- media state -------- */

    socket.on('meet:media_state', (p: {
      audioEnabled?: boolean; videoEnabled?: boolean; screenSharing?: boolean;
      screenStreamId?: string | null;
    }) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { room, participant, meetingId } = ctx;

      // Two shares at once is the cap (FR-MEET-7); a third is refused here
      // rather than allowed to fight for the stage.
      if (p.screenSharing === true && !room.canShare(participant.id)) {
        socket.emit('meet:error', {
          code: 'share_limit',
          message: `At most ${MAX_CONCURRENT_SHARES} people can share at once.`,
        });
        return;
      }

      const changes: Partial<MeetParticipant> = {};
      if (typeof p.audioEnabled === 'boolean') { participant.audioEnabled = p.audioEnabled; changes.audioEnabled = p.audioEnabled; }
      if (typeof p.videoEnabled === 'boolean') { participant.videoEnabled = p.videoEnabled; changes.videoEnabled = p.videoEnabled; }
      if (typeof p.screenSharing === 'boolean') {
        participant.screenSharing = p.screenSharing;
        changes.screenSharing = p.screenSharing;
        // The stream id travels with the flag so a peer can bind the incoming
        // track to the right tile instead of inferring it from track order.
        participant.screenStreamId = p.screenSharing ? (p.screenStreamId ?? null) : null;
        changes.screenStreamId = participant.screenStreamId;
      }
      if (!Object.keys(changes).length) return;

      db.setMediaState(participant.id, p);
      broadcastUpdate(meetingId, participant.id, changes);

      if (typeof p.screenSharing === 'boolean') {
        db.logEvent(meetingId, p.screenSharing ? 'share.started' : 'share.stopped',
          severityFor(p.screenSharing ? 'share.started' : 'share.stopped'),
          { participantId: participant.id, actorId: user.id });
        // A dedicated event, not just a roster delta: every client switches to
        // the presentation layout on this, and a delta is easy to miss.
        emitToRoom(meetingId, 'meet:presenting', {
          participantId: participant.id,
          name: participant.name,
          presenting: p.screenSharing,
          screenStreamId: participant.screenStreamId ?? null,
        });
      }
      if (typeof p.audioEnabled === 'boolean') {
        db.logEvent(meetingId, p.audioEnabled ? 'media.unmuted' : 'media.muted', 'info',
          { participantId: participant.id, actorId: user.id });
      }
    });

    /**
     * Voice activity, computed in the browser from the local audio track.
     *
     * Deliberately client-side: the alternative is analysing every audio stream
     * server-side, which on the SFU transport means decoding media the server
     * is otherwise only forwarding. A client that lies about speaking gains
     * nothing but a highlighted tile.
     */
    socket.on('meet:speaking_state', (p: { speaking?: boolean }) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { room, participant, meetingId } = ctx;
      const speaking = !!p?.speaking;
      if (participant.speaking === speaking) return;

      room.markSpeaking(participant.id, speaking);
      emitToRoom(meetingId, 'meet:speaking', {
        speaking: [...room.participants.values()].filter((x) => x.speaking).map((x) => x.id),
      });
      if (speaking && room.activeSpeakerId !== participant.id) {
        emitToRoom(meetingId, 'meet:active_speaker', {
          participantId: participant.id, at: new Date().toISOString(),
        });
      }
    });

    /* -------- hand & reactions -------- */

    socket.on('meet:hand', (p: { raised?: boolean }) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { room, participant, meetingId } = ctx;
      const raised = !!p?.raised;
      const at = new Date();

      participant.handRaised = raised;
      participant.handRaisedAt = raised ? at.toISOString() : null;
      db.setHand(participant.id, raised, at);

      emitToRoom(meetingId, 'meet:hand', {
        participantId: participant.id,
        raised,
        at: at.toISOString(),
        queuePosition: raised ? room.handPosition(participant.id) : 0,
      });
      db.logEvent(meetingId, raised ? 'hand.raised' : 'hand.lowered', 'info',
        { participantId: participant.id, actorId: user.id });
    });

    /** Reactions are never persisted — they are a gesture, not a record. */
    socket.on('meet:reaction', (p: { reaction?: string }) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { room, participant, meetingId } = ctx;
      if (!room.settings.allowReactions) return;
      const reaction = String(p?.reaction ?? '');
      if (!MEET_REACTIONS.includes(reaction as never)) return;

      emitToRoom(meetingId, 'meet:reaction', {
        participantId: participant.id,
        name: participant.name,
        reaction,
        at: new Date().toISOString(),
      });
    });

    /* -------- chat -------- */

    socket.on('meet:chat', async (p: { body?: string; toParticipantId?: string }, ack) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { room, participant, meetingId } = ctx;

      if (!room.settings.allowChat && !canHost(participant.role)) {
        socket.emit('meet:error', { code: 'chat_disabled', message: 'Chat is disabled by the host.' });
        return;
      }
      const body = String(p?.body ?? '').trim().slice(0, 4000);
      if (!body) return;

      try {
        const saved = await db.insertChat({
          meetingId,
          participantId: participant.id,
          senderName: participant.name,
          body,
          toParticipantId: p?.toParticipantId ?? null,
        });
        const message: MeetChatMessage = {
          id: saved.id, meetingId, participantId: participant.id,
          senderName: participant.name, body,
          toParticipantId: p?.toParticipantId ?? null,
          createdAt: saved.createdAt,
        };

        if (p?.toParticipantId) {
          // A private message goes to exactly two people. Emitting it to the
          // room and hiding it client-side would put it in everyone's devtools.
          emitToParticipant(room, p.toParticipantId, 'meet:chat', { message });
          socket.emit('meet:chat', { message });
        } else {
          emitToRoom(meetingId, 'meet:chat', { message });
        }
        if (typeof ack === 'function') ack({ ok: true });
      } catch {
        if (typeof ack === 'function') ack({ ok: false });
      }
    });

    /* -------- captions -------- */

    /**
     * A caption segment from this participant's own microphone.
     *
     * This is the whole speech-to-text pipeline: the browser's own
     * `SpeechRecognition` runs on the local mic and ships *text*. Speaker
     * attribution is therefore structural — the segment arrives on the socket
     * of the person who said it — and a caption costs eighty bytes rather than
     * an audio stream and a per-minute STT bill.
     */
    socket.on('meet:caption', async (p: {
      text?: string; lang?: string; isFinal?: boolean; confidence?: number;
    }) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { room, participant, meetingId } = ctx;
      if (!room.transcribing) return;

      const text = String(p?.text ?? '').trim().slice(0, 2000);
      if (!text) return;

      const isFinal = p?.isFinal !== false;
      const now = Date.now();
      // Interim results arrive on every syllable. Throttling them keeps the
      // caption bar readable and the socket quiet; final results always pass.
      if (!isFinal) {
        if (now - participant.lastSpokeAt < CAPTION_MIN_INTERVAL_MS) return;
        participant.lastSpokeAt = now;
      }

      const segment: MeetTranscriptSegment = {
        id: 'interim',
        meetingId,
        participantId: participant.id,
        speakerName: participant.name,
        text,
        lang: String(p?.lang ?? room.settings.primaryLanguage),
        isFinal,
        confidence: typeof p?.confidence === 'number' ? p.confidence : undefined,
        startedAt: new Date().toISOString(),
      };

      // Interim segments are shown and thrown away; only final ones are stored,
      // because a model fed half-formed guesses summarises sentences nobody said.
      if (isFinal) {
        try {
          const saved = await db.insertTranscript({
            meetingId,
            participantId: participant.id,
            speakerName: participant.name,
            text,
            lang: segment.lang,
            isFinal: true,
            confidence: segment.confidence,
            offsetSeconds: offsetSeconds(room),
          });
          segment.id = saved.id;
          segment.startedAt = saved.startedAt;
        } catch {
          // Fan the caption out anyway — a lost row is better than a lost caption.
        }
      }

      emitToRoom(meetingId, 'meet:caption', { segment });
      if (isFinal && room.aiPresent) void maybeRollingSummary(room);
    });

    /* -------- host commands -------- */

    socket.on('meet:host_command', async (command: HostCommand, ack) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { room, participant, meetingId } = ctx;
      const reply = (ok: boolean, message?: string) => {
        if (typeof ack === 'function') ack({ ok, ...(message ? { message } : {}) });
      };

      if (!canHost(participant.role)) return reply(false, 'Only the host or a co-host can do that.');
      const target = command.targetId ? room.find(command.targetId) : undefined;

      // A co-host must not be able to remove or demote the host — otherwise
      // promoting someone hands them the room.
      const outranksTarget = target
        ? participant.role === 'host' || !meetRoleAtLeast(target.role, 'host')
        : true;

      switch (command.action) {
        case 'mute':
          if (!target) return reply(false, 'No such participant.');
          if (!outranksTarget) return reply(false, 'You cannot mute the host.');
          target.audioEnabled = false;
          db.setMediaState(target.id, { audioEnabled: false });
          emitToParticipant(room, target.id, 'meet:force_mute',
            { by: participant.id, byName: participant.name });
          broadcastUpdate(meetingId, target.id, { audioEnabled: false });
          break;

        case 'mute_all':
          for (const p of room.participants.values()) {
            // Muting everyone must not mute the person who pressed it, nor the
            // other hosts running the session.
            if (canHost(p.role)) continue;
            p.audioEnabled = false;
            db.setMediaState(p.id, { audioEnabled: false });
            emitToParticipant(room, p.id, 'meet:force_mute',
              { by: participant.id, byName: participant.name });
            broadcastUpdate(meetingId, p.id, { audioEnabled: false });
          }
          break;

        case 'unmute_request':
          if (!target) return reply(false, 'No such participant.');
          // A request, never a command: a host cannot switch on someone's
          // microphone remotely, and should not be able to.
          emitToParticipant(room, target.id, 'meet:unmute_requested',
            { by: participant.id, byName: participant.name });
          break;

        case 'camera_off':
          if (!target) return reply(false, 'No such participant.');
          if (!outranksTarget) return reply(false, 'You cannot do that to the host.');
          target.videoEnabled = false;
          db.setMediaState(target.id, { videoEnabled: false });
          emitToParticipant(room, target.id, 'meet:force_camera_off',
            { by: participant.id, byName: participant.name });
          broadcastUpdate(meetingId, target.id, { videoEnabled: false });
          break;

        case 'remove': {
          if (!target) return reply(false, 'No such participant.');
          if (!outranksTarget) return reply(false, 'You cannot remove the host.');
          emitToParticipant(room, target.id, 'meet:removed',
            { by: participant.id, reason: command.reason });
          for (const sid of target.socketIds) nsp.sockets.get(sid)?.disconnect(true);
          room.participants.delete(target.id);
          room.waiting.delete(target.id);
          db.closeParticipant(target.id, 'removed');
          db.logEvent(meetingId, 'participant.removed', severityFor('participant.removed'),
            { participantId: target.id, actorId: user.id, payload: { reason: command.reason } });
          emitToRoom(meetingId, 'meet:participant_left', { participantId: target.id, reason: 'removed' });
          break;
        }

        case 'promote':
        case 'demote': {
          if (!target) return reply(false, 'No such participant.');
          if (target.role === 'host') return reply(false, 'The host cannot be demoted.');
          const role: MeetRole = command.action === 'promote' ? 'cohost' : 'attendee';
          target.role = role;
          db.setRole(target.id, role);
          emitToRoom(meetingId, 'meet:role_changed', { participantId: target.id, role });
          broadcastUpdate(meetingId, target.id, { role });
          db.logEvent(meetingId,
            command.action === 'promote' ? 'participant.promoted' : 'participant.demoted',
            'info', { participantId: target.id, actorId: user.id });
          break;
        }

        case 'admit':
        case 'deny': {
          const waiting = command.targetId ? room.waiting.get(command.targetId) : undefined;
          if (!waiting) return reply(false, 'Nobody is waiting under that id.');
          resolveLobby(room, waiting, command.action === 'admit', participant);
          break;
        }

        case 'admit_all':
          for (const waiting of [...room.waiting.values()]) {
            resolveLobby(room, waiting, true, participant);
          }
          break;

        case 'lock':
        case 'unlock': {
          const locked = command.action === 'lock';
          room.settings = { ...room.settings, locked };
          db.setMeetingSettings(meetingId, room.settings);
          emitToRoom(meetingId, 'meet:locked', { locked, by: participant.id });
          db.logEvent(meetingId, locked ? 'meeting.locked' : 'meeting.unlocked',
            severityFor(locked ? 'meeting.locked' : 'meeting.unlocked'), { actorId: user.id });
          break;
        }

        case 'spotlight':
        case 'unspotlight':
          room.spotlightId = command.action === 'spotlight' ? (command.targetId ?? null) : null;
          emitToRoom(meetingId, 'meet:spotlight',
            { participantId: room.spotlightId, by: participant.id });
          break;

        case 'disable_chat':
        case 'enable_chat':
          room.settings = { ...room.settings, allowChat: command.action === 'enable_chat' };
          db.setMeetingSettings(meetingId, room.settings);
          emitToRoom(meetingId, 'meet:settings_updated',
            { settings: room.settings, by: participant.id });
          break;

        case 'disable_share':
        case 'enable_share':
          room.settings = { ...room.settings, allowScreenShare: command.action === 'enable_share' };
          db.setMeetingSettings(meetingId, room.settings);
          emitToRoom(meetingId, 'meet:settings_updated',
            { settings: room.settings, by: participant.id });
          break;

        case 'end': {
          if (participant.role !== 'host') {
            return reply(false, 'Only the host can end the meeting for everyone.');
          }
          await db.endMeeting(meetingId);
          db.addSpeakingSeconds(room.drainSpeakingSeconds());
          emitToRoom(meetingId, 'meet:ended', {
            by: participant.id,
            at: new Date().toISOString(),
            summaryUrl: `/app/meet/${meetingId}/summary`,
          });
          db.logEvent(meetingId, 'meeting.ended', severityFor('meeting.ended'), { actorId: user.id });
          rooms.delete(meetingId);
          break;
        }

        default:
          return reply(false, 'Unknown command.');
      }

      emitToRoom(meetingId, 'meet:host_command',
        { command, by: participant.id, byName: participant.name });
      reply(true);
    });

    /* -------- settings -------- */

    socket.on('meet:settings', (patch: Partial<MeetSettings>, ack) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { room, participant, meetingId } = ctx;
      if (!canHost(participant.role)) {
        if (typeof ack === 'function') ack({ ok: false, message: 'Only the host can change settings.' });
        return;
      }

      const before = room.settings;
      room.settings = parseMeetSettings({ ...room.settings, ...patch });
      db.setMeetingSettings(meetingId, room.settings);

      // Transcription and the AI notetaker are the two settings people must be
      // told about, not merely have applied to them.
      if (before.transcriptionEnabled !== room.settings.transcriptionEnabled) {
        room.transcribing = room.settings.transcriptionEnabled;
        emitToRoom(meetingId, 'meet:transcribing',
          { active: room.transcribing, by: participant.name });
        db.logEvent(meetingId,
          room.transcribing ? 'transcription.started' : 'transcription.stopped',
          severityFor('transcription.started'), { actorId: user.id });
      }
      if (before.aiAssistantEnabled !== room.settings.aiAssistantEnabled) {
        room.aiPresent = room.settings.aiAssistantEnabled;
        emitToRoom(meetingId, 'meet:ai_presence',
          { present: room.aiPresent, by: participant.id, byName: participant.name });
        db.logEvent(meetingId, room.aiPresent ? 'ai.invited' : 'ai.dismissed',
          severityFor('ai.invited'), { actorId: user.id });
      }

      emitToRoom(meetingId, 'meet:settings_updated', { settings: room.settings, by: participant.id });
      if (typeof ack === 'function') ack({ ok: true });
    });

    /* -------- recording -------- */

    socket.on('meet:recording', (p: { active?: boolean }) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { room, participant, meetingId } = ctx;
      if (!canHost(participant.role)) return;

      room.recording = !!p?.active;
      // The indicator is not optional and not dismissible: everyone in the room
      // is told, every time, for as long as it runs (FR-MEET-12).
      emitToRoom(meetingId, 'meet:recording', {
        active: room.recording,
        by: participant.name,
        startedAt: room.recording ? new Date().toISOString() : null,
      });
      db.logEvent(meetingId, room.recording ? 'recording.started' : 'recording.stopped',
        severityFor('recording.started'), { actorId: user.id });
    });

    /* -------- polls -------- */

    socket.on('meet:poll_create', async (p: {
      question?: string; options?: string[]; kind?: 'poll' | 'quiz';
      correctOptionIndex?: number; anonymous?: boolean; multipleChoice?: boolean;
    }, ack) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { room, participant, meetingId } = ctx;
      if (!canHost(participant.role)) {
        if (typeof ack === 'function') ack({ ok: false });
        return;
      }
      const question = String(p?.question ?? '').trim().slice(0, 500);
      const options = (p?.options ?? []).map((o) => String(o).trim().slice(0, 200)).filter(Boolean);
      if (!question || options.length < 2) {
        if (typeof ack === 'function') ack({ ok: false });
        return;
      }

      const saved = await db.insertPoll({
        meetingId, participantId: participant.id,
        kind: p?.kind === 'quiz' ? 'quiz' : 'poll',
        question, options,
        correctOptionIndex: p?.correctOptionIndex ?? null,
        anonymous: !!p?.anonymous,
        multipleChoice: !!p?.multipleChoice,
      });

      const poll: MeetPoll = {
        id: saved.id, meetingId, kind: p?.kind === 'quiz' ? 'quiz' : 'poll',
        question,
        options: options.map((text, index) => ({ index, text, votes: 0 })),
        // A quiz's right answer stays server-side until the poll closes —
        // shipping it with the question would put it in the page source.
        correctOptionIndex: null,
        anonymous: !!p?.anonymous,
        multipleChoice: !!p?.multipleChoice,
        status: 'open', totalVotes: 0, myVote: null, createdAt: saved.createdAt,
      };
      emitToRoom(meetingId, 'meet:poll', { poll });
      db.logEvent(meetingId, 'poll.opened', 'info', { participantId: participant.id, actorId: user.id });
      if (typeof ack === 'function') ack({ ok: true, pollId: saved.id });
    });

    socket.on('meet:poll_vote', async (p: { pollId?: string; optionIndexes?: number[] }, ack) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { participant, meetingId } = ctx;
      const pollId = String(p?.pollId ?? '');
      const indexes = (p?.optionIndexes ?? []).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
      if (!pollId || !indexes.length) {
        if (typeof ack === 'function') ack({ ok: false });
        return;
      }
      try {
        await db.castVote(pollId, participant.id, indexes);
        const row = await db.pollWithTally(pollId, participant.id);
        if (row) emitToRoom(meetingId, 'meet:poll', { poll: toWirePoll(row) });
        if (typeof ack === 'function') ack({ ok: true });
      } catch {
        if (typeof ack === 'function') ack({ ok: false });
      }
    });

    socket.on('meet:poll_close', async (p: { pollId?: string }) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { participant, meetingId } = ctx;
      if (!canHost(participant.role)) return;
      const pollId = String(p?.pollId ?? '');
      if (!pollId) return;

      await db.closePoll(pollId);
      const row = await db.pollWithTally(pollId, participant.id);
      if (row) {
        const poll = toWirePoll(row);
        // Now the answer can go out: the poll is closed, so knowing it changes
        // nothing.
        poll.correctOptionIndex = (row.correct_option_index as number | null) ?? null;
        poll.status = 'closed';
        emitToRoom(meetingId, 'meet:poll_closed', { poll });
      }
      db.logEvent(meetingId, 'poll.closed', 'info', { actorId: user.id });
    });

    /* -------- Q&A -------- */

    socket.on('meet:question_ask', async (p: { text?: string }, ack) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { participant, meetingId } = ctx;
      const text = String(p?.text ?? '').trim().slice(0, 1000);
      if (!text) {
        if (typeof ack === 'function') ack({ ok: false });
        return;
      }
      const saved = await db.insertQuestion({
        meetingId, participantId: participant.id, askedBy: participant.name, text,
      });
      emitToRoom(meetingId, 'meet:question', {
        question: {
          id: saved.id, meetingId, participantId: participant.id,
          askedBy: participant.name, text, upvotes: 0, answered: false,
          answerText: null, createdAt: saved.createdAt,
        } satisfies MeetQuestion,
      });
      if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('meet:question_upvote', async (p: { questionId?: string }) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { participant, meetingId } = ctx;
      const row = await db.upvoteQuestion(String(p?.questionId ?? ''), participant.id);
      // null means this participant had already upvoted — silently ignored, so
      // a double click is not an error the user has to see.
      if (row) emitToRoom(meetingId, 'meet:question_updated', { question: toWireQuestion(row) });
    });

    socket.on('meet:question_answer', async (p: { questionId?: string; answerText?: string }) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { participant, meetingId } = ctx;
      if (!canHost(participant.role)) return;
      const row = await db.answerQuestion(
        String(p?.questionId ?? ''), p?.answerText ? String(p.answerText).slice(0, 2000) : null);
      if (row) emitToRoom(meetingId, 'meet:question_updated', { question: toWireQuestion(row) });
    });

    /* -------- breakouts -------- */

    socket.on('meet:breakout_open', async (p: {
      rooms?: Array<{ name: string; participantIds: string[] }>;
      durationMinutes?: number; autoAssign?: boolean;
    }, ack) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { room, participant, meetingId } = ctx;
      if (!canHost(participant.role)) {
        if (typeof ack === 'function') ack({ ok: false });
        return;
      }

      let plan = (p?.rooms ?? []).map((r) => ({
        name: String(r.name).slice(0, 120),
        participantIds: (r.participantIds ?? []).map(String),
      }));
      if (!plan.length) {
        if (typeof ack === 'function') ack({ ok: false });
        return;
      }

      if (p?.autoAssign) {
        // Round-robin rather than chunking: chunking puts everyone who joined
        // early in room one, which in a class means the same group every time.
        const assignable = [...room.participants.values()].filter((x) => !canHost(x.role));
        plan = plan.map((r) => ({ ...r, participantIds: [] as string[] }));
        assignable.forEach((x, i) => plan[i % plan.length]!.participantIds.push(x.id));
      }

      const closesAt = p?.durationMinutes
        ? new Date(Date.now() + p.durationMinutes * 60_000) : null;

      try {
        const created = await db.createBreakouts(meetingId, plan, closesAt);
        const wire = created.map((r) => ({
          id: r.id, meetingId, name: r.name, participantIds: r.participantIds,
          status: 'open' as const, closesAt: closesAt ? closesAt.toISOString() : null,
        }));
        emitToRoom(meetingId, 'meet:breakouts', { rooms: wire });

        for (const r of created) {
          for (const pid of r.participantIds) {
            const member = room.participants.get(pid);
            if (!member) continue;
            member.breakoutRoomId = r.id;
            for (const sid of member.socketIds) {
              const s = nsp.sockets.get(sid) as MeetSocket | undefined;
              if (!s) continue;
              s.data.breakoutRoomId = r.id;
              void s.join(`meet:breakout:${r.id}`);
              s.emit('meet:breakout_assigned', {
                roomId: r.id, roomName: r.name,
                closesAt: closesAt ? closesAt.toISOString() : null,
              });
            }
          }
        }
        db.logEvent(meetingId, 'breakout.opened', 'info',
          { actorId: user.id, payload: { rooms: created.length } });
        if (typeof ack === 'function') ack({ ok: true });
      } catch {
        if (typeof ack === 'function') ack({ ok: false });
      }
    });

    socket.on('meet:breakout_close', async () => {
      const ctx = context(socket);
      if (!ctx) return;
      const { room, participant, meetingId } = ctx;
      if (!canHost(participant.role)) return;

      await db.closeBreakouts(meetingId);
      for (const member of room.participants.values()) {
        if (!member.breakoutRoomId) continue;
        const roomId = member.breakoutRoomId;
        member.breakoutRoomId = null;
        for (const sid of member.socketIds) {
          const s = nsp.sockets.get(sid) as MeetSocket | undefined;
          if (!s) continue;
          s.data.breakoutRoomId = null;
          void s.leave(`meet:breakout:${roomId}`);
        }
      }
      emitToRoom(meetingId, 'meet:breakouts', { rooms: [] });
      db.logEvent(meetingId, 'breakout.closed', 'info', { actorId: user.id });
    });

    /** Host broadcast into every breakout at once. */
    socket.on('meet:breakout_broadcast', (p: { body?: string }) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { participant, meetingId } = ctx;
      if (!canHost(participant.role)) return;
      const body = String(p?.body ?? '').trim().slice(0, 1000);
      if (!body) return;
      emitToRoom(meetingId, 'meet:breakout_broadcast', { body, from: participant.name });
    });

    /* -------- Cloudflare SFU -------- */

    /**
     * Announce this client's SFU session.
     *
     * Cloudflare's SFU has no rooms, so a subscriber has to be told which
     * session publishes whom. Track *names* are derived from the participant
     * id and need no exchange at all; this one identifier is the only thing
     * that does. It is persisted as well as broadcast, so someone joining late
     * learns about everyone already publishing in the same payload that
     * carries the roster.
     */
    socket.on('meet:sfu:publish', (p: { sessionId?: string }) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { participant, meetingId } = ctx;
      const sessionId = String(p?.sessionId ?? '').trim();
      // Cloudflare session ids are hex; anything else is not one, and this
      // value is handed to every other client to subscribe with.
      if (!/^[0-9a-f]{8,64}$/i.test(sessionId)) return;

      participant.sfuSessionId = sessionId;
      db.setSfuSession(participant.id, sessionId);
      emitToRoom(meetingId, 'meet:sfu:published', {
        participantId: participant.id, sessionId,
      });
      broadcastUpdate(meetingId, participant.id, { sfuSessionId: sessionId });
    });

    /* -------- notes -------- */

    /**
     * Share a note with the room, or take it back.
     *
     * Only shared notes ever cross the wire — a private note is never sent to
     * anyone, which is why the API filters in SQL rather than trusting this.
     */
    socket.on('meet:note_share', (p: { note?: unknown; shared?: boolean }) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { participant, meetingId } = ctx;
      const note = p?.note as { id?: string; participantId?: string } | undefined;
      if (!note?.id) return;
      // Only the author may share their own note.
      if (note.participantId !== participant.id) return;

      if (p?.shared) {
        socket.to(roomKey(meetingId)).emit('meet:note_shared', { note });
      } else {
        socket.to(roomKey(meetingId)).emit('meet:note_unshared', { noteId: note.id });
      }
    });

    /* -------- network stats & adaptive subscription -------- */

    socket.on('meet:stats', (p: { quality?: ConnectionQuality; packetLoss?: number }) => {
      const ctx = context(socket);
      if (!ctx) return;
      const { participant, meetingId } = ctx;
      const quality = p?.quality;
      if (!quality || participant.connectionQuality === quality) return;

      const previous = participant.connectionQuality;
      participant.connectionQuality = quality;
      db.setQuality(participant.id, quality);
      broadcastUpdate(meetingId, participant.id, { connectionQuality: quality });

      // Logged with severity so the host console can surface a struggling
      // participant the same way the proctoring dashboard surfaces an event.
      if (quality === 'poor' || quality === 'lost') {
        db.logEvent(meetingId, quality === 'lost' ? 'network.dropped' : 'network.degraded',
          severityFor(quality === 'lost' ? 'network.dropped' : 'network.degraded'),
          { participantId: participant.id, payload: { packetLoss: p?.packetLoss } });
        socket.emit('meet:quality_advice', {
          quality: (quality === 'lost' ? 'off' : 'low') satisfies VideoQuality,
          reason: quality === 'lost'
            ? 'Your connection dropped. Video is off until it recovers.'
            : 'Your connection is struggling. Lowering video quality.',
        });
      } else if (previous === 'poor' || previous === 'lost') {
        db.logEvent(meetingId, 'network.recovered', severityFor('network.recovered'),
          { participantId: participant.id });
        socket.emit('meet:quality_advice',
          { quality: 'high' satisfies VideoQuality, reason: 'Connection recovered.' });
      }
    });

    /**
     * Which tiles this client actually has on screen, and how large.
     *
     * On the SFU this drives per-subscriber layer selection; on mesh it drives
     * the receiver's layer preference. Either way it is the single biggest
     * downlink saving available — a 160px thumbnail has no use for 720p, and an
     * off-screen tile has no use for any video at all.
     */
    socket.on('meet:subscriptions', (p: {
      visible?: Array<{ participantId: string; quality: VideoQuality }>;
    }) => {
      const ctx = context(socket);
      if (!ctx) return;
      // Recorded on the socket rather than acted on here: on both transports
      // the actual subscription change is made by the client against its own
      // peer connection. The server keeps it so the host console can show who
      // is watching whom, and so a future server-side SFU policy has the data.
      socket.data.layout = socket.data.layout ?? 'grid';
      (socket.data as Record<string, unknown>).visible = p?.visible ?? [];
    });

    socket.on('meet:layout', (p: { layout?: MeetLayout }) => {
      if (p?.layout) socket.data.layout = p.layout;
    });

    /* -------- mesh signalling -------- *
     * The proctoring module's handshake, renamed. The server never sees media —
     * it relays SDP and ICE and nothing else, and each relay is addressed to a
     * participant in the same meeting, so a socket cannot signal into a room it
     * is not in. */

    const relay = (event: 'offer' | 'answer' | 'ice' | 'renegotiate') =>
      (p: { to?: string; sdp?: string; candidate?: unknown }) => {
        const ctx = context(socket);
        if (!ctx) return;
        const { room, participant } = ctx;
        const target = room.find(String(p?.to ?? ''));
        if (!target) return;
        for (const sid of target.socketIds) {
          nsp.to(sid).emit(`meet:mesh:${event}`, {
            from: participant.id,
            ...(p?.sdp ? { sdp: p.sdp } : {}),
            ...(p?.candidate ? { candidate: p.candidate } : {}),
          });
        }
      };

    socket.on('meet:mesh:offer', relay('offer'));
    socket.on('meet:mesh:answer', relay('answer'));
    socket.on('meet:mesh:ice', relay('ice'));
    socket.on('meet:mesh:renegotiate', relay('renegotiate'));

    /* -------- leaving -------- */

    socket.on('meet:leave', () => { void departure(socket, 'left'); });
    socket.on('disconnect', () => { void departure(socket, 'disconnected'); });
  });

  /* ---------------- shared helpers over the namespace ---------------- */

  function context(socket: MeetSocket): {
    room: MeetRoom;
    participant: LiveParticipant;
    meetingId: string;
  } | null {
    const { meetingId, participantId } = socket.data;
    if (!meetingId || !participantId) return null;
    const room = rooms.get(meetingId);
    if (!room) return null;
    const participant = room.find(participantId);
    if (!participant) return null;
    return { room, participant, meetingId };
  }

  function resolveLobby(
    room: MeetRoom, waiting: LiveParticipant, admitted: boolean, by: LiveParticipant,
  ): void {
    room.waiting.delete(waiting.id);

    if (admitted) {
      waiting.state = 'active';
      room.participants.set(waiting.id, waiting);
      db.admit(waiting.id, by.userId);
      for (const sid of waiting.socketIds) {
        nsp.to(sid).emit('meet:admitted', { participantId: waiting.id });
      }
      emitToRoom(room.meetingId, 'meet:participant_joined',
        { participant: stripLive(waiting) });
      // The newcomer needs peers to offer to them, exactly as on a direct join.
      for (const peer of room.participants.values()) {
        if (peer.id === waiting.id) continue;
        for (const sid of peer.socketIds) {
          nsp.to(sid).emit('meet:mesh:peer_joined', { participantId: waiting.id, shouldOffer: true });
        }
      }
      db.logEvent(room.meetingId, 'participant.admitted', severityFor('participant.admitted'),
        { participantId: waiting.id, actorId: by.userId });
    } else {
      for (const sid of waiting.socketIds) {
        nsp.to(sid).emit('meet:denied', { reason: 'The host did not admit you to this meeting.' });
        nsp.sockets.get(sid)?.disconnect(true);
      }
      db.closeParticipant(waiting.id, 'denied');
      db.logEvent(room.meetingId, 'participant.denied', severityFor('participant.denied'),
        { participantId: waiting.id, actorId: by.userId });
    }

    emitToHosts(room, 'meet:lobby_resolved',
      { participantId: waiting.id, admitted, by: by.name });
  }

  async function departure(socket: MeetSocket, reason: string): Promise<void> {
    const { meetingId, participantId } = socket.data;
    if (!meetingId || !participantId) return;
    const room = rooms.get(meetingId);
    if (!room) return;
    const participant = room.find(participantId);
    if (!participant) return;

    participant.socketIds.delete(socket.id);
    // Another tab still holds the participant — closing one is not leaving.
    if (participant.socketIds.size > 0) return;

    room.markSpeaking(participantId, false);
    room.participants.delete(participantId);
    room.waiting.delete(participantId);
    db.closeParticipant(participantId, 'left');
    db.addSpeakingSeconds(room.drainSpeakingSeconds());
    db.logEvent(meetingId, 'participant.left', severityFor('participant.left'),
      { participantId, actorId: socket.data.user?.id, payload: { reason } });

    emitToRoom(meetingId, 'meet:participant_left', { participantId, reason });
    emitToRoom(meetingId, 'meet:mesh:peer_left', { participantId });
    dropRoomIfEmpty(meetingId);
  }

  /**
   * The rolling AI summary trigger.
   *
   * Batched on both time and volume, because either alone gets it wrong: a
   * timer fires through a silent stretch and summarises nothing, and a segment
   * count fires ten times a minute in a busy discussion. The generation itself
   * is the API's job — this only tells the room to ask for it, so the socket
   * gateway never blocks on a model.
   */
  async function maybeRollingSummary(room: MeetRoom): Promise<void> {
    const now = Date.now();
    if (now - room.lastSummaryAt < AI_SUMMARY_INTERVAL_MS) return;

    const count = await db.countFinalSegments(room.meetingId);
    if (count - room.lastSummarySegments < AI_MIN_SEGMENTS_FOR_SUMMARY) return;

    room.lastSummaryAt = now;
    room.lastSummarySegments = count;
    emitToRoom(room.meetingId, 'meet:ai_thinking', { kind: 'summary' });
  }

  /* ---------------- periodic flush ---------------- */

  // Speaking time is banked on a timer rather than on every state change: a
  // lively discussion produces several transitions a second, and each would
  // otherwise be an UPDATE.
  const flushTimer = setInterval(() => {
    for (const room of rooms.values()) {
      const drained = room.drainSpeakingSeconds();
      if (drained.length) db.addSpeakingSeconds(drained);
    }
  }, SPEAKING_FLUSH_MS);
  flushTimer.unref();

  return nsp;
}

/** Strip the server-only fields before a participant goes on the wire. */
function stripLive(p: LiveParticipant): MeetParticipant {
  const { socketIds: _s, lastSpokeAt: _l, speakingMs: _m, speakingSince: _ss,
    breakoutRoomId: _b, ...wire } = p;
  return wire;
}

function toWireChat(row: Record<string, unknown>): MeetChatMessage {
  return {
    id: String(row.id),
    meetingId: String(row.meeting_id),
    participantId: String(row.participant_id),
    senderName: String(row.sender_name),
    body: String(row.body),
    toParticipantId: (row.to_participant_id as string | null) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}
