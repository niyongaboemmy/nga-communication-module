import { useMemo } from 'react';
import type { HostCommand, MeetReaction, MeetSettings, MeetNote } from '@tupo/shared';
import { useNotify } from '../../context/NotificationContext';
import type { MeetRoomActions, MeetRoomDerived, MeetRoomState } from './useMeetRoom';

/**
 * Confirms the things *you* just did.
 *
 * `useMeetNotifications` covers events arriving from other people. This covers
 * the other half — pressing a button and being told it worked — and the two are
 * deliberately separate, because they are different in kind and are tuned
 * differently. A notification tells you something you did not know; a
 * confirmation closes a loop you opened. Confirmations are therefore quieter,
 * shorter, never spoken aloud, and never raised to the operating system.
 *
 * Implemented as a wrapper around the room's actions rather than by pushing
 * `notify` into `useMeetRoom`. That hook is the transport and the state
 * machine; what deserves an acknowledgement is a product decision, and putting
 * it there would mean the socket layer imported the toast system.
 *
 * Not everything is confirmed. Muting, unmuting and reactions all produce
 * immediate, unmistakable visual feedback of their own, and a toast for each
 * would bury the ones that matter.
 */

type Room = MeetRoomState & MeetRoomDerived & MeetRoomActions;

/** Host commands whose effect is not obvious from the stage. */
const HOST_COMMAND_CONFIRMATION: Partial<Record<HostCommand['action'], string>> = {
  mute: 'Muted them',
  mute_all: 'Everyone muted',
  unmute_request: 'Asked them to unmute',
  camera_off: 'Turned their camera off',
  remove: 'Removed from the meeting',
  promote: 'Made a co-host',
  demote: 'No longer a co-host',
  lock: 'Meeting locked — nobody new can join',
  unlock: 'Meeting unlocked',
  admit: 'Let them in',
  deny: 'Turned them away',
  admit_all: 'Everyone waiting was let in',
  spotlight: 'Spotlighted for everyone',
  unspotlight: 'Spotlight removed',
  disable_chat: 'Chat turned off for attendees',
  enable_chat: 'Chat turned back on',
  disable_share: 'Screen sharing turned off for attendees',
  enable_share: 'Screen sharing turned back on',
};

export function useMeetActionFeedback(room: Room | null): Room | null {
  const { confirm, notify } = useNotify();

  return useMemo(() => {
    if (!room) return null;

    return {
      ...room,

      sendChat: (body: string, toParticipantId?: string) => {
        room.sendChat(body, toParticipantId);
        // Named recipient rather than "sent": the thing worth confirming about
        // a private message is *who could read it*.
        const to = toParticipantId
          ? room.participants.find((p) => p.id === toParticipantId)?.name
          : null;
        confirm(to ? `Sent privately to ${to}` : 'Sent to everyone', {
          badge: to ? '🔒' : '💬',
          sound: 'message',
        });
      },

      createPoll: (poll: Parameters<Room['createPoll']>[0]) => {
        room.createPoll(poll);
        confirm(poll.kind === 'quiz' ? 'Quiz posted' : 'Poll posted', {
          body: poll.question,
          badge: '📊',
          sound: 'poll',
        });
      },

      votePoll: (pollId: string, optionIndexes: number[]) => {
        room.votePoll(pollId, optionIndexes);
        const poll = room.polls.find((p) => p.id === pollId);
        const already = (poll?.myVote?.length ?? 0) > 0;
        confirm(already ? 'Vote changed' : 'Vote counted', {
          body: poll?.options.find((o) => o.index === optionIndexes[0])?.text,
          badge: '✅',
        });
      },

      closePoll: (pollId: string) => {
        room.closePoll(pollId);
        confirm('Poll closed', { body: 'The answer is now visible to everyone.', badge: '📊' });
      },

      askQuestion: (text: string) => {
        room.askQuestion(text);
        confirm('Question added to the queue', { body: text, badge: '🙋' });
      },

      upvoteQuestion: (questionId: string) => {
        room.upvoteQuestion(questionId);
        confirm('Upvoted', { badge: '👍', sound: 'reaction' });
      },

      answerQuestion: (questionId: string, answerText: string) => {
        room.answerQuestion(questionId, answerText);
        confirm('Marked as answered', { badge: '✅' });
      },

      toggleHand: () => {
        room.toggleHand();
        // Raising is worth confirming — the queue position is not visible from
        // the button. Lowering is not: the button plainly changes back.
        if (!room.handRaised) {
          confirm('Hand raised', { body: 'The host has been told.', badge: '✋', sound: 'hand' });
        }
      },

      shareNote: (note: MeetNote, shared: boolean) => {
        room.shareNote(note, shared);
        confirm(shared ? 'Note shared with everyone' : 'Note is private again', {
          badge: shared ? '📤' : '🔒',
        });
      },

      hostCommand: async (command: HostCommand) => {
        const result = await room.hostCommand(command);
        if (!result.ok) {
          // A refused command is a notification, not a confirmation: it is
          // something you did not know, and it needs to stay long enough to read.
          notify({
            title: 'That did not work',
            body: result.message,
            tone: 'error',
            sound: 'error',
          });
          return result;
        }
        const message = HOST_COMMAND_CONFIRMATION[command.action];
        if (message) confirm(message, { badge: '🛡️' });
        return result;
      },

      patchSettings: (patch: Partial<MeetSettings>) => {
        room.patchSettings(patch);
        // Only the settings whose effect is invisible from the room itself.
        // Everything else announces itself: the banner, the caption bar, the
        // AI panel.
        const [key] = Object.keys(patch);
        const wording: Partial<Record<keyof MeetSettings, [string, string]>> = {
          allowAttendeeUnmute: ['Attendees can unmute themselves', 'Only you can invite someone to speak'],
          allowReactions: ['Reactions turned on', 'Reactions turned off'],
          lobbyEnabled: ['Waiting room on', 'Waiting room off'],
          admissionPolicy: ['Who can join updated', 'Who can join updated'],
          recordingEnabled: ['Recording allowed', 'Recording not allowed'],
        };
        const pair = key ? wording[key as keyof MeetSettings] : undefined;
        if (pair) {
          const on = Boolean(patch[key as keyof MeetSettings]);
          confirm(key === 'admissionPolicy' ? pair[0] : on ? pair[0] : pair[1], { badge: '⚙️' });
        }
      },

      openBreakouts: (plan: Parameters<Room['openBreakouts']>[0]) => {
        room.openBreakouts(plan);
        confirm(`${plan.rooms.length} breakout rooms opened`, {
          body: plan.durationMinutes ? `They close in ${plan.durationMinutes} minutes.` : undefined,
          badge: '🚪',
        });
      },

      closeBreakouts: () => {
        room.closeBreakouts();
        confirm('Breakout rooms closed', { body: 'Everyone is back in the main room.', badge: '🚪' });
      },

      broadcastToBreakouts: (body: string) => {
        room.broadcastToBreakouts(body);
        confirm('Sent to every room', { body, badge: '📢' });
      },

      react: (reaction: MeetReaction) => {
        // Not confirmed: it is already animating across everyone's stage,
        // including yours.
        room.react(reaction);
      },

      setDataSaver: (on: boolean) => {
        room.setDataSaver(on);
        confirm(on ? 'Data saver on' : 'Data saver off', {
          body: on ? 'Lower video quality, fewer video tiles.' : undefined,
          badge: on ? '🐢' : '⚡',
        });
      },
    };
  }, [room, confirm, notify]);
}
