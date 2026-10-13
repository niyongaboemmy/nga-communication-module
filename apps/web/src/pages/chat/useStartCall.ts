import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotify } from '../../context/NotificationContext';
import * as meetApi from '../meet/api';
import { useChat } from './ChatProvider';
import type { Conversation } from './types';

/**
 * Start a call from a conversation's header (B-10). The phone and camera
 * buttons used to do nothing. One press starts a live meeting tied to the
 * conversation (only its members may join), posts the call card so everyone
 * there can join from the log, and takes the caller straight into the room.
 * The phone starts it audio-only.
 */
export function useStartCall(conversation: Conversation): { start: (audioOnly: boolean) => Promise<void>; starting: boolean } {
  const { send } = useChat();
  const { notify } = useNotify();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);

  const start = useCallback(async (audioOnly: boolean) => {
    if (starting) return;
    setStarting(true);
    try {
      const title = conversation.type === 'dm' ? `Call with ${conversation.name}` : `${conversation.name} call`;
      const m = await meetApi.startInstant({
        title, conversationId: conversation.id, ...(audioOnly ? { settings: { audioOnly: true } } : {}),
      });
      await send({
        body: `${audioOnly ? '📞' : '📹'} ${m.title} — started a ${audioOnly ? 'call' : 'meeting'}`,
        type: 'call_event',
        metadata: {
          meet: {
            meetingId: m.id, joinCode: m.join_code, title: m.title,
            scheduledStart: m.scheduled_start, scheduledEnd: m.scheduled_end,
          },
        },
      });
      navigate(`/app/meet/${m.id}`);
    } catch (err) {
      notify({ title: 'Could not start the call', body: err instanceof Error ? err.message : undefined, tone: 'error' });
    } finally {
      setStarting(false);
    }
  }, [conversation, send, navigate, notify, starting]);

  return { start, starting };
}
