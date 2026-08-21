import { useEffect, useRef } from 'react';
import type { MeetParticipant } from '@tupo/shared';
import { useNotify } from '../../context/NotificationContext';
import { speakableName } from '../../lib/speech';
import type { MeetRoomActions, MeetRoomDerived, MeetRoomState } from './useMeetRoom';

/**
 * Turns meeting state changes into notifications.
 *
 * Kept out of `useMeetRoom` on purpose. That hook is the transport and state
 * machine; this one is a *policy* about what deserves a person's attention,
 * and the two change for different reasons. Everything here is derived by
 * diffing successive states rather than by adding callbacks to the socket
 * layer, so the room stays unaware that anyone is watching.
 *
 * What is deliberately NOT notified:
 *
 *  - Your own actions. You just did them; a toast telling you so is clutter.
 *  - Reactions. They are already visible, animated, on the stage.
 *  - Routine mute and camera toggles, which happen constantly.
 *  - Anything at all while you are the one on the meeting page and the panel
 *    concerned is already open — the badge is enough.
 */

interface Params {
  room: (MeetRoomState & MeetRoomDerived & MeetRoomActions) | null;
  /** The meeting page is open and focused on this meeting. */
  isOnCallRoute: boolean;
  /** Which side panel is open, so we do not toast what is already on screen. */
  openPanel: string | null;
  isHost: boolean;
  onOpenPanel?: (panel: 'participants' | 'chat' | 'polls' | 'qa') => void;
  onGoToMeeting?: () => void;
}

export function useMeetNotifications({
  room, isOnCallRoute, openPanel, isHost, onOpenPanel, onGoToMeeting,
}: Params): void {
  const { notify } = useNotify();

  // Previous values, so each effect can describe the *change* rather than the
  // state. Refs rather than state: these must never cause a render.
  const seenParticipants = useRef<Set<string>>(new Set());
  const seenLobby = useRef<Set<string>>(new Set());
  const seenChatIds = useRef<Set<string>>(new Set());
  const seenPollIds = useRef<Set<string>>(new Set());
  const seenQuestionIds = useRef<Set<string>>(new Set());
  const seenNoteIds = useRef<Set<string>>(new Set());
  const handsUp = useRef<Set<string>>(new Set());
  const wasRecording = useRef(false);
  const primed = useRef(false);

  /* On first sight of a room, record everything as already seen. Otherwise
   * joining a meeting in progress fires a notification for every participant,
   * every message and every poll that was there before you arrived. */
  useEffect(() => {
    if (!room || primed.current || room.phase === 'connecting') return;
    primed.current = true;
    seenParticipants.current = new Set(room.participants.map((p) => p.id));
    seenLobby.current = new Set(room.lobby.map((p) => p.id));
    seenChatIds.current = new Set(room.chat.map((c) => c.id));
    seenPollIds.current = new Set(room.polls.map((p) => p.id));
    seenQuestionIds.current = new Set(room.questions.map((q) => q.id));
    seenNoteIds.current = new Set(room.notes.map((n) => n.id));
    handsUp.current = new Set(room.participants.filter((p) => p.handRaised).map((p) => p.id));
    wasRecording.current = room.recording;
  }, [room]);

  /* ---- people arriving and leaving ---- */
  useEffect(() => {
    if (!room || !primed.current) return;
    const current = new Set(room.participants.map((p) => p.id));
    const you = room.you?.id;

    for (const p of room.participants) {
      if (p.id === you || seenParticipants.current.has(p.id)) continue;
      notify({
        title: `${p.name} joined`,
        tone: 'info',
        sound: 'join',
        badge: '👋',
        durationMs: 3000,
        speak: `${speakableName(p.name)} joined`,
        // Only worth a system notification when you are not looking at the room.
        system: !isOnCallRoute,
      });
    }

    for (const id of seenParticipants.current) {
      if (current.has(id) || id === you) continue;
      notify({
        title: 'Someone left the meeting',
        tone: 'info', sound: 'leave', badge: '👋', durationMs: 2500,
      });
    }

    seenParticipants.current = current;
  }, [room?.participants, room, isOnCallRoute, notify]);

  /* ---- the lobby ---- */
  useEffect(() => {
    if (!room || !primed.current || !isHost) return;
    const waiting: MeetParticipant[] = room.lobby;
    const fresh = waiting.filter((p) => !seenLobby.current.has(p.id));

    if (fresh.length > 0) {
      // Keyed, so four people arriving at once is one line that updates rather
      // than four toasts pushing each other off the screen. Kept until acted
      // on: someone waiting outside is the one thing that must not time out.
      notify({
        key: 'lobby',
        title: waiting.length === 1
          ? `${waiting[0]!.name} is waiting to join`
          : `${waiting.length} people are waiting to join`,
        body: 'They cannot see or hear the meeting yet.',
        tone: 'warning',
        sound: 'knock',
        badge: '🚪',
        durationMs: 0,
        system: true,
        speak: waiting.length === 1
          ? `${speakableName(waiting[0]!.name)} is waiting to join`
          : `${waiting.length} people are waiting to join`,
        action: onOpenPanel
          ? { label: 'Admit', onClick: () => onOpenPanel('participants') }
          : undefined,
      });
    }
    seenLobby.current = new Set(waiting.map((p) => p.id));
  }, [room?.lobby, room, isHost, notify, onOpenPanel]);

  /* ---- your own admission ---- */
  useEffect(() => {
    if (!room) return;
    if (room.phase === 'active' && primed.current) return;
    if (room.phase === 'removed') {
      notify({
        title: 'You are no longer in this meeting',
        body: room.error ?? undefined,
        tone: 'error', sound: 'denied', durationMs: 0, system: true,
      });
    }
  }, [room?.phase, room, notify]);

  /* ---- chat ---- */
  useEffect(() => {
    if (!room || !primed.current) return;
    const you = room.you?.id;

    for (const message of room.chat) {
      if (seenChatIds.current.has(message.id)) continue;
      seenChatIds.current.add(message.id);
      if (message.participantId === you) continue;

      const isPrivate = !!message.toParticipantId;
      // Nothing while the chat panel is open on the page — the message is
      // already right there.
      if (openPanel === 'chat' && isOnCallRoute && !isPrivate) continue;

      notify({
        title: isPrivate ? `${message.senderName} messaged you privately` : message.senderName,
        body: message.body.slice(0, 140),
        tone: 'info',
        sound: isPrivate ? 'mention' : 'message',
        badge: isPrivate ? '🔒' : '💬',
        // Only private messages are read aloud. Reading every message in a busy
        // class chat would make the voice unusable within a minute.
        speak: isPrivate
          ? `Private message from ${speakableName(message.senderName)}`
          : undefined,
        system: isPrivate || !isOnCallRoute,
        action: onOpenPanel ? { label: 'Open chat', onClick: () => onOpenPanel('chat') } : undefined,
      });
    }
  }, [room?.chat, room, openPanel, isOnCallRoute, notify, onOpenPanel]);

  /* ---- hands ---- */
  useEffect(() => {
    if (!room || !primed.current) return;
    const you = room.you?.id;
    const raised = new Set(room.participants.filter((p) => p.handRaised).map((p) => p.id));

    for (const p of room.participants) {
      if (!p.handRaised || p.id === you || handsUp.current.has(p.id)) continue;
      // Only the people running the meeting need to know. A pupil does not need
      // a chime every time a classmate has a question.
      if (!isHost) continue;
      notify({
        title: `${p.name} raised their hand`,
        tone: 'info', sound: 'hand', badge: '✋', durationMs: 4000,
        speak: `${speakableName(p.name)} has a question`,
        system: !isOnCallRoute,
        action: onOpenPanel
          ? { label: 'See the queue', onClick: () => onOpenPanel('participants') }
          : undefined,
      });
    }
    handsUp.current = raised;
  }, [room?.participants, room, isHost, isOnCallRoute, notify, onOpenPanel]);

  /* ---- polls and questions ---- */
  useEffect(() => {
    if (!room || !primed.current) return;
    for (const poll of room.polls) {
      if (seenPollIds.current.has(poll.id)) continue;
      seenPollIds.current.add(poll.id);
      if (poll.status !== 'open') continue;
      notify({
        title: poll.kind === 'quiz' ? 'A quiz has started' : 'A poll has started',
        body: poll.question,
        tone: 'info', sound: 'poll', badge: '📊', durationMs: 8000,
        speak: poll.kind === 'quiz' ? 'A quiz has started' : 'A poll has started',
        system: !isOnCallRoute,
        action: onOpenPanel ? { label: 'Vote', onClick: () => onOpenPanel('polls') } : undefined,
      });
    }
  }, [room?.polls, room, isOnCallRoute, notify, onOpenPanel]);

  useEffect(() => {
    if (!room || !primed.current || !isHost) return;
    for (const question of room.questions) {
      if (seenQuestionIds.current.has(question.id)) continue;
      seenQuestionIds.current.add(question.id);
      if (question.participantId === room.you?.id) continue;
      notify({
        title: `${question.askedBy} asked a question`,
        body: question.text.slice(0, 140),
        tone: 'info', sound: 'message', badge: '🙋', durationMs: 6000,
        speak: `${speakableName(question.askedBy)} asked a question`,
        action: onOpenPanel ? { label: 'Open Q&A', onClick: () => onOpenPanel('qa') } : undefined,
      });
    }
  }, [room?.questions, room, isHost, notify, onOpenPanel]);

  /* ---- shared notes ---- */
  useEffect(() => {
    if (!room || !primed.current) return;
    for (const note of room.notes) {
      if (seenNoteIds.current.has(note.id)) continue;
      seenNoteIds.current.add(note.id);
      if (note.isMine !== false || !note.isShared) continue;
      notify({
        title: `${note.authorName} shared a note`,
        body: note.body.slice(0, 140),
        tone: 'info', sound: 'message', badge: '📝', durationMs: 6000,
      });
    }
  }, [room?.notes, room, notify]);

  /* ---- recording ---- */
  useEffect(() => {
    if (!room || !primed.current) return;
    if (room.recording === wasRecording.current) return;
    wasRecording.current = room.recording;

    // Never times out and always raises a system notification. Being recorded
    // without noticing is the failure this exists to prevent.
    notify({
      key: 'recording',
      title: room.recording ? 'This meeting is being recorded' : 'Recording stopped',
      body: room.recording ? 'Everyone in the meeting has been told.' : undefined,
      tone: room.recording ? 'warning' : 'info',
      sound: room.recording ? 'recording-start' : 'recording-stop',
      badge: room.recording ? '🔴' : '⏹️',
      durationMs: room.recording ? 0 : 4000,
      // Always spoken. Being recorded without noticing is the failure this
      // whole path exists to prevent, so it is the one thing that interrupts.
      speak: room.recording
        ? 'This meeting is now being recorded'
        : 'Recording has stopped',
      system: true,
    });
  }, [room?.recording, room, notify]);

  /* ---- the meeting ending ---- */
  useEffect(() => {
    if (!room || room.phase !== 'ended') return;
    notify({
      title: 'The meeting has ended',
      body: 'Taking you to the summary.',
      tone: 'info', sound: 'ended', badge: '👋', durationMs: 5000, system: true,
      speak: 'The meeting has ended',
      action: onGoToMeeting ? { label: 'Open summary', onClick: onGoToMeeting } : undefined,
    });
  }, [room?.phase, room, notify, onGoToMeeting]);

  /* ---- errors worth surfacing ---- */
  useEffect(() => {
    if (!room?.error || room.phase === 'removed') return;
    notify({
      key: 'room-error',
      title: 'Something went wrong',
      body: room.error,
      tone: 'error', sound: 'error', durationMs: 6000,
    });
  }, [room?.error, room, notify]);
}
