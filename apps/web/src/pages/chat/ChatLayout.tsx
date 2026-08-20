import React, { useEffect, useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import { EmptyState } from '../../components/ui';
import { ConversationList } from './ConversationList';
import { MessageThread } from './MessageThread';
import { Composer } from './Composer';
import { ContextPanel } from './ContextPanel';
import { useConversations, useMembers, useMessages } from './data';

/**
 * Chat, three panes (SRS §15.1).
 *
 *   ≥1280px  list │ thread │ context, all inline
 *   ≥768px   list │ thread, context overlays from the right
 *   <768px   one pane at a time: the list *is* the screen until a conversation
 *            is opened, then the thread replaces it and Back returns
 *
 * The mobile behaviour is done by mounting only the active pane rather than
 * hiding the other with CSS. Two reasons: an off-screen `display:none` pane
 * still gets tab focus and screen-reader attention on some engines, and a phone
 * should not be paying to render a 34-row list behind an open conversation.
 *
 * Selection lives here rather than in the URL for now. Phase 1 gives
 * conversations real ids and this becomes `/app/chat/:conversationId`, which is
 * what makes a conversation linkable and the browser Back button work — the
 * `select`/`clear` handlers below are already the only two places that change
 * it, so that swap is local to this file.
 */

export const ChatLayout: React.FC = () => {
  const { conversations, loading } = useConversations();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const { messages, loading: messagesLoading } = useMessages(activeId);
  const members = useMembers(activeId);

  // On a wide screen an empty right-hand pane is wasted space, so open the
  // first conversation automatically. On a phone that would rob the user of the
  // list they came for, so it stays on the list until they choose.
  useEffect(() => {
    if (activeId || loading || conversations.length === 0) return;
    const first = conversations[0];
    if (first && window.matchMedia('(min-width: 768px)').matches) {
      setActiveId(first.id);
    }
  }, [activeId, loading, conversations]);

  // Escape closes the overlay context panel — the same key that closes every
  // other overlay in the app.
  useEffect(() => {
    if (!contextOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [contextOpen]);

  const showListOnMobile = active === null;

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Pane 1 — conversation list. Full width on a phone, a fixed column
          beyond it: a list that grows with the viewport just makes long lines
          of preview text, it does not become more readable. */}
      <div
        className={`w-full min-w-0 shrink-0 border-r border-border-light md:w-72 lg:w-80 dark:border-border-dark/30 ${
          showListOnMobile ? 'flex' : 'hidden md:flex'
        }`}
      >
        <div className="w-full">
          <ConversationList
            conversations={conversations}
            loading={loading}
            activeId={activeId}
            onSelect={setActiveId}
          />
        </div>
      </div>

      {/* Pane 2 — thread. */}
      {active ? (
        <MessageThread
          conversation={active}
          messages={messages}
          loading={messagesLoading}
          onBack={() => setActiveId(null)}
          onToggleContext={() => setContextOpen((o) => !o)}
          contextOpen={contextOpen}
        >
          <Composer conversation={active} />
        </MessageThread>
      ) : (
        <div className="hidden min-h-0 min-w-0 flex-1 place-items-center bg-surface-light md:grid dark:bg-background-dark">
          <EmptyState
            icon={<MessagesSquare size={22} />}
            title="Pick a conversation"
            hint="Choose a channel or a person on the left to start reading."
          />
        </div>
      )}

      {/* Pane 3 — context. Inline at xl, overlay below it. */}
      {active && contextOpen && (
        <>
          <div
            className="fixed inset-0 z-70 bg-black/40 xl:hidden"
            onClick={() => setContextOpen(false)}
            aria-hidden="true"
          />
          <div
            className="animate-panel-in-right fixed inset-y-0 right-0 z-80 w-80 max-w-[85vw] shadow-2xl xl:static xl:z-auto xl:w-80 xl:shadow-none"
          >
            <ContextPanel conversation={active} members={members} onClose={() => setContextOpen(false)} />
          </div>
        </>
      )}
    </div>
  );
};
