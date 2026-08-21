import type { MeetParticipant, MeetRole, MeetReaction, MeetSettings } from '@tupo/shared';
import { DEFAULT_MEET_SETTINGS, MAX_CONCURRENT_SHARES } from '@tupo/shared';

/**
 * In-memory room state for the `/meet` namespace.
 *
 * Only the *ephemeral* half of a meeting lives here — who is connected right
 * now, who has a hand up, who is speaking. Everything durable (the participant
 * row, the attendance clock, chat, transcript) is written to Postgres by the
 * handlers, so a gateway restart costs the room its live view for one reconnect
 * and nothing more.
 *
 * With the Redis adapter attached, several gateway instances fan events out to
 * each other; each keeps its own copy of this for the sockets it holds, and the
 * database remains the arbiter of anything that has to be agreed on.
 */

export interface LiveParticipant extends MeetParticipant {
  socketIds: Set<string>;
  lastSpokeAt: number;
  /** Accumulated speaking time, flushed to the participant row periodically. */
  speakingMs: number;
  speakingSince: number | null;
  breakoutRoomId: string | null;
}

export class MeetRoom {
  readonly participants = new Map<string, LiveParticipant>();
  /** Knocking and lobby participants, kept apart from the roster on purpose:
   *  someone waiting is not in the meeting and must not appear in it. */
  readonly waiting = new Map<string, LiveParticipant>();

  /** The live copy of the meeting's settings. Written through to the database
   *  whenever a host changes one, so this and the row never disagree. */
  settings: MeetSettings = DEFAULT_MEET_SETTINGS;

  spotlightId: string | null = null;
  recording = false;
  transcribing = false;
  aiPresent = false;
  startedAt: string | null = null;
  /** Rolling window of who has spoken, most recent first. Drives speaker view. */
  activeSpeakerId: string | null = null;
  lastSummaryAt = 0;
  lastSummarySegments = 0;

  constructor(readonly meetingId: string) {}

  get isEmpty(): boolean {
    return this.participants.size === 0 && this.waiting.size === 0;
  }

  roster(): MeetParticipant[] {
    return [...this.participants.values()].map(toWire);
  }

  lobby(): MeetParticipant[] {
    return [...this.waiting.values()].map(toWire);
  }

  find(participantId: string): LiveParticipant | undefined {
    return this.participants.get(participantId) ?? this.waiting.get(participantId);
  }

  findBySocket(socketId: string): LiveParticipant | undefined {
    for (const p of this.participants.values()) if (p.socketIds.has(socketId)) return p;
    for (const p of this.waiting.values()) if (p.socketIds.has(socketId)) return p;
    return undefined;
  }

  /** Everyone who may act as a host — the audience for lobby knocks. */
  hosts(): LiveParticipant[] {
    return [...this.participants.values()].filter((p) => p.role === 'host' || p.role === 'cohost');
  }

  /**
   * Hand-raise order. Whoever raised first is first — a queue, not a set, because
   * "who asked first" is the entire point of raising a hand in a classroom.
   */
  handQueue(): LiveParticipant[] {
    return [...this.participants.values()]
      .filter((p) => p.handRaised)
      .sort((a, b) => (a.handRaisedAt ?? '').localeCompare(b.handRaisedAt ?? ''));
  }

  handPosition(participantId: string): number {
    return this.handQueue().findIndex((p) => p.id === participantId) + 1;
  }

  /** FR-MEET-7 — at most two shares at once, enforced here rather than in the UI. */
  canShare(participantId: string): boolean {
    const sharing = [...this.participants.values()].filter((p) => p.screenSharing);
    return sharing.length < MAX_CONCURRENT_SHARES || sharing.some((p) => p.id === participantId);
  }

  /**
   * Bank speaking time. Called when someone stops speaking and on flush, so the
   * engagement report has real seconds rather than a count of caption segments.
   */
  markSpeaking(participantId: string, speaking: boolean): void {
    const p = this.participants.get(participantId);
    if (!p) return;
    const now = Date.now();
    if (speaking) {
      p.speaking = true;
      p.lastSpokeAt = now;
      p.speakingSince ??= now;
      this.activeSpeakerId = participantId;
    } else {
      p.speaking = false;
      if (p.speakingSince) {
        p.speakingMs += now - p.speakingSince;
        p.speakingSince = null;
      }
    }
  }

  /** Seconds to persist, and reset — so a flush never double-counts. */
  drainSpeakingSeconds(): Array<{ participantId: string; seconds: number }> {
    const out: Array<{ participantId: string; seconds: number }> = [];
    const now = Date.now();
    for (const p of this.participants.values()) {
      // Close and reopen any in-progress span so a long uninterrupted talker is
      // still credited on every flush.
      if (p.speakingSince) {
        p.speakingMs += now - p.speakingSince;
        p.speakingSince = now;
      }
      const seconds = Math.floor(p.speakingMs / 1000);
      if (seconds > 0) {
        out.push({ participantId: p.id, seconds });
        p.speakingMs -= seconds * 1000;
      }
    }
    return out;
  }
}

function toWire(p: LiveParticipant): MeetParticipant {
  const { socketIds: _s, lastSpokeAt: _l, speakingMs: _m, speakingSince: _ss,
    breakoutRoomId: _b, ...wire } = p;
  return wire;
}

/** Rooms this gateway instance currently holds sockets for. */
export const rooms = new Map<string, MeetRoom>();

export function getRoom(meetingId: string): MeetRoom {
  let room = rooms.get(meetingId);
  if (!room) {
    room = new MeetRoom(meetingId);
    rooms.set(meetingId, room);
  }
  return room;
}

export function dropRoomIfEmpty(meetingId: string): void {
  const room = rooms.get(meetingId);
  if (room?.isEmpty) rooms.delete(meetingId);
}

export const roomKey = (meetingId: string) => `meet:${meetingId}`;
export const hostKey = (meetingId: string) => `meet:${meetingId}:hosts`;
export const breakoutKey = (breakoutId: string) => `meet:breakout:${breakoutId}`;

export const isValidReaction = (r: unknown): r is MeetReaction =>
  typeof r === 'string' && r.length <= 8;

export const canHost = (role: MeetRole | undefined): boolean =>
  role === 'host' || role === 'cohost';
