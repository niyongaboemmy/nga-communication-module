import React, { useEffect, useRef, useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import { EmptyState } from '../../components/ui';
import { ConversationList } from './ConversationList';
import { MessageThread } from './MessageThread';
import { Composer } from './Composer';
import { ContextPanel } from './ContextPanel';
import { ChatProvider, useChat } from './ChatProvider';
import { ThreadPanel } from './ThreadPanel';
import { SavedItems } from './SavedItems';
import { NotificationSettings } from './NotificationSettings';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import * as chatApi from './api';
import type { Member } from './types';

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
 */

const ChatWorkspace: React.FC = () => {
  const {
    conversations, conversationsLoading, activeId, setActiveId, active, threadRootId, openThread,
  } = useChat();
  const [contextOpen, setContextOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);

  /*
   * On a wide screen an empty right-hand pane is wasted space, so open the
   * first conversation automatically. On a phone that would rob the user of the
   * list they came for, so it stays on the list until they choose.
   *
   * It fires on the *initial load only*, and the latch is set the moment that
   * load finishes — even when it finished with nothing to open. Latching on
   * "we opened something" instead leaves the effect armed for an empty
   * account, so the first DM anyone sends them rips them out of whatever they
   * were doing, opens itself, and marks itself read. Reading someone's message
   * has to be something the reader did, not something that happened to them.
   */
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || conversationsLoading) return;
    autoOpened.current = true;
    if (activeId || conversations.length === 0) return;
    const first = conversations[0];
    if (first && window.matchMedia('(min-width: 768px)').matches) setActiveId(first.id);
  }, [activeId, conversationsLoading, conversations, setActiveId]);

  // Members are only needed when the details panel is actually open — a channel
  // of 400 is a real payload, and the sidebar never shows it.
  useEffect(() => {
    if (!activeId || !contextOpen) return;
    let cancelled = false;
    chatApi.listMembers(activeId)
      .then((m) => { if (!cancelled) setMembers(m); })
      .catch(() => { if (!cancelled) setMembers([]); });
    return () => { cancelled = true; };
  }, [activeId, contextOpen]);

  // Opening a thread puts the details panel away rather than leaving it stacked
  // behind, so closing the thread does not reveal a panel nobody asked for.
  useEffect(() => { if (threadRootId) setContextOpen(false); }, [threadRootId]);

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
        <div className="w-full min-w-0">
          <ConversationList
            onOpenSaved={() => { setSettingsOpen(false); setSavedOpen(true); }}
            onOpenSettings={() => { setSavedOpen(false); setSettingsOpen(true); }}
          />
        </div>
      </div>

      {/* Pane 2 — thread. */}
      {active ? (
        <MessageThread
          conversation={active}
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
            title={conversationsLoading ? 'Loading your conversations' : 'Pick a conversation'}
            hint={conversationsLoading
              ? 'One moment.'
              : 'Choose a channel or a person on the left to start reading.'}
          />
        </div>
      )}

      {/* Notification settings — same slot as the other side panels. */}
      {settingsOpen && (
        <>
          <div
            className="fixed inset-0 z-70 bg-black/40 xl:hidden"
            onClick={() => setSettingsOpen(false)}
            aria-hidden="true"
          />
          <div className="animate-panel-in-right fixed inset-y-0 right-0 z-80 w-96 max-w-[90vw] xl:static xl:z-auto xl:w-96">
            <NotificationSettings onClose={() => setSettingsOpen(false)} />
          </div>
        </>
      )}

      {/* Saved items — same slot as the other side panels. */}
      {savedOpen && !settingsOpen && (
        <>
          <div
            className="fixed inset-0 z-70 bg-black/40 xl:hidden"
            onClick={() => setSavedOpen(false)}
            aria-hidden="true"
          />
          <div className="animate-panel-in-right fixed inset-y-0 right-0 z-80 w-96 max-w-[90vw] xl:static xl:z-auto xl:w-96">
            <SavedItems onClose={() => setSavedOpen(false)} />
          </div>
        </>
      )}

      {/* Pane 3 — thread. It and the details panel occupy the same slot: two
          side panels at once leaves the conversation itself too narrow to read,
          so opening one closes the other. */}
      {active && threadRootId && !savedOpen && !settingsOpen && (
        <>
          <div
            className="fixed inset-0 z-70 bg-black/40 xl:hidden"
            onClick={() => openThread(null)}
            aria-hidden="true"
          />
          <div className="animate-panel-in-right fixed inset-y-0 right-0 z-80 w-96 max-w-[90vw] xl:static xl:z-auto xl:w-96">
            <ThreadPanel conversation={active} />
          </div>
        </>
      )}

      {/* Pane 3b — context. Inline at xl, overlay below it. */}
      {active && contextOpen && !threadRootId && !savedOpen && !settingsOpen && (
        <>
          <div
            className="fixed inset-0 z-70 bg-black/40 xl:hidden"
            onClick={() => setContextOpen(false)}
            aria-hidden="true"
          />
          <div className="animate-panel-in-right fixed inset-y-0 right-0 z-80 w-80 max-w-[85vw] xl:static xl:z-auto xl:w-80">
            <ContextPanel
              conversation={active}
              members={members}
              onClose={() => setContextOpen(false)}
            />
          </div>
        </>
      )}
    </div>
  );
};

export const ChatLayout: React.FC = () => (
  <ChatProvider>
    <ErrorBoundary label="chat">
      <ChatWorkspace />
    </ErrorBoundary>
  </ChatProvider>
);
