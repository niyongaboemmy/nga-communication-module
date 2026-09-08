import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import { EmptyState } from '../../components/ui';
import { ConversationList } from './ConversationList';
import { MessageThread } from './MessageThread';
import { Composer } from './Composer';
import { ContextPanel } from './ContextPanel';
import { useChat } from './ChatProvider';
import { ThreadPanel } from './ThreadPanel';
import { SavedItems } from './SavedItems';
import { NotificationSettings } from './NotificationSettings';
import { SearchPanel } from './SearchPanel';
import { ScheduledPanel } from './ScheduledPanel';
import { CommandPalette, PALETTE_ICONS } from './CommandPalette';
import type { PaletteAction } from './CommandPalette';
import { ShortcutsSheet } from './ShortcutsSheet';
import { BrowseChannels } from './BrowseChannels';
import { ChannelSettings } from './ChannelSettings';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import * as chatApi from './api';
import { getSocket } from '../../lib/socket';
import type { Member } from './types';

/**
 * Chat, three panes (SRS §15.1).
 *
 *   ≥1280px  list │ thread │ side panel, all inline
 *   ≥768px   list │ thread, side panel overlays from the right
 *   <768px   one pane at a time: the list *is* the screen until a conversation
 *            is opened, then the thread replaces it and Back returns
 *
 * The mobile behaviour is done by mounting only the active pane rather than
 * hiding the other with CSS. Two reasons: an off-screen `display:none` pane
 * still gets tab focus and screen-reader attention on some engines, and a phone
 * should not be paying to render a 34-row list behind an open conversation.
 */

/** Everything that can occupy the right-hand column. */
export type Panel =
  | 'none' | 'details' | 'thread' | 'saved' | 'settings' | 'search' | 'scheduled'
  | 'browse' | 'channel';

const SidePanel: React.FC<{
  width: 'wide' | 'narrow';
  onDismiss: () => void;
  children: React.ReactNode;
}> = ({ width, onDismiss, children }) => (
  <>
    {/* The scrim exists below xl, where the panel is an overlay. Inline at xl
        there is nothing to dismiss by clicking past. */}
    <div
      className="fixed inset-0 z-70 bg-black/40 xl:hidden"
      onClick={onDismiss}
      aria-hidden="true"
    />
    <div
      className={`animate-panel-in-right fixed inset-y-0 right-0 z-80 max-w-[90vw] xl:static xl:z-auto ${
        width === 'wide' ? 'w-96 xl:w-96' : 'w-80 xl:w-80'
      }`}
    >
      {children}
    </div>
  </>
);

const ChatWorkspace: React.FC = () => {
  const {
    conversations, conversationsLoading, activeId, setActiveId, active,
    threadRootId, openThread, markReadTo, markEverythingRead,
  } = useChat();

  /*
   * One slot, one occupant.
   *
   * Details, thread, saved, search, scheduled and settings all render into the
   * same right-hand column. Six independent booleans meant every new panel had
   * to be excluded from the render condition of every other one — a condition
   * already got wrong twice by the time there were four of them. A single value
   * cannot get out of step with itself.
   */
  const [panel, setPanel] = useState<Panel>('none');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);

  // A thread is opened from a message's reply button, which lives in the
  // provider — so the slot follows that state rather than owning it.
  useEffect(() => {
    if (threadRootId) setPanel('thread');
    else setPanel((p) => (p === 'thread' ? 'none' : p));
  }, [threadRootId]);

  const closePanel = useCallback(() => {
    if (threadRootId) openThread(null);
    setPanel('none');
  }, [threadRootId, openThread]);

  /*
   * On a wide screen an empty right-hand pane is wasted space, so open the
   * first conversation automatically. On a phone that would rob the user of the
   * list they came for, so it stays on the list until they choose.
   *
   * It fires on the *initial load only*, and the latch is set the moment that
   * load finishes — even when it finished with nothing to open. Latching on
   * "we opened something" instead leaves the effect armed for an empty account,
   * so the first DM anyone sends them rips them out of whatever they were
   * doing, opens itself, and marks itself read. Reading someone's message has
   * to be something the reader did, not something that happened to them.
   */
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || conversationsLoading) return;
    autoOpened.current = true;
    if (activeId || conversations.length === 0) return;
    const first = conversations[0];
    if (first && window.matchMedia('(min-width: 768px)').matches) setActiveId(first.id);
  }, [activeId, conversationsLoading, conversations, setActiveId]);

  /*
   * Members are only loaded when a panel that shows them is open — a channel of
   * 400 is a real payload, and the sidebar never shows it.
   *
   * `membersVersion` is what makes the list refetch after somebody is promoted
   * or removed. Without it the panel kept showing the old role until it was
   * closed and reopened, so the moderator could not tell whether their click
   * had done anything.
   */
  const [membersVersion, setMembersVersion] = useState(0);
  const reloadMembers = useCallback(() => setMembersVersion((v) => v + 1), []);

  useEffect(() => {
    if (!activeId || (panel !== 'details' && panel !== 'channel')) return;
    let cancelled = false;
    chatApi.listMembers(activeId)
      .then((m) => { if (!cancelled) setMembers(m); })
      .catch(() => { if (!cancelled) setMembers([]); });
    return () => { cancelled = true; };
  }, [activeId, panel, membersVersion]);

  // A membership change made by anyone in the room, not just by this client.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    socket.on('conversation:member_changed', reloadMembers);
    return () => { socket.off('conversation:member_changed', reloadMembers); };
  }, [reloadMembers]);

  /* ── Keyboard shortcuts (UX-4) ───────────────────────────────────────── */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';

      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); return; }
      if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); setPanel('search'); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault(); setPanel('saved'); return;
      }

      /*
       * Shift+Escape clears every badge, and works **while typing**.
       *
       * Plain Escape does not: in the composer it belongs to the composer,
       * where it drops a quote-reply. But a two-key chord is deliberate, and
       * gating it behind "not typing" meant it never fired where people
       * actually are — the composer is focused by default.
       */
      if (e.key === 'Escape' && e.shiftKey) {
        e.preventDefault();
        void markEverythingRead();
        return;
      }

      // Escape closes the open panel; with nothing open it marks the
      // conversation read, which is the behaviour people bring with them.
      if (e.key === 'Escape' && !typing) {
        if (panel !== 'none') { closePanel(); return; }
        if (active) markReadTo(active.lastSeq);
      }
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [panel, closePanel, active, markReadTo, markEverythingRead]);

  const paletteActions = useMemo<PaletteAction[]>(() => [
    { id: 'search', label: 'Search messages', hint: 'Ctrl/⌘ F', icon: PALETTE_ICONS.search, run: () => setPanel('search') },
    { id: 'saved', label: 'Saved items', hint: 'Ctrl/⌘ ⇧ S', icon: PALETTE_ICONS.saved, run: () => setPanel('saved') },
    { id: 'scheduled', label: 'Scheduled messages', icon: PALETTE_ICONS.scheduled, run: () => setPanel('scheduled') },
    { id: 'settings', label: 'Notification settings', icon: PALETTE_ICONS.notifications, run: () => setPanel('settings') },
    { id: 'browse', label: 'Browse channels', icon: PALETTE_ICONS.newConversation, run: () => setPanel('browse') },
    { id: 'shortcuts', label: 'Keyboard shortcuts', icon: PALETTE_ICONS.settings, run: () => setShortcutsOpen(true) },
  ], []);

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
            onOpenSaved={() => setPanel('saved')}
            onOpenSettings={() => setPanel('settings')}
            onOpenSearch={() => setPanel('search')}
            onOpenBrowse={() => setPanel('browse')}
          />
        </div>
      </div>

      {/* Pane 2 — thread. */}
      {active ? (
        <MessageThread
          conversation={active}
          onBack={() => setActiveId(null)}
          onToggleContext={() => setPanel((p) => (p === 'details' ? 'none' : 'details'))}
          contextOpen={panel === 'details'}
          onOpenSearch={() => setPanel('search')}
          onOpenChannelSettings={() => setPanel('channel')}
        >
          <Composer
            conversation={active}
            onOpenPanel={(p) => (p === 'shortcuts' ? setShortcutsOpen(true) : setPanel(p))}
          />
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

      {/* Pane 3 — whichever side panel is open. */}
      {panel === 'thread' && active && (
        <SidePanel width="wide" onDismiss={closePanel}>
          <ThreadPanel conversation={active} />
        </SidePanel>
      )}
      {panel === 'details' && active && (
        <SidePanel width="narrow" onDismiss={closePanel}>
          <ContextPanel
            conversation={active}
            members={members}
            onClose={closePanel}
            onOpenSettings={() => setPanel('channel')}
          />
        </SidePanel>
      )}
      {panel === 'saved' && (
        <SidePanel width="wide" onDismiss={closePanel}>
          <SavedItems onClose={closePanel} />
        </SidePanel>
      )}
      {panel === 'settings' && (
        <SidePanel width="wide" onDismiss={closePanel}>
          <NotificationSettings onClose={closePanel} />
        </SidePanel>
      )}
      {panel === 'search' && (
        <SidePanel width="wide" onDismiss={closePanel}>
          <SearchPanel onClose={closePanel} scopedConversationId={activeId} />
        </SidePanel>
      )}
      {panel === 'scheduled' && (
        <SidePanel width="wide" onDismiss={closePanel}>
          <ScheduledPanel onClose={closePanel} />
        </SidePanel>
      )}
      {panel === 'browse' && (
        <SidePanel width="wide" onDismiss={closePanel}>
          <BrowseChannels onClose={closePanel} />
        </SidePanel>
      )}
      {panel === 'channel' && active && (
        <SidePanel width="wide" onDismiss={closePanel}>
          <ChannelSettings
            conversation={active}
            members={members}
            onMembersChanged={reloadMembers}
            onClose={closePanel}
          />
        </SidePanel>
      )}

      {paletteOpen && (
        <CommandPalette onClose={() => setPaletteOpen(false)} actions={paletteActions} />
      )}
      {shortcutsOpen && <ShortcutsSheet onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
};

/*
 * No <ChatProvider> here any more — it is mounted above the router in App.tsx.
 *
 * The dock needs the same store on every page, and two providers would mean
 * two conversation lists, two sets of socket handlers and two unread counts
 * that disagree with each other. Hoisting it also means the list survives
 * navigating away and back, instead of refetching each time.
 */
export const ChatLayout: React.FC = () => (
  <ErrorBoundary label="chat">
    <ChatWorkspace />
  </ErrorBoundary>
);
