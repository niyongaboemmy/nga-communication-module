import React, { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Link2Off } from 'lucide-react';
import { EmptyState, Spinner } from '../../components/ui';
import { useChat } from './ChatProvider';
import * as chatApi from './api';

/**
 * `/app/chat/:conversationId/:messageId?` — the shape notifications and "copy
 * link" produce — rewritten to the query form the chat page reads, so there is
 * one way to open a conversation, not two.
 */
export const ChatPermalink: React.FC = () => {
  const { conversationId, messageId } = useParams();
  const qs = new URLSearchParams();
  if (conversationId) qs.set('c', conversationId);
  if (messageId) qs.set('m', messageId);
  return <Navigate to={`/app/chat?${qs.toString()}`} replace />;
};

/** `/app/chat/invite/:code` — redeem, then open the conversation it leads to. */
export const ChatInvite: React.FC = () => {
  const { code } = useParams();
  const navigate = useNavigate();
  const { refresh } = useChat();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    chatApi.redeemInvite(code)
      .then(async (conversation) => {
        await refresh();
        if (!cancelled) navigate(`/app/chat?c=${conversation.id}`, { replace: true });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'This invite link no longer works.');
      });
    return () => { cancelled = true; };
  }, [code, navigate, refresh]);

  if (error) {
    return (
      <EmptyState
        icon={<Link2Off size={22} />}
        title="This invite can't be used"
        hint={error}
        action={<button onClick={() => navigate('/app/chat')} className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">Go to Chat</button>}
      />
    );
  }
  return <div className="grid h-full place-items-center"><Spinner className="h-5 w-5" /></div>;
};
